/**
 * Merge Helpers - Plain functions for Yjs CRDT operations
 *
 * Provides state encoding and merge operations.
 */

import * as Y from 'yjs';

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

// ============================================================================
// Yjs Serialization System
// ============================================================================
// Yjs uses `instanceof AbstractType` internally in toJSON() which breaks when
// multiple Yjs module instances exist (common with bundlers). We detect Yjs
// types via duck-typing since instanceof checks fail across module boundaries.
//
// Uses data-driven detection (array for precedence) + Map-based dispatch.
// All Yjs types have toJSON() as universal fallback for unknown types.
// ============================================================================

/**
 * Yjs type discriminant - single source of truth.
 * 'text' covers Y.Text and Y.XmlText (both have toDelta()).
 */
type YjsType = 'map' | 'array' | 'text' | 'xmlfragment' | 'primitive';

/**
 * Check if a value is a Yjs AbstractType by checking internal properties.
 * All Yjs types (Y.Map, Y.Array, Y.Text, Y.XmlFragment, etc.) extend AbstractType
 * and have these properties regardless of which module instance created them.
 */
function isYjsAbstractType(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	// AbstractType has: doc (Doc|null), _map (Map), _eH (event handler)
	return '_map' in v && '_eH' in v && 'doc' in v;
}

/**
 * Type detection rules - array for precedence order.
 * Each rule: [type, predicate]. First match wins.
 *
 * IMPORTANT: All Yjs types inherit push() from AbstractType.
 * Use distinctive properties to differentiate:
 * - Y.XmlFragment/Y.XmlElement: have `firstChild` property
 * - Y.Text/Y.XmlText: have `toDelta()` method
 * - Y.Map: has `keys()` method
 * - Y.Array: has `push()` (fallback after more specific checks)
 */
const typeDetectors: readonly [YjsType, (v: Record<string, unknown>) => boolean][] = [
	['map', (v) => typeof v.keys === 'function'],
	['xmlfragment', (v) => 'firstChild' in v], // Before array! XML types have firstChild
	['text', (v) => typeof v.toDelta === 'function'],
	['array', (v) => typeof v.push === 'function'], // Fallback - all AbstractTypes have push
];

/**
 * Detect Yjs type using duck-typing.
 * Uses array for ordered precedence, returns first match.
 */
function detectYjsType(value: unknown): YjsType {
	if (!isYjsAbstractType(value)) return 'primitive';
	const v = value as Record<string, unknown>;
	return typeDetectors.find(([, detect]) => detect(v))?.[0] ?? 'primitive';
}

/**
 * Check if a value is a Y.XmlFragment or Y.XmlElement (duck-typed).
 */
function isYXmlFragment(value: unknown): value is Y.XmlFragment {
	return detectYjsType(value) === 'xmlfragment';
}

/**
 * Check if a value is a Y.Map (duck-typed).
 */
function isYMap(value: unknown): boolean {
	return detectYjsType(value) === 'map';
}

/**
 * Check if XmlFragment child is an element (has nodeName property).
 * Duck-type check since instanceof fails across bundler boundaries.
 */
function isXmlElement(child: unknown): child is Y.XmlElement {
	return (
		detectYjsType(child) === 'xmlfragment' && typeof (child as Record<string, unknown>).nodeName === 'string'
	);
}

/**
 * Check if XmlFragment child is text (has toDelta method).
 * Duck-type check since instanceof fails across bundler boundaries.
 */
function isXmlText(child: unknown): child is Y.XmlText {
	return detectYjsType(child) === 'text';
}

/**
 * Serializer registry - Map-based dispatch.
 * Each serializer handles one Yjs type, calling serialize() recursively.
 * Uses toJSON() as fallback for unknown Yjs types in 'primitive' case.
 */
const serializers = new Map<YjsType, (value: unknown) => unknown>([
	[
		'map',
		(v) => {
			const result: Record<string, unknown> = {};
			(v as Y.Map<unknown>).forEach((val, k) => {
				result[k] = serialize(val);
			});
			return result;
		},
	],
	['array', (v) => (v as Y.Array<unknown>).toArray().map(serialize)],
	['text', (v) => (v as Y.Text).toJSON()],
	['xmlfragment', (v) => fragmentToJSON(v as Y.XmlFragment)],
	[
		'primitive',
		(v) => {
			// toJSON fallback for unknown Yjs types
			if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).toJSON === 'function') {
				return (v as { toJSON(): unknown }).toJSON();
			}
			return v;
		},
	],
]);

/**
 * Serialize any Yjs value to plain JS.
 * Uses type detection + Map dispatch - no if chains.
 */
