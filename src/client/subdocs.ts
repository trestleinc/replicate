import * as Y from "yjs";
import type { PersistenceProvider } from "$/client/persistence/types";
import { fragmentToJSON } from "$/client/merge";

export type SubdocPersistenceFactory = (document: string, subdoc: Y.Doc) => PersistenceProvider;

export interface SubdocManager {
  readonly rootDoc: Y.Doc;
  readonly subdocsMap: Y.Map<Y.Doc>;
  readonly collection: string;

  getOrCreate(document: string): Y.Doc;
  get(document: string): Y.Doc | undefined;
  has(document: string): boolean;
  getFields(document: string): Y.Map<unknown> | null;
  getFragment(document: string, field: string): Y.XmlFragment | null;
  applyUpdate(document: string, update: Uint8Array, origin?: string): void;
  transactWithDelta(
    document: string,
    fn: (fieldsMap: Y.Map<unknown>) => void,
    origin: string,
  ): Uint8Array;
  encodeStateVector(document: string): Uint8Array;
  encodeState(document: string): Uint8Array;
  delete(document: string): void;
  unload(document: string): void;
  documents(): string[];
  enablePersistence(factory: SubdocPersistenceFactory): Promise<void>[];
  destroy(): void;
}

export function createSubdocManager(collection: string): SubdocManager {
  const rootDoc = new Y.Doc({ guid: collection });
  const subdocsMap = rootDoc.getMap<Y.Doc>("documents");
  const loadedSubdocs = new Map<string, Y.Doc>();
  const subdocPersistence = new Map<string, PersistenceProvider>();
  let persistenceFactory: SubdocPersistenceFactory | null = null;

  const makeGuid = (document: string): string => `${collection}:${document}`;

  const getDocumentIdFromGuid = (guid: string): string | null => {
    const prefix = `${collection}:`;
    return guid.startsWith(prefix) ? guid.slice(prefix.length) : null;
  };

  rootDoc.on("subdocs", ({ added, removed, loaded }: {
    added: Set<Y.Doc>;
    removed: Set<Y.Doc>;
    loaded: Set<Y.Doc>;
  }) => {
    for (const subdoc of added) {
      if (persistenceFactory) {
        const document = getDocumentIdFromGuid(subdoc.guid);
        if (document && !subdocPersistence.has(document)) {
          const provider = persistenceFactory(document, subdoc);
          subdocPersistence.set(document, provider);
        }
      }
    }
    for (const subdoc of loaded) {
      loadedSubdocs.set(subdoc.guid, subdoc);
    }
    for (const subdoc of removed) {
      loadedSubdocs.delete(subdoc.guid);
      const document = getDocumentIdFromGuid(subdoc.guid);
      if (document) {
        const provider = subdocPersistence.get(document);
        if (provider) {
          provider.destroy();
          subdocPersistence.delete(document);
        }
      }
    }
  });

  const manager: SubdocManager = {
    rootDoc,
    subdocsMap,
    collection,

    getOrCreate(document: string): Y.Doc {
      const guid = makeGuid(document);
      let subdoc = subdocsMap.get(document);

      if (!subdoc) {
        subdoc = new Y.Doc({ guid, autoLoad: true });
        subdocsMap.set(document, subdoc);
      }

      return subdoc;
    },

    get(document: string): Y.Doc | undefined {
      return subdocsMap.get(document);
    },

    has(document: string): boolean {
      return subdocsMap.has(document);
    },

    getFields(document: string): Y.Map<unknown> | null {
      const subdoc = subdocsMap.get(document);
      if (!subdoc) return null;
      return subdoc.getMap("fields");
    },

    getFragment(document: string, field: string): Y.XmlFragment | null {
      const fields = this.getFields(document);
      if (!fields) return null;

      const fragment = fields.get(field);
      if (fragment instanceof Y.XmlFragment) {
        return fragment;
      }

      return null;
    },

    applyUpdate(document: string, update: Uint8Array, origin?: string): void {
      const subdoc = this.getOrCreate(document);
      Y.applyUpdateV2(subdoc, update, origin);
    },

    transactWithDelta(
      document: string,
      fn: (fieldsMap: Y.Map<unknown>) => void,
      origin: string,
    ): Uint8Array {
      const subdoc = this.getOrCreate(document);
      const fieldsMap = subdoc.getMap<unknown>("fields");
      const beforeVector = Y.encodeStateVector(subdoc);

      subdoc.transact(() => {
        fn(fieldsMap);
      }, origin);

      const delta = Y.encodeStateAsUpdateV2(subdoc, beforeVector);

      return delta;
    },

    encodeStateVector(document: string): Uint8Array {
      const subdoc = subdocsMap.get(document);
      if (!subdoc) {
        const emptyDoc = new Y.Doc();
        const vector = Y.encodeStateVector(emptyDoc);
        emptyDoc.destroy();
        return vector;
      }
      return Y.encodeStateVector(subdoc);
    },

    encodeState(document: string): Uint8Array {
      const subdoc = subdocsMap.get(document);
      if (!subdoc) {
        return new Uint8Array();
      }
      return Y.encodeStateAsUpdateV2(subdoc);
    },

    delete(document: string): void {
      const subdoc = subdocsMap.get(document);
      if (subdoc) {
        subdocsMap.delete(document);
        subdoc.destroy();
        loadedSubdocs.delete(makeGuid(document));
      }
    },

    unload(document: string): void {
      const subdoc = subdocsMap.get(document);
      if (subdoc) {
        subdoc.destroy();
        loadedSubdocs.delete(makeGuid(document));
      }
    },

    documents(): string[] {
      return Array.from(subdocsMap.keys());
    },

    enablePersistence(factory: SubdocPersistenceFactory): Promise<void>[] {
      const promises: Promise<void>[] = [];

      for (const [document, subdoc] of subdocsMap.entries()) {
        if (!subdocPersistence.has(document)) {
          const provider = factory(document, subdoc);
          subdocPersistence.set(document, provider);
          promises.push(provider.whenSynced);
        }
      }

      persistenceFactory = factory;
      return promises;
    },

    destroy(): void {
      for (const provider of subdocPersistence.values()) {
        provider.destroy();
      }
      subdocPersistence.clear();

      for (const subdoc of loadedSubdocs.values()) {
        subdoc.destroy();
      }
      loadedSubdocs.clear();
      rootDoc.destroy();
    },
  };

  return manager;
}

export function serializeSubdocFields(fieldsMap: Y.Map<unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  fieldsMap.forEach((value, key) => {
    if (value instanceof Y.XmlFragment) {
      // Use fragmentToJSON for proper { type: "doc", content: [...] } format
      // Native toJSON() returns "" for empty fragments which breaks schema validation
      result[key] = fragmentToJSON(value);
    }
    else if (value instanceof Y.Map) {
      result[key] = value.toJSON();
    }
    else if (value instanceof Y.Array) {
      result[key] = value.toJSON();
    }
    else {
      result[key] = value;
    }
  });

  return result;
}

export function extractDocumentFromSubdoc(
  subdocManager: SubdocManager,
  document: string,
): Record<string, unknown> | null {
  const fieldsMap = subdocManager.getFields(document);
  if (!fieldsMap) return null;

  const doc = serializeSubdocFields(fieldsMap);
  doc.id = document;

  return doc;
}

export function extractAllDocuments(
  subdocManager: SubdocManager,
): Record<string, unknown>[] {
  const documents: Record<string, unknown>[] = [];

  for (const document of subdocManager.documents()) {
    const doc = extractDocumentFromSubdoc(subdocManager, document);
    if (doc) {
      documents.push(doc);
    }
  }

  return documents;
}
