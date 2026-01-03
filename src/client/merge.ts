/**
 * Merge Helpers - Plain functions for Yjs CRDT operations
 *
 * Provides state encoding and merge operations.
 */

import * as Y from "yjs";

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
	origin?: string,
): { result: A; delta: Uint8Array } {
	const beforeVector = Y.encodeStateVector(doc);
	const result = doc.transact(fn, origin);
	const delta = Y.encodeStateAsUpdateV2(doc, beforeVector);
	return { result, delta };
}

// ============================================================================
// Yjs Serialization System
// ============================================================================
// Yjs uses `instanceof AbstractType` internally in toJSON() which breaks when
// multiple Yjs module instances exist (common with bundlers). We detect Yjs
// types by their internal structure (`doc`, `_map`, `_start` properties) which
// is stable across instances, then manually iterate using forEach/toArray.
// ============================================================================

/**
 * Check if a value is a Yjs AbstractType by checking internal properties.
 * All Yjs types (Y.Map, Y.Array, Y.Text, Y.XmlFragment, etc.) extend AbstractType
 * and have these properties regardless of which module instance created them.
 */
function isYjsAbstractType(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	// AbstractType has: doc (Doc|null), _map (Map), _eH (event handler)
	return "_map" in v && "_eH" in v && "doc" in v;
}

/**
 * Check if a value is a Y.Map.
 * Y.Map has keys() method which Y.XmlFragment does not.
 */
function isYMap(value: unknown): boolean {
	if (!isYjsAbstractType(value)) return false;
	const v = value as Record<string, unknown>;
	return typeof v.keys === "function" && typeof v.get === "function";
}

/**
 * Check if a value is a Y.Array (has toArray but not get - distinguishes from Y.Map).
 */
function isYArray(value: unknown): boolean {
	if (!isYjsAbstractType(value)) return false;
	const v = value as Record<string, unknown>;
	return typeof v.toArray === "function" && typeof v.get !== "function";
}

/**
 * Check if a value is a Y.XmlFragment or Y.XmlElement.
 * XmlFragment has toArray() and get(index), but NOT keys() like Y.Map.
 */
function isYXmlFragment(value: unknown): value is Y.XmlFragment {
	if (!isYjsAbstractType(value)) return false;
	const v = value as Record<string, unknown>;
	// XmlFragment has toArray() but NOT keys() - keys() is unique to Y.Map
	return typeof v.toArray === "function" && typeof v.keys !== "function";
}

/**
 * Recursively serialize a Yjs value to plain JavaScript.
 * Handles Y.Map, Y.Array, Y.XmlFragment without using instanceof.
 */
function serialize(value: unknown): unknown {
	// Primitives pass through
	if (value === null || value === undefined) return value;
	if (typeof value !== "object") return value;

	// Check for XmlFragment first (converts to ProseMirror JSON)
	if (isYXmlFragment(value)) {
		return fragmentToJSON(value);
	}

	// Y.Map - iterate with forEach and recursively serialize values
	if (isYMap(value)) {
		const result: Record<string, unknown> = {};
		const ymap = value as Y.Map<unknown>;
		ymap.forEach((v, k) => {
			result[k] = serialize(v);
		});
		return result;
	}

	// Y.Array - convert to array and recursively serialize elements
	if (isYArray(value)) {
		return (value as Y.Array<unknown>).toArray().map(serialize);
	}

	// Regular object/array (not a Yjs type) - return as-is
	return value;
}

/**
 * Serialize a Y.Map to a plain object.
 */
export function serializeYMap(ymap: Y.Map<unknown>): Record<string, unknown> {
	return serialize(ymap) as Record<string, unknown>;
}

/**
 * Extract all items from a Y.Map as plain objects.
 */
export function extractItems<T>(ymap: Y.Map<unknown>): T[] {
	const items: T[] = [];
	ymap.forEach(value => {
		if (isYMap(value)) {
			items.push(serialize(value) as T);
		}
	});
	return items;
}

/**
 * Extract a single item from a Y.Map by key.
 */
export function extractItem<T>(ymap: Y.Map<unknown>, key: string): T | null {
	const value = ymap.get(key);
	if (isYMap(value)) {
		return serialize(value) as T;
	}
	return null;
}

import type { XmlFragmentJSON, XmlNodeJSON } from "$/shared/types";

/**
 * Check if a value looks like ProseMirror/BlockNote JSON document.
 * Used internally to auto-detect prose fields during insert/update.
 */
export function isDoc(value: unknown): value is XmlFragmentJSON {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value as { type: unknown }).type === "doc"
	);
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
					type: "paragraph",
					content: textContent,
				});
			}
		}
	}

	return {
		type: "doc",
		content: content.length > 0 ? content : [{ type: "paragraph" }],
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
		if (typeof op.insert === "string") {
			const node: XmlNodeJSON = {
				type: "text",
				text: op.insert,
			};

			if (op.attributes && Object.keys(op.attributes).length > 0) {
				node.marks = Object.entries(op.attributes).map(([type, attrs]) => ({
					type,
					attrs: typeof attrs === "object" ? (attrs as Record<string, unknown>) : undefined,
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

/**
 * Extract plain text from ProseMirror/BlockNote JSON content.
 * Handles various content structures defensively for search and display.
 */
export function extract(content: unknown): string {
	if (!content || typeof content !== "object") return "";

	const doc = content as { content?: unknown; type?: string };

	// Handle XmlFragmentJSON format - content must be an array
	if (!doc.content || !Array.isArray(doc.content)) return "";

	return doc.content
		.map((block: { content?: unknown }) => {
			if (!block.content || !Array.isArray(block.content)) return "";
			return block.content.map((node: { text?: string }) => node.text || "").join("");
		})
		.join(" ");
}

function appendNodeToFragment(parent: Y.XmlFragment | Y.XmlElement, node: XmlNodeJSON): void {
	if (node.type === "text") {
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
 * Serialize any value, handling Yjs types specially.
 * Uses our custom serialization system that works across module instances.
 */
export function serializeYMapValue(value: unknown): unknown {
	return serialize(value);
}

/**
 * Get a Y.XmlFragment from a document's field.
 * Returns null if the document or field doesn't exist, or if the field is not an XmlFragment.
 */
export function getFragmentFromYMap(
	ymap: Y.Map<unknown>,
	document: string,
	field: string,
): Y.XmlFragment | null {
	const doc = ymap.get(document);
	if (!isYMap(doc)) {
		return null;
	}

	const fieldValue = (doc as Y.Map<unknown>).get(field);
	if (isYXmlFragment(fieldValue)) {
		return fieldValue;
	}

	return null;
}