function serialize(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value !== 'object') return value;

	const type = detectYjsType(value);
	const serializer = serializers.get(type)!;
	return serializer(value);
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
	ymap.forEach((value) => {
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

import type { XmlFragmentJSON, XmlNodeJSON } from '$/shared';

/**
 * Check if a value looks like ProseMirror/BlockNote JSON document.
 * Used internally to auto-detect prose fields during insert/update.
 */
export function isDoc(value: unknown): value is XmlFragmentJSON {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		(value as { type: unknown }).type === 'doc'
	);
}

/**
 * Convert a Y.XmlFragment to ProseMirror-compatible JSON.
 * Uses duck-typing to detect child types (instanceof fails across bundlers).
 */
export function fragmentToJSON(fragment: Y.XmlFragment): XmlFragmentJSON {
	const content: XmlNodeJSON[] = [];

	for (const child of fragment.toArray()) {
		if (isXmlElement(child)) {
			content.push(xmlElementToJSON(child));
		} else if (isXmlText(child)) {
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

/**
 * Convert a Y.XmlElement to ProseMirror-compatible JSON node.
 * Uses duck-typing to detect child types (instanceof fails across bundlers).
 */
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
		if (isXmlElement(child)) {
			content.push(xmlElementToJSON(child));
		} else if (isXmlText(child)) {
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

/**
 * Extract plain text from ProseMirror/BlockNote JSON content.
 * Handles various content structures defensively for search and display.
 */
export function extract(content: unknown): string {
	if (!content || typeof content !== 'object') return '';

	const doc = content as { content?: unknown; type?: string };

	// Handle XmlFragmentJSON format - content must be an array
	if (!doc.content || !Array.isArray(doc.content)) return '';

	return doc.content
		.map((block: { content?: unknown }) => {
			if (!block.content || !Array.isArray(block.content)) return '';
			return block.content.map((node: { text?: string }) => node.text || '').join('');
		})
		.join(' ');
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
	field: string
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

// ============================================================================
// CRDT Serialization - extends base Yjs serialization
// ============================================================================

import type { CrdtFieldInfo, CrdtType } from '$/shared/crdt';

/**
 * Serialize a register Y.Map to its resolved value.
 * Picks the entry with the latest timestamp (last-write-wins).
 */
function serializeRegister(value: unknown): unknown {
	if (detectYjsType(value) !== 'map') return value;

	let latestValue: unknown = undefined;
	let latestTimestamp = 0;

	(value as Y.Map<unknown>).forEach((entry) => {
		const e = entry as { value?: unknown; timestamp?: number } | null;
		if (e && typeof e === 'object' && 'value' in e && 'timestamp' in e) {
			if ((e.timestamp ?? 0) > latestTimestamp) {
				latestTimestamp = e.timestamp ?? 0;
				latestValue = e.value;
			}
		}
	});

	return latestValue;
}

/**
 * Serialize a counter Y.Array to its summed value.
 */
function serializeCounter(value: unknown): number {
	if (detectYjsType(value) !== 'array') return 0;

	let sum = 0;
	for (const entry of (value as Y.Array<unknown>).toArray()) {
		const e = entry as { delta?: number } | null;
		if (e && typeof e === 'object' && 'delta' in e) {
			sum += e.delta ?? 0;
		}
	}
	return sum;
}

/**
 * Serialize a set Y.Map to an array of values.
 */
function serializeSet(value: unknown): unknown[] {
	if (detectYjsType(value) !== 'map') return [];

	const values: unknown[] = [];
	(value as Y.Map<unknown>).forEach((_, key) => {
		try {
			values.push(JSON.parse(key));
		} catch {
			values.push(key);
		}
	});
	return values;
}

/**
 * CRDT serializer registry - Map-based dispatch.
 */
const crdtSerializers = new Map<CrdtType, (value: unknown) => unknown>([
	['prose', (v) => fragmentToJSON(v as Y.XmlFragment)],
	['register', serializeRegister],
	['counter', serializeCounter],
	['set', serializeSet],
]);

/**
 * Serialize a CRDT field value to plain JS.
 */
export function serializeCrdtField(value: unknown, type: CrdtType): unknown {
	const serializer = crdtSerializers.get(type);
	return serializer ? serializer(value) : serialize(value);
}

/**
 * Serialize a Y.Map to plain JS, with optional CRDT field awareness.
 */
export function serializeYMapWithCrdt(
	ymap: Y.Map<unknown>,
	crdtFields?: Map<string, CrdtFieldInfo>
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	ymap.forEach((value, key) => {
		const crdtInfo = crdtFields?.get(key);
		result[key] = crdtInfo ? serializeCrdtField(value, crdtInfo.type) : serialize(value);
	});

	return result;
}

// Export type detection functions for use elsewhere
export { detectYjsType, isYjsAbstractType };
