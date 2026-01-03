import * as Y from "yjs";
import type { PersistenceProvider } from "$/client/persistence/types";
import { fragmentToJSON } from "$/client/merge";

export type DocPersistenceFactory = (document: string, ydoc: Y.Doc) => PersistenceProvider;

export interface DocumentManager {
	readonly collection: string;

	get(id: string): Y.Doc | undefined;
	getOrCreate(id: string): Y.Doc;
	has(id: string): boolean;
	delete(id: string): void;

	getFields(id: string): Y.Map<unknown> | null;
	getFragment(id: string, field: string): Y.XmlFragment | null;

	applyUpdate(id: string, update: Uint8Array, origin?: string): void;
	encodeState(id: string): Uint8Array;
	encodeStateVector(id: string): Uint8Array;
	transactWithDelta(id: string, fn: (fields: Y.Map<unknown>) => void, origin?: string): Uint8Array;

	documents(): string[];
	enablePersistence(factory: DocPersistenceFactory): Promise<void>[];
	destroy(): void;
}

export function createDocumentManager(collection: string): DocumentManager {
	const docs = new Map<string, Y.Doc>();
	const persistence = new Map<string, PersistenceProvider>();
	let persistenceFactory: DocPersistenceFactory | null = null;

	const makeGuid = (id: string): string => `${collection}:${id}`;

	const manager: DocumentManager = {
		collection,

		get(id: string): Y.Doc | undefined {
			return docs.get(id);
		},

		getOrCreate(id: string): Y.Doc {
			let doc = docs.get(id);
			if (!doc) {
				doc = new Y.Doc({ guid: makeGuid(id) });
				docs.set(id, doc);

				if (persistenceFactory && !persistence.has(id)) {
					const provider = persistenceFactory(id, doc);
					persistence.set(id, provider);
				}
			}
			return doc;
		},

		has(id: string): boolean {
			return docs.has(id);
		},

		delete(id: string): void {
			const doc = docs.get(id);
			if (doc) {
				doc.destroy();
				docs.delete(id);
			}

			const provider = persistence.get(id);
			if (provider) {
				provider.destroy();
				persistence.delete(id);
			}
		},

		getFields(id: string): Y.Map<unknown> | null {
			const doc = docs.get(id);
			return doc ? doc.getMap("fields") : null;
		},

		getFragment(id: string, field: string): Y.XmlFragment | null {
			const fields = this.getFields(id);
			if (!fields) return null;

			const value = fields.get(field);
			if (value instanceof Y.XmlFragment) {
				return value;
			}

			return null;
		},

		applyUpdate(id: string, update: Uint8Array, origin?: string): void {
			const doc = this.getOrCreate(id);
			Y.applyUpdateV2(doc, update, origin);
		},

		encodeState(id: string): Uint8Array {
			const doc = docs.get(id);
			return doc ? Y.encodeStateAsUpdateV2(doc) : new Uint8Array();
		},

		encodeStateVector(id: string): Uint8Array {
			const doc = docs.get(id);
			if (!doc) {
				const emptyDoc = new Y.Doc();
				const vector = Y.encodeStateVector(emptyDoc);
				emptyDoc.destroy();
				return vector;
			}
			return Y.encodeStateVector(doc);
		},

		transactWithDelta(
			id: string,
			fn: (fields: Y.Map<unknown>) => void,
			origin?: string,
		): Uint8Array {
			const doc = this.getOrCreate(id);
			const fields = doc.getMap<unknown>("fields");
			const beforeVector = Y.encodeStateVector(doc);

			doc.transact(() => fn(fields), origin);

			return Y.encodeStateAsUpdateV2(doc, beforeVector);
		},

		documents(): string[] {
			return Array.from(docs.keys());
		},

		enablePersistence(factory: DocPersistenceFactory): Promise<void>[] {
			const promises: Promise<void>[] = [];

			for (const [id, doc] of docs.entries()) {
				if (!persistence.has(id)) {
					const provider = factory(id, doc);
					persistence.set(id, provider);
					promises.push(provider.whenSynced);
				}
			}

			persistenceFactory = factory;
			return promises;
		},

		destroy(): void {
			for (const provider of persistence.values()) {
				provider.destroy();
			}
			persistence.clear();

			for (const doc of docs.values()) {
				doc.destroy();
			}
			docs.clear();
		},
	};

	return manager;
}

export function serializeDocument(
	manager: DocumentManager,
	id: string,
): Record<string, unknown> | null {
	const fields = manager.getFields(id);
	if (!fields) return null;

	const result: Record<string, unknown> = { id };

	fields.forEach((value, key) => {
		if (value instanceof Y.XmlFragment) {
			result[key] = fragmentToJSON(value);
		} else if (value instanceof Y.Map) {
			result[key] = value.toJSON();
		} else if (value instanceof Y.Array) {
			result[key] = value.toJSON();
		} else {
			result[key] = value;
		}
	});

	return result;
}

export function isDocumentDeleted(manager: DocumentManager, id: string): boolean {
	const doc = manager.get(id);
	if (!doc) return false;
	const meta = doc.getMap("_meta");
	return meta.get("_deleted") === true;
}

export function extractAllDocuments(manager: DocumentManager): Record<string, unknown>[] {
	const documents: Record<string, unknown>[] = [];

	for (const id of manager.documents()) {
		if (isDocumentDeleted(manager, id)) continue;
		const doc = serializeDocument(manager, id);
		if (doc) {
			documents.push(doc);
		}
	}

	return documents;
}
