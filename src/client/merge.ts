/**
 * Merge Helpers - Plain functions for Yjs CRDT operations
 *
 * Provides document creation, state encoding, and merge operations.
 */

import { get as idbGet, set as idbSet } from 'idb-keyval';
import * as Y from 'yjs';
import { getLogger } from '$/client/logger.js';

const logger = getLogger(['replicate', 'merge']);

/**
 * Create a Yjs document with a persistent clientId stored in IndexedDB.
 * The clientId ensures consistent identity across sessions for CRDT merging.
 */
export async function createYjsDocument(collection: string): Promise<Y.Doc> {
  const clientIdKey = `yjsClientId:${collection}`;
  let clientId = await idbGet<number>(clientIdKey);

  if (!clientId) {
    clientId = Math.floor(Math.random() * 2147483647);
    await idbSet(clientIdKey, clientId);
    logger.info('Generated new Yjs clientID', { collection, clientId });
  }

  const ydoc = new Y.Doc({
    guid: collection,
    clientID: clientId,
  } as any);

  logger.info('Created Yjs document', { collection, clientId });
  return ydoc;
}

/**
 * Apply a binary update to a Yjs document.
 * Y.applyUpdateV2 is already atomic, no need for transaction wrapper.
 */
export function applyUpdate(doc: Y.Doc, update: Uint8Array, origin?: string): void {
  Y.applyUpdateV2(doc, update, origin);
}

/**
 * Get a Y.Map from a Yjs document by name.
 */
export function getYMap<T = unknown>(doc: Y.Doc, name: string): Y.Map<T> {
  return doc.getMap(name);
}

/**
 * Execute a function within a Yjs transaction.
 */
export function yjsTransact<A>(doc: Y.Doc, fn: () => A, origin?: string): A {
  return doc.transact(fn, origin);
}

/**
 * Execute a function within a Yjs transaction and capture the delta.
 * Returns both the function result and a delta containing only the changes made.
 */
export function transactWithDelta<A>(
  doc: Y.Doc,
  fn: () => A,
  origin?: string
): { result: A; delta: Uint8Array } {
  const beforeVector = Y.encodeStateVector(doc);
  const result = doc.transact(fn, origin);
  const delta = Y.encodeStateAsUpdateV2(doc, beforeVector);
  return { result, delta };
}

/**
 * Extract all items from a Y.Map as plain objects.
 */
export function extractItems<T>(ymap: Y.Map<unknown>): T[] {
  const items: T[] = [];
  ymap.forEach((value) => {
    if (value instanceof Y.Map) {
      items.push(value.toJSON() as T);
    }
  });
  return items;
}

/**
 * Extract a single item from a Y.Map by key.
 */
export function extractItem<T>(ymap: Y.Map<unknown>, key: string): T | null {
  const value = ymap.get(key);
  return value instanceof Y.Map ? (value.toJSON() as T) : null;
}

import type { FragmentValue, XmlFragmentJSON, XmlNodeJSON } from '$/shared/types.js';

/**
 * Check if a value is a FragmentValue marker.
 */
export function isFragment(value: unknown): value is FragmentValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__xmlFragment' in value &&
    (value as FragmentValue).__xmlFragment === true
  );
}

/**
 * Create a FragmentValue marker for use in insert/update operations.
 */
export function fragment(content?: XmlFragmentJSON): FragmentValue {
  return { __xmlFragment: true, content };
}

/**
 * Convert a Y.XmlFragment to ProseMirror-compatible JSON.
 */
export function fragmentToJSON(fragment: Y.XmlFragment): XmlFragmentJSON {
  const content: XmlNodeJSON[] = [];

  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement) {
      content.push(xmlElementToJSON(child));
    } else if (child instanceof Y.XmlText) {
      const textContent = xmlTextToJSON(child);
      if (textContent.length > 0) {
        content.push({
          type: 'paragraph',
          content: textContent,
        });
      }
    }
  }

  return {
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph' }],
  };
}

function xmlElementToJSON(element: Y.XmlElement): XmlNodeJSON {
  const result: XmlNodeJSON = {
    type: element.nodeName,
  };

  const attrs = element.getAttributes();
  if (Object.keys(attrs).length > 0) {
    result.attrs = attrs;
  }

  const content: XmlNodeJSON[] = [];
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlElement) {
      content.push(xmlElementToJSON(child));
    } else if (child instanceof Y.XmlText) {
      content.push(...xmlTextToJSON(child));
    }
  }

  if (content.length > 0) {
    result.content = content;
  }

  return result;
}

function xmlTextToJSON(text: Y.XmlText): XmlNodeJSON[] {
  const result: XmlNodeJSON[] = [];
  const delta = text.toDelta();

  for (const op of delta) {
    if (typeof op.insert === 'string') {
      const node: XmlNodeJSON = {
        type: 'text',
        text: op.insert,
      };

      if (op.attributes && Object.keys(op.attributes).length > 0) {
        node.marks = Object.entries(op.attributes).map(([type, attrs]) => ({
          type,
          attrs: typeof attrs === 'object' ? (attrs as Record<string, unknown>) : undefined,
        }));
      }

      result.push(node);
    }
  }

  return result;
}

/**
 * Initialize a Y.XmlFragment from ProseMirror-compatible JSON.
 */
export function fragmentFromJSON(fragment: Y.XmlFragment, json: XmlFragmentJSON): void {
  if (!json.content) return;

  for (const node of json.content) {
    appendNodeToFragment(fragment, node);
  }
}

function appendNodeToFragment(parent: Y.XmlFragment | Y.XmlElement, node: XmlNodeJSON): void {
  if (node.type === 'text') {
    const text = new Y.XmlText();
    if (node.text) {
      const attrs: Record<string, unknown> = {};
      if (node.marks) {
        for (const mark of node.marks) {
          attrs[mark.type] = mark.attrs ?? true;
        }
      }
      text.insert(0, node.text, Object.keys(attrs).length > 0 ? attrs : undefined);
    }
    parent.insert(parent.length, [text]);
  } else {
    const element = new Y.XmlElement(node.type);

    if (node.attrs) {
      for (const [key, value] of Object.entries(node.attrs)) {
        element.setAttribute(key, value as string);
      }
    }

    if (node.content) {
      for (const child of node.content) {
        appendNodeToFragment(element, child);
      }
    }

    parent.insert(parent.length, [element]);
  }
}

/**
 * Serialize a Y.Map value, handling Y.XmlFragment specially.
 */
export function serializeYMapValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    return serializeYMap(value);
  }
  if (value instanceof Y.XmlFragment) {
    return fragmentToJSON(value);
  }
  if (value instanceof Y.Array) {
    return value.toArray().map(serializeYMapValue);
  }
  return value;
}

function serializeYMap(ymap: Y.Map<unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  ymap.forEach((value, key) => {
    result[key] = serializeYMapValue(value);
  });
  return result;
}

/**
 * Extract a single item from a Y.Map, returning both serialized data and fragment references.
 * Use this when you need access to live Y.XmlFragment instances for editor binding.
 */
export function extractItemWithFragments<T>(
  ymap: Y.Map<unknown>,
  key: string
): { data: T; fragments: Map<string, Y.XmlFragment> } | null {
  const value = ymap.get(key);
  if (!(value instanceof Y.Map)) {
    return null;
  }

  const data: Record<string, unknown> = {};
  const fragments = new Map<string, Y.XmlFragment>();

  value.forEach((fieldValue, fieldKey) => {
    if (fieldValue instanceof Y.XmlFragment) {
      fragments.set(fieldKey, fieldValue);
      data[fieldKey] = fragmentToJSON(fieldValue);
    } else {
      data[fieldKey] = serializeYMapValue(fieldValue);
    }
  });

  return { data: data as T, fragments };
}

/**
 * Extract all items from a Y.Map, returning both serialized data and fragment references.
 */
export function extractItemsWithFragments<T>(
  ymap: Y.Map<unknown>
): Array<{ data: T; fragments: Map<string, Y.XmlFragment> }> {
  const results: Array<{ data: T; fragments: Map<string, Y.XmlFragment> }> = [];

  ymap.forEach((_, key) => {
    const result = extractItemWithFragments<T>(ymap, key);
    if (result) {
      results.push(result);
    }
  });

  return results;
}

/**
 * Get a Y.XmlFragment from a document's field.
 * Returns null if the document or field doesn't exist, or if the field is not an XmlFragment.
 */
export function getFragmentFromYMap(
  ymap: Y.Map<unknown>,
  documentId: string,
  field: string
): Y.XmlFragment | null {
  const doc = ymap.get(documentId);
  if (!(doc instanceof Y.Map)) {
    return null;
  }

  const fieldValue = doc.get(field);
  if (fieldValue instanceof Y.XmlFragment) {
    return fieldValue;
  }

  return null;
}
