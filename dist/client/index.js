import * as Y from "yjs";
import { getFunctionName } from "convex/server";
import { createCollection } from "@tanstack/db";
import { Chunk, Context, Data, Deferred, Duration, Effect, Exit, Fiber, HashMap, Layer, Option, Queue, Ref, Runtime, Schedule, Scope, Stream, SubscriptionRef } from "effect";
import { getLogger } from "@logtape/logtape";
import { Awareness } from "y-protocols/awareness";

//#region src/client/errors.ts
var NetworkError = class extends Data.TaggedError("NetworkError") {};
var IDBError = class extends Data.TaggedError("IDBError") {};
var IDBWriteError = class extends Data.TaggedError("IDBWriteError") {};
var ReconciliationError = class extends Data.TaggedError("ReconciliationError") {};
var ProseError = class extends Data.TaggedError("ProseError") {};
var CollectionNotReadyError = class extends Data.TaggedError("CollectionNotReadyError") {};
/** Error that should not be retried (auth failures, validation errors) */
var NonRetriableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "NonRetriableError";
	}
};

//#endregion
//#region src/client/services/seq.ts
var SeqService = class extends Context.Tag("SeqService")() {};
function createSeqLayer(kv) {
	return Layer.succeed(SeqService, SeqService.of({
		load: (collection$1) => Effect.gen(function* (_) {
			const key = `cursor:${collection$1}`;
			const stored = yield* _(Effect.tryPromise({
				try: () => kv.get(key),
				catch: (cause) => new IDBError({
					operation: "get",
					key,
					cause
				})
			}));
			if (stored !== void 0) {
				yield* _(Effect.logDebug("Loaded seq from storage", {
					collection: collection$1,
					seq: stored
				}));
				return stored;
			}
			yield* _(Effect.logDebug("No stored seq, using default", { collection: collection$1 }));
			return 0;
		}),
		save: (collection$1, seq) => Effect.gen(function* (_) {
			const key = `cursor:${collection$1}`;
			yield* _(Effect.tryPromise({
				try: () => kv.set(key, seq),
				catch: (cause) => new IDBWriteError({
					key,
					value: seq,
					cause
				})
			}));
			yield* _(Effect.logDebug("Seq saved", {
				collection: collection$1,
				seq
			}));
		}),
		clear: (collection$1) => Effect.gen(function* (_) {
			const key = `cursor:${collection$1}`;
			yield* _(Effect.tryPromise({
				try: () => kv.del(key),
				catch: (cause) => new IDBError({
					operation: "delete",
					key,
					cause
				})
			}));
			yield* _(Effect.logDebug("Seq cleared", { collection: collection$1 }));
		})
	}));
}

//#endregion
//#region src/client/services/session.ts
const SESSION_CLIENT_ID_KEY = "replicate:sessionClientId";
let cachedSessionClientId = null;
function generateSessionClientId() {
	if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
	return String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}
async function getClientId(kv) {
	if (cachedSessionClientId) return cachedSessionClientId;
	const stored = await kv.get(SESSION_CLIENT_ID_KEY);
	if (stored) {
		cachedSessionClientId = stored;
		return stored;
	}
	const newId = generateSessionClientId();
	cachedSessionClientId = newId;
	await kv.set(SESSION_CLIENT_ID_KEY, newId);
	return newId;
}

//#endregion
//#region src/client/ops.ts
/**
* Create bound replicate operations for a collection.
* Returns functions that are already tied to the collection's params.
* This is the proper way to handle multiple concurrent collections.
*
* @example
* ```typescript
* const ops = createReplicateOps<Task>(params);
* ops.replace(items);  // Always targets THIS collection's TanStack DB
* ops.upsert([item]);
* ops.delete([item]);
* ```
*/
function createReplicateOps(params) {
	return {
		insert(items) {
			params.begin();
			for (const item of items) params.write({
				type: "insert",
				value: item
			});
			params.commit();
		},
		delete(items) {
			params.begin();
			for (const item of items) params.write({
				type: "delete",
				value: item
			});
			params.commit();
		},
		upsert(items) {
			params.begin();
			for (const item of items) params.write({
				type: "update",
				value: item
			});
			params.commit();
		},
		replace(items) {
			params.begin();
			params.truncate();
			for (const item of items) params.write({
				type: "insert",
				value: item
			});
			params.commit();
		}
	};
}

//#endregion
//#region src/client/merge.ts
/**
* Merge Helpers - Plain functions for Yjs CRDT operations
*
* Provides state encoding and merge operations.
*/
/**
* Check if a value is a Yjs AbstractType by checking internal properties.
* All Yjs types (Y.Map, Y.Array, Y.Text, Y.XmlFragment, etc.) extend AbstractType
* and have these properties regardless of which module instance created them.
*/
function isYjsAbstractType(value) {
	if (value === null || typeof value !== "object") return false;
	const v = value;
	return "_map" in v && "_eH" in v && "doc" in v;
}
/**
* Check if a value is a Y.Map.
* Y.Map has keys() method which Y.XmlFragment does not.
*/
function isYMap(value) {
	if (!isYjsAbstractType(value)) return false;
	const v = value;
	return typeof v.keys === "function" && typeof v.get === "function";
}
/**
* Check if a value is a Y.Array (has toArray but not get - distinguishes from Y.Map).
*/
function isYArray(value) {
	if (!isYjsAbstractType(value)) return false;
	const v = value;
	return typeof v.toArray === "function" && typeof v.get !== "function";
}
/**
* Check if a value is a Y.XmlFragment or Y.XmlElement.
* XmlFragment has toArray() and get(index), but NOT keys() like Y.Map.
*/
function isYXmlFragment(value) {
	if (!isYjsAbstractType(value)) return false;
	const v = value;
	return typeof v.toArray === "function" && typeof v.keys !== "function";
}
/**
* Recursively serialize a Yjs value to plain JavaScript.
* Handles Y.Map, Y.Array, Y.XmlFragment without using instanceof.
*/
function serialize(value) {
	if (value === null || value === void 0) return value;
	if (typeof value !== "object") return value;
	if (isYXmlFragment(value)) return fragmentToJSON(value);
	if (isYMap(value)) {
		const result = {};
		value.forEach((v, k) => {
			result[k] = serialize(v);
		});
		return result;
	}
	if (isYArray(value)) return value.toArray().map(serialize);
	return value;
}
/**
* Check if a value looks like ProseMirror/BlockNote JSON document.
* Used internally to auto-detect prose fields during insert/update.
*/
function isDoc(value) {
	return typeof value === "object" && value !== null && "type" in value && value.type === "doc";
}
/**
* Convert a Y.XmlFragment to ProseMirror-compatible JSON.
*/
function fragmentToJSON(fragment) {
	const content = [];
	for (const child of fragment.toArray()) if (child instanceof Y.XmlElement) content.push(xmlElementToJSON(child));
	else if (child instanceof Y.XmlText) {
		const textContent = xmlTextToJSON(child);
		if (textContent.length > 0) content.push({
			type: "paragraph",
			content: textContent
		});
	}
	return {
		type: "doc",
		content: content.length > 0 ? content : [{ type: "paragraph" }]
	};
}
function xmlElementToJSON(element) {
	const result = { type: element.nodeName };
	const attrs = element.getAttributes();
	if (Object.keys(attrs).length > 0) result.attrs = attrs;
	const content = [];
	for (const child of element.toArray()) if (child instanceof Y.XmlElement) content.push(xmlElementToJSON(child));
	else if (child instanceof Y.XmlText) content.push(...xmlTextToJSON(child));
	if (content.length > 0) result.content = content;
	return result;
}
function xmlTextToJSON(text) {
	const result = [];
	const delta = text.toDelta();
	for (const op of delta) if (typeof op.insert === "string") {
		const node = {
			type: "text",
			text: op.insert
		};
		if (op.attributes && Object.keys(op.attributes).length > 0) node.marks = Object.entries(op.attributes).map(([type, attrs]) => ({
			type,
			attrs: typeof attrs === "object" ? attrs : void 0
		}));
		result.push(node);
	}
	return result;
}
/**
* Initialize a Y.XmlFragment from ProseMirror-compatible JSON.
*/
function fragmentFromJSON(fragment, json) {
	if (!json.content) return;
	for (const node of json.content) appendNodeToFragment(fragment, node);
}
/**
* Extract plain text from ProseMirror/BlockNote JSON content.
* Handles various content structures defensively for search and display.
*/
function extract(content) {
	if (!content || typeof content !== "object") return "";
	const doc = content;
	if (!doc.content || !Array.isArray(doc.content)) return "";
	return doc.content.map((block) => {
		if (!block.content || !Array.isArray(block.content)) return "";
		return block.content.map((node) => node.text || "").join("");
	}).join(" ");
}
function appendNodeToFragment(parent, node) {
	if (node.type === "text") {
		const text = new Y.XmlText();
		if (node.text) {
			const attrs = {};
			if (node.marks) for (const mark of node.marks) attrs[mark.type] = mark.attrs ?? true;
			text.insert(0, node.text, Object.keys(attrs).length > 0 ? attrs : void 0);
		}
		parent.insert(parent.length, [text]);
	} else {
		const element = new Y.XmlElement(node.type);
		if (node.attrs) for (const [key, value] of Object.entries(node.attrs)) element.setAttribute(key, value);
		if (node.content) for (const child of node.content) appendNodeToFragment(element, child);
		parent.insert(parent.length, [element]);
	}
}
/**
* Serialize any value, handling Yjs types specially.
* Uses our custom serialization system that works across module instances.
*/
function serializeYMapValue(value) {
	return serialize(value);
}

//#endregion
//#region src/client/subdocs.ts
function createSubdocManager(collection$1) {
	const rootDoc = new Y.Doc({ guid: collection$1 });
	const subdocsMap = rootDoc.getMap("documents");
	const loadedSubdocs = /* @__PURE__ */ new Map();
	const subdocPersistence = /* @__PURE__ */ new Map();
	let persistenceFactory = null;
	const makeGuid = (document) => `${collection$1}:${document}`;
	const getDocumentIdFromGuid = (guid) => {
		const prefix = `${collection$1}:`;
		return guid.startsWith(prefix) ? guid.slice(prefix.length) : null;
	};
	rootDoc.on("subdocs", ({ added, removed, loaded }) => {
		for (const subdoc of added) if (persistenceFactory) {
			const document = getDocumentIdFromGuid(subdoc.guid);
			if (document && !subdocPersistence.has(document)) {
				const provider = persistenceFactory(document, subdoc);
				subdocPersistence.set(document, provider);
			}
		}
		for (const subdoc of loaded) loadedSubdocs.set(subdoc.guid, subdoc);
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
	return {
		rootDoc,
		subdocsMap,
		collection: collection$1,
		getOrCreate(document) {
			const guid = makeGuid(document);
			let subdoc = subdocsMap.get(document);
			if (!subdoc) {
				subdoc = new Y.Doc({
					guid,
					autoLoad: true
				});
				subdocsMap.set(document, subdoc);
			}
			return subdoc;
		},
		get(document) {
			return subdocsMap.get(document);
		},
		has(document) {
			return subdocsMap.has(document);
		},
		getFields(document) {
			const subdoc = subdocsMap.get(document);
			if (!subdoc) return null;
			return subdoc.getMap("fields");
		},
		getFragment(document, field) {
			const fields = this.getFields(document);
			if (!fields) return null;
			const fragment = fields.get(field);
			if (fragment instanceof Y.XmlFragment) return fragment;
			return null;
		},
		applyUpdate(document, update, origin) {
			const subdoc = this.getOrCreate(document);
			Y.applyUpdateV2(subdoc, update, origin);
		},
		transactWithDelta(document, fn, origin) {
			const subdoc = this.getOrCreate(document);
			const fieldsMap = subdoc.getMap("fields");
			const beforeVector = Y.encodeStateVector(subdoc);
			subdoc.transact(() => {
				fn(fieldsMap);
			}, origin);
			return Y.encodeStateAsUpdateV2(subdoc, beforeVector);
		},
		encodeStateVector(document) {
			const subdoc = subdocsMap.get(document);
			if (!subdoc) {
				const emptyDoc = new Y.Doc();
				const vector = Y.encodeStateVector(emptyDoc);
				emptyDoc.destroy();
				return vector;
			}
			return Y.encodeStateVector(subdoc);
		},
		encodeState(document) {
			const subdoc = subdocsMap.get(document);
			if (!subdoc) return new Uint8Array();
			return Y.encodeStateAsUpdateV2(subdoc);
		},
		delete(document) {
			const subdoc = subdocsMap.get(document);
			if (subdoc) {
				subdocsMap.delete(document);
				subdoc.destroy();
				loadedSubdocs.delete(makeGuid(document));
			}
		},
		unload(document) {
			const subdoc = subdocsMap.get(document);
			if (subdoc) {
				subdoc.destroy();
				loadedSubdocs.delete(makeGuid(document));
			}
		},
		documents() {
			return Array.from(subdocsMap.keys());
		},
		enablePersistence(factory) {
			const promises = [];
			for (const [document, subdoc] of subdocsMap.entries()) if (!subdocPersistence.has(document)) {
				const provider = factory(document, subdoc);
				subdocPersistence.set(document, provider);
				promises.push(provider.whenSynced);
			}
			persistenceFactory = factory;
			return promises;
		},
		destroy() {
			for (const provider of subdocPersistence.values()) provider.destroy();
			subdocPersistence.clear();
			for (const subdoc of loadedSubdocs.values()) subdoc.destroy();
			loadedSubdocs.clear();
			rootDoc.destroy();
		}
	};
}
function serializeSubdocFields(fieldsMap) {
	const result = {};
	fieldsMap.forEach((value, key) => {
		if (value instanceof Y.XmlFragment) result[key] = fragmentToJSON(value);
		else if (value instanceof Y.Map) result[key] = value.toJSON();
		else if (value instanceof Y.Array) result[key] = value.toJSON();
		else result[key] = value;
	});
	return result;
}
function extractDocumentFromSubdoc(subdocManager, document) {
	const fieldsMap = subdocManager.getFields(document);
	if (!fieldsMap) return null;
	const doc = serializeSubdocFields(fieldsMap);
	doc.id = document;
	return doc;
}
function extractAllDocuments(subdocManager) {
	const documents = [];
	for (const document of subdocManager.documents()) {
		const doc = extractDocumentFromSubdoc(subdocManager, document);
		if (doc) documents.push(doc);
	}
	return documents;
}

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/core.js
/** A special constant with type `never` */
const NEVER = Object.freeze({ status: "aborted" });
function $constructor(name, initializer$2, params) {
	function init(inst, def) {
		if (!inst._zod) Object.defineProperty(inst, "_zod", {
			value: {
				def,
				constr: _,
				traits: /* @__PURE__ */ new Set()
			},
			enumerable: false
		});
		if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer$2(inst, def);
		const proto = _.prototype;
		const keys = Object.keys(proto);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		var _a$1;
		const inst = params?.Parent ? new Definition() : this;
		init(inst, def);
		(_a$1 = inst._zod).deferred ?? (_a$1.deferred = []);
		for (const fn of inst._zod.deferred) fn();
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
const globalConfig = {};
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
function cached(getter) {
	return { get value() {
		{
			const value = getter();
			Object.defineProperty(this, "value", { value });
			return value;
		}
		throw new Error("cached value already set");
	} };
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
const EVALUATING = Symbol("evaluating");
function defineLazy(object, key, getter) {
	let value = void 0;
	Object.defineProperty(object, key, {
		get() {
			if (value === EVALUATING) return;
			if (value === void 0) {
				value = EVALUATING;
				value = getter();
			}
			return value;
		},
		set(v) {
			Object.defineProperty(object, key, { value: v });
		},
		configurable: true
	});
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = cached(() => {
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	return o;
}
const propertyKeyTypes = new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
	});
}
const NUMBER_FORMAT_RANGES = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema$1, mask) {
	const currDef = schema$1._zod.def;
	return clone(schema$1, mergeDefs(schema$1._zod.def, {
		get shape() {
			const newShape = {};
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				newShape[key] = currDef.shape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function omit(schema$1, mask) {
	const currDef = schema$1._zod.def;
	return clone(schema$1, mergeDefs(schema$1._zod.def, {
		get shape() {
			const newShape = { ...schema$1._zod.def.shape };
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				delete newShape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function extend(schema$1, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema$1._zod.def.checks;
	if (checks && checks.length > 0) throw new Error("Object schemas containing refinements cannot be extended. Use `.safeExtend()` instead.");
	return clone(schema$1, mergeDefs(schema$1._zod.def, {
		get shape() {
			const _shape = {
				...schema$1._zod.def.shape,
				...shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		checks: []
	}));
}
function safeExtend(schema$1, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema$1, {
		...schema$1._zod.def,
		get shape() {
			const _shape = {
				...schema$1._zod.def.shape,
				...shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		checks: schema$1._zod.def.checks
	});
}
function merge(a, b) {
	return clone(a, mergeDefs(a._zod.def, {
		get shape() {
			const _shape = {
				...a._zod.def.shape,
				...b._zod.def.shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: []
	}));
}
function partial(Class, schema$1, mask) {
	return clone(schema$1, mergeDefs(schema$1._zod.def, {
		get shape() {
			const oldShape = schema$1._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
			}
			else for (const key in oldShape) shape[key] = Class ? new Class({
				type: "optional",
				innerType: oldShape[key]
			}) : oldShape[key];
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function required(Class, schema$1, mask) {
	return clone(schema$1, mergeDefs(schema$1._zod.def, {
		get shape() {
			const oldShape = schema$1._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = new Class({
					type: "nonoptional",
					innerType: oldShape[key]
				});
			}
			else for (const key in oldShape) shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a$1;
		(_a$1 = iss).path ?? (_a$1.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config$1) {
	const full = {
		...iss,
		path: iss.path ?? []
	};
	if (!iss.message) full.message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config$1.customError?.(iss)) ?? unwrapMessage(config$1.localeError?.(iss)) ?? "Invalid input";
	delete full.inst;
	delete full.continue;
	if (!ctx?.reportInput) delete full.input;
	return full;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/errors.js
const initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	Object.defineProperty(inst, "_zod", {
		value: inst._zod,
		enumerable: false
	});
	Object.defineProperty(inst, "issues", {
		value: def,
		enumerable: false
	});
	inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
	Object.defineProperty(inst, "toString", {
		value: () => inst.message,
		enumerable: false
	});
};
const $ZodError = $constructor("$ZodError", initializer$1);
const $ZodRealError = $constructor("$ZodError", initializer$1, { Parent: Error });
function flattenError(error, mapper = (issue$1) => issue$1.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) {
		fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
		fieldErrors[sub.path[0]].push(mapper(sub));
	} else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue$1) => issue$1.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error$1) => {
		for (const issue$1 of error$1.issues) if (issue$1.code === "invalid_union" && issue$1.errors.length) issue$1.errors.map((issues) => processError({ issues }));
		else if (issue$1.code === "invalid_key") processError({ issues: issue$1.issues });
		else if (issue$1.code === "invalid_element") processError({ issues: issue$1.issues });
		else if (issue$1.path.length === 0) fieldErrors._errors.push(mapper(issue$1));
		else {
			let curr = fieldErrors;
			let i = 0;
			while (i < issue$1.path.length) {
				const el = issue$1.path[i];
				if (!(i === issue$1.path.length - 1)) curr[el] = curr[el] || { _errors: [] };
				else {
					curr[el] = curr[el] || { _errors: [] };
					curr[el]._errors.push(mapper(issue$1));
				}
				curr = curr[el];
				i++;
			}
		}
	};
	processError(error);
	return fieldErrors;
}

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/parse.js
const _parse = (_Err) => (schema$1, value, _ctx, _params) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
	const result = schema$1._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	if (result.issues.length) {
		const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, _params?.callee);
		throw e;
	}
	return result.value;
};
const parse$1 = /* @__PURE__ */ _parse($ZodRealError);
const _parseAsync = (_Err) => async (schema$1, value, _ctx, params) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
	let result = schema$1._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	if (result.issues.length) {
		const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, params?.callee);
		throw e;
	}
	return result.value;
};
const parseAsync$1 = /* @__PURE__ */ _parseAsync($ZodRealError);
const _safeParse = (_Err) => (schema$1, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema$1._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? {
		success: false,
		error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParse$1 = /* @__PURE__ */ _safeParse($ZodRealError);
const _safeParseAsync = (_Err) => async (schema$1, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
	let result = schema$1._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? {
		success: false,
		error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParseAsync$1 = /* @__PURE__ */ _safeParseAsync($ZodRealError);
const _encode = (_Err) => (schema$1, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _parse(_Err)(schema$1, value, ctx);
};
const encode$1 = /* @__PURE__ */ _encode($ZodRealError);
const _decode = (_Err) => (schema$1, value, _ctx) => {
	return _parse(_Err)(schema$1, value, _ctx);
};
const decode$1 = /* @__PURE__ */ _decode($ZodRealError);
const _encodeAsync = (_Err) => async (schema$1, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _parseAsync(_Err)(schema$1, value, ctx);
};
const encodeAsync$1 = /* @__PURE__ */ _encodeAsync($ZodRealError);
const _decodeAsync = (_Err) => async (schema$1, value, _ctx) => {
	return _parseAsync(_Err)(schema$1, value, _ctx);
};
const decodeAsync$1 = /* @__PURE__ */ _decodeAsync($ZodRealError);
const _safeEncode = (_Err) => (schema$1, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _safeParse(_Err)(schema$1, value, ctx);
};
const safeEncode$1 = /* @__PURE__ */ _safeEncode($ZodRealError);
const _safeDecode = (_Err) => (schema$1, value, _ctx) => {
	return _safeParse(_Err)(schema$1, value, _ctx);
};
const safeDecode$1 = /* @__PURE__ */ _safeDecode($ZodRealError);
const _safeEncodeAsync = (_Err) => async (schema$1, value, _ctx) => {
	const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
	return _safeParseAsync(_Err)(schema$1, value, ctx);
};
const safeEncodeAsync$1 = /* @__PURE__ */ _safeEncodeAsync($ZodRealError);
const _safeDecodeAsync = (_Err) => async (schema$1, value, _ctx) => {
	return _safeParseAsync(_Err)(schema$1, value, _ctx);
};
const safeDecodeAsync$1 = /* @__PURE__ */ _safeDecodeAsync($ZodRealError);

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/checks.js
const $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
	var _a$1;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a$1 = inst._zod).onattach ?? (_a$1.onattach = []);
});
const $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a$1;
	$ZodCheck.init(inst, def);
	(_a$1 = inst._zod.def).when ?? (_a$1.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst$1) => {
		const curr = inst$1._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		if (def.maximum < curr) inst$1._zod.bag.maximum = def.maximum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a$1;
	$ZodCheck.init(inst, def);
	(_a$1 = inst._zod.def).when ?? (_a$1.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst$1) => {
		const curr = inst$1._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		if (def.minimum > curr) inst$1._zod.bag.minimum = def.minimum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a$1;
	$ZodCheck.init(inst, def);
	(_a$1 = inst._zod.def).when ?? (_a$1.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst$1) => {
		const bag = inst$1._zod.bag;
		bag.minimum = def.length;
		bag.maximum = def.length;
		bag.length = def.length;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const length = input.length;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = []) {
		this.content = [];
		this.indent = 0;
		if (this) this.args = args;
	}
	indented(fn) {
		this.indent += 1;
		fn(this);
		this.indent -= 1;
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const args = this?.args;
		const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
		return new F(...args, lines.join("\n"));
	}
};

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/versions.js
const version = {
	major: 4,
	minor: 2,
	patch: 1
};

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/schemas.js
const $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
	var _a$1;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const checks = [...inst._zod.def.checks ?? []];
	if (inst._zod.traits.has("$ZodCheck")) checks.unshift(inst);
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a$1 = inst._zod).deferred ?? (_a$1.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks$1, ctx) => {
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks$1) {
				if (ch._zod.def.when) {
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult$1) => inst._zod.parse(checkResult$1, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary$1) => {
					return handleCanaryResult(canary$1, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result$1) => runChecks(result$1, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
	inst["~standard"] = {
		validate: (value) => {
			try {
				const r = safeParse$1(inst, value);
				return r.success ? { value: r.data } : { issues: r.error?.issues };
			} catch (_) {
				return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
			}
		},
		vendor: "zod",
		version: 1
	};
});
const $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
const $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = Array(input.length);
		const proms = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result$1) => handleArrayResult(result$1, payload, i)));
			else handleArrayResult(result, payload, i);
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
function handlePropertyResult(result, final, key, input) {
	if (result.issues.length) final.issues.push(...prefixIssues(key, result.issues));
	if (result.value === void 0) {
		if (key in input) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	for (const k of keys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		keys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	for (const key in input) {
		if (keySet.has(key)) continue;
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r$1) => handlePropertyResult(r$1, payload, key, input)));
		else handlePropertyResult(r, payload, key, input);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
const $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
		const sh = def.shape;
		Object.defineProperty(def, "shape", { get: () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			return newSh;
		} });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazy(inst._zod, "propValues", () => {
		const shape = def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
			}
		}
		return propValues;
	});
	const isObject$1 = isObject;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = {};
		const proms = [];
		const shape = value.shape;
		for (const key of value.keys) {
			const r = shape[key]._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r$1) => handlePropertyResult(r$1, payload, key, input)));
			else handlePropertyResult(r, payload, key, input);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
	};
});
const $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const generateFastpass = (shape) => {
		const doc = new Doc([
			"shape",
			"payload",
			"ctx"
		]);
		const normalized = _normalized.value;
		const parseStr = (key) => {
			const k = esc(key);
			return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		};
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.keys) ids[key] = `key_${counter++}`;
		doc.write(`const newResult = {};`);
		for (const key of normalized.keys) {
			const id = ids[key];
			const k = esc(key);
			doc.write(`const ${id} = ${parseStr(key)};`);
			doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		const fn = doc.compile();
		return (payload, ctx) => fn(shape, payload, ctx);
	};
	let fastpass;
	const isObject$1 = isObject;
	const jit = !globalConfig.jitless;
	const allowsEval$1 = allowsEval;
	const fastEnabled = jit && allowsEval$1.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
const $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "values", () => {
		if (def.options.every((o) => o._zod.values)) return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazy(inst._zod, "pattern", () => {
		if (def.options.every((o) => o._zod.pattern)) {
			const patterns = def.options.map((o) => o._zod.pattern);
			return /* @__PURE__ */ new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const single = def.options.length === 1;
	const first = def.options[0]._zod.run;
	inst._zod.parse = (payload, ctx) => {
		if (single) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results$1) => {
			return handleUnionResults(results$1, payload, inst, ctx);
		});
	};
});
const $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left$1, right$1]) => {
			return handleIntersectionResults(payload, left$1, right$1);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	if (left.issues.length) result.issues.push(...left.issues);
	if (right.issues.length) result.issues.push(...right.issues);
	if (aborted(result)) return result;
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	result.value = merged.data;
	return result;
}
const $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	inst._zod.pattern = /* @__PURE__ */ new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(result, input) {
	if (result.issues.length && input === void 0) return {
		issues: [],
		value: void 0
	};
	return result;
}
const $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.optout = "optional";
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? new Set([...def.innerType._zod.values, void 0]) : void 0;
	});
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? /* @__PURE__ */ new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (def.innerType._zod.optin === "optional") {
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, payload.value));
			return handleOptionalResult(result, payload.value);
		}
		if (payload.value === void 0) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? /* @__PURE__ */ new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? new Set([...def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result$1) => handleDefaultResult(result$1, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
const $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => {
		const v = def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result$1) => handleNonOptionalResult(result$1, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
const $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result$1) => {
			payload.value = result$1.value;
			if (result$1.issues.length) {
				payload.value = def.catchValue({
					...payload,
					error: { issues: result$1.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
					input: payload.value
				});
				payload.issues = [];
			}
			return payload;
		});
		payload.value = result.value;
		if (result.issues.length) {
			payload.value = def.catchValue({
				...payload,
				error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
				input: payload.value
			});
			payload.issues = [];
		}
		return payload;
	};
});
const $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => def.in._zod.values);
	defineLazy(inst._zod, "optin", () => def.in._zod.optin);
	defineLazy(inst._zod, "optout", () => def.out._zod.optout);
	defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right$1) => handlePipeResult(right$1, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left$1) => handlePipeResult(left$1, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.length) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
const $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
	defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	payload.value = Object.freeze(payload.value);
	return payload;
}
const $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r$1) => handleRefineResult(r$1, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema$1, ..._meta) {
		const meta$2 = _meta[0];
		this._map.set(schema$1, meta$2);
		if (meta$2 && typeof meta$2 === "object" && "id" in meta$2) {
			if (this._idmap.has(meta$2.id)) throw new Error(`ID ${meta$2.id} already exists in the registry`);
			this._idmap.set(meta$2.id, schema$1);
		}
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema$1) {
		const meta$2 = this._map.get(schema$1);
		if (meta$2 && typeof meta$2 === "object" && "id" in meta$2) this._idmap.delete(meta$2.id);
		this._map.delete(schema$1);
		return this;
	}
	get(schema$1) {
		const p = schema$1._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema$1)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema$1);
	}
	has(schema$1) {
		return this._map.has(schema$1);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
const globalRegistry = globalThis.__zod_globalRegistry;

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/api.js
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
function _custom(Class, fn, _params) {
	const norm = normalizeParams(_params);
	norm.abort ?? (norm.abort = true);
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...norm
	});
}
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
function _superRefine(fn) {
	const ch = _check((payload) => {
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, ch._zod.def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	});
	return ch;
}
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
function describe$1(description) {
	const ch = new $ZodCheck({ check: "describe" });
	ch._zod.onattach = [(inst) => {
		const existing = globalRegistry.get(inst) ?? {};
		globalRegistry.add(inst, {
			...existing,
			description
		});
	}];
	ch._zod.check = () => {};
	return ch;
}
function meta$1(metadata) {
	const ch = new $ZodCheck({ check: "meta" });
	ch._zod.onattach = [(inst) => {
		const existing = globalRegistry.get(inst) ?? {};
		globalRegistry.add(inst, {
			...existing,
			...metadata
		});
	}];
	ch._zod.check = () => {};
	return ch;
}

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		external: params?.external ?? void 0
	};
}
function process(schema$1, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a$1;
	const def = schema$1._zod.def;
	const seen = ctx.seen.get(schema$1);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema$1)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema$1, result);
	const overrideSchema = schema$1._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema$1],
			path: _params.path
		};
		const parent = schema$1._zod.parent;
		if (parent) {
			result.ref = parent;
			process(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		} else if (schema$1._zod.processJSONSchema) schema$1._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema$1, ctx, _json, params);
		}
	}
	const meta$2 = ctx.metadataRegistry.get(schema$1);
	if (meta$2) Object.assign(result.schema, meta$2);
	if (ctx.io === "input" && isTransforming(schema$1)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && result.schema._prefault) (_a$1 = result.schema).default ?? (_a$1.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema$1).schema;
}
function extractDefs(ctx, schema$1) {
	const root = ctx.seen.get(schema$1);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id$1) => id$1);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}`
			};
		}
		if (entry[1] === root) return { ref: "#" };
		const defUriPrefix = `#/${defsSegment}/`;
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + defId
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema$2 = seen.schema;
		for (const key in schema$2) delete schema$2[key];
		schema$2.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema$1 === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema$1 !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") {
				extractToDef(entry);
				continue;
			}
		}
	}
}
function finalize(ctx, schema$1) {
	const root = ctx.seen.get(schema$1);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		const schema$2 = seen.def ?? seen.schema;
		const _cached = { ...schema$2 };
		if (seen.ref === null) return;
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSchema = ctx.seen.get(ref).schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema$2.allOf = schema$2.allOf ?? [];
				schema$2.allOf.push(refSchema);
			} else {
				Object.assign(schema$2, refSchema);
				Object.assign(schema$2, _cached);
			}
		}
		if (!seen.isParent) ctx.override({
			zodSchema,
			jsonSchema: schema$2,
			path: seen.path ?? []
		});
	};
	for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema$1)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	Object.assign(result, root.def ?? root.schema);
	const defs = ctx.external?.defs ?? {};
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) defs[seen.defId] = seen.def;
	}
	if (ctx.external) {} else if (Object.keys(defs).length > 0) if (ctx.target === "draft-2020-12") result.$defs = defs;
	else result.definitions = defs;
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema$1["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema$1, "input"),
					output: createStandardJSONSchemaMethod(schema$1, "output")
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
const createToJSONSchemaMethod = (schema$1, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	process(schema$1, ctx);
	extractDefs(ctx, schema$1);
	return finalize(ctx, schema$1);
};
const createStandardJSONSchemaMethod = (schema$1, io) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors: {}
	});
	process(schema$1, ctx);
	extractDefs(ctx, schema$1);
	return finalize(ctx, schema$1);
};

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/core/json-schema-processors.js
const neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
const unknownProcessor = (_schema, _ctx, _json, _params) => {};
const enumProcessor = (schema$1, _ctx, json, _params) => {
	const def = schema$1._zod.def;
	const values = getEnumValues(def.entries);
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
const customProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
};
const transformProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
};
const arrayProcessor = (schema$1, ctx, _json, params) => {
	const json = _json;
	const def = schema$1._zod.def;
	const { minimum, maximum } = schema$1._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = process(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
const objectProcessor = (schema$1, ctx, _json, params) => {
	const json = _json;
	const def = schema$1._zod.def;
	json.type = "object";
	json.properties = {};
	const shape = def.shape;
	for (const key in shape) json.properties[key] = process(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	});
	const allKeys = new Set(Object.keys(shape));
	const requiredKeys = new Set([...allKeys].filter((key) => {
		const v = def.shape[key]._zod;
		if (ctx.io === "input") return v.optin === void 0;
		else return v.optout === void 0;
	}));
	if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = process(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
const unionProcessor = (schema$1, ctx, json, params) => {
	const def = schema$1._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => process(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
const intersectionProcessor = (schema$1, ctx, json, params) => {
	const def = schema$1._zod.def;
	const a = process(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = process(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	json.allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
};
const nullableProcessor = (schema$1, ctx, json, params) => {
	const def = schema$1._zod.def;
	const inner = process(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema$1);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
const nonoptionalProcessor = (schema$1, ctx, _json, params) => {
	const def = schema$1._zod.def;
	process(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema$1);
	seen.ref = def.innerType;
};
const defaultProcessor = (schema$1, ctx, json, params) => {
	const def = schema$1._zod.def;
	process(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema$1);
	seen.ref = def.innerType;
	json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
const prefaultProcessor = (schema$1, ctx, json, params) => {
	const def = schema$1._zod.def;
	process(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema$1);
	seen.ref = def.innerType;
	if (ctx.io === "input") json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
const catchProcessor = (schema$1, ctx, json, params) => {
	const def = schema$1._zod.def;
	process(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema$1);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		throw new Error("Dynamic catch values are not supported in JSON Schema");
	}
	json.default = catchValue;
};
const pipeProcessor = (schema$1, ctx, _json, params) => {
	const def = schema$1._zod.def;
	const innerType = ctx.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
	process(innerType, ctx, params);
	const seen = ctx.seen.get(schema$1);
	seen.ref = innerType;
};
const readonlyProcessor = (schema$1, ctx, json, params) => {
	const def = schema$1._zod.def;
	process(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema$1);
	seen.ref = def.innerType;
	json.readOnly = true;
};
const optionalProcessor = (schema$1, ctx, _json, params) => {
	const def = schema$1._zod.def;
	process(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema$1);
	seen.ref = def.innerType;
};

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/classic/errors.js
const initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	Object.defineProperties(inst, {
		format: { value: (mapper) => formatError(inst, mapper) },
		flatten: { value: (mapper) => flattenError(inst, mapper) },
		addIssue: { value: (issue$1) => {
			inst.issues.push(issue$1);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		addIssues: { value: (issues$1) => {
			inst.issues.push(...issues$1);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		isEmpty: { get() {
			return inst.issues.length === 0;
		} }
	});
};
const ZodError = $constructor("ZodError", initializer);
const ZodRealError = $constructor("ZodError", initializer, { Parent: Error });

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/classic/parse.js
const parse = /* @__PURE__ */ _parse(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

//#endregion
//#region node_modules/.pnpm/zod@4.2.1/node_modules/zod/v4/classic/schemas.js
const ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
	$ZodType.init(inst, def);
	Object.assign(inst["~standard"], { jsonSchema: {
		input: createStandardJSONSchemaMethod(inst, "input"),
		output: createStandardJSONSchemaMethod(inst, "output")
	} });
	inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
	inst.def = def;
	inst.type = def.type;
	Object.defineProperty(inst, "_def", { value: def });
	inst.check = (...checks) => {
		return inst.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...checks.map((ch) => typeof ch === "function" ? { _zod: {
			check: ch,
			def: { check: "custom" },
			onattach: []
		} } : ch)] }));
	};
	inst.clone = (def$1, params) => clone(inst, def$1, params);
	inst.brand = () => inst;
	inst.register = ((reg, meta$2) => {
		reg.add(inst, meta$2);
		return inst;
	});
	inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
	inst.safeParse = (data, params) => safeParse(inst, data, params);
	inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
	inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
	inst.spa = inst.safeParseAsync;
	inst.encode = (data, params) => encode(inst, data, params);
	inst.decode = (data, params) => decode(inst, data, params);
	inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
	inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
	inst.safeEncode = (data, params) => safeEncode(inst, data, params);
	inst.safeDecode = (data, params) => safeDecode(inst, data, params);
	inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
	inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
	inst.refine = (check, params) => inst.check(refine(check, params));
	inst.superRefine = (refinement) => inst.check(superRefine(refinement));
	inst.overwrite = (fn) => inst.check(_overwrite(fn));
	inst.optional = () => optional(inst);
	inst.nullable = () => nullable(inst);
	inst.nullish = () => optional(nullable(inst));
	inst.nonoptional = (params) => nonoptional(inst, params);
	inst.array = () => array(inst);
	inst.or = (arg) => union([inst, arg]);
	inst.and = (arg) => intersection(inst, arg);
	inst.transform = (tx) => pipe(inst, transform(tx));
	inst.default = (def$1) => _default(inst, def$1);
	inst.prefault = (def$1) => prefault(inst, def$1);
	inst.catch = (params) => _catch(inst, params);
	inst.pipe = (target) => pipe(inst, target);
	inst.readonly = () => readonly(inst);
	inst.describe = (description) => {
		const cl = inst.clone();
		globalRegistry.add(cl, { description });
		return cl;
	};
	Object.defineProperty(inst, "description", {
		get() {
			return globalRegistry.get(inst)?.description;
		},
		configurable: true
	});
	inst.meta = (...args) => {
		if (args.length === 0) return globalRegistry.get(inst);
		const cl = inst.clone();
		globalRegistry.add(cl, args[0]);
		return cl;
	};
	inst.isOptional = () => inst.safeParse(void 0).success;
	inst.isNullable = () => inst.safeParse(null).success;
	return inst;
});
const ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
	return _unknown(ZodUnknown);
}
const ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return _never(ZodNever, params);
}
const ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
	inst.min = (minLength, params) => inst.check(_minLength(minLength, params));
	inst.nonempty = (params) => inst.check(_minLength(1, params));
	inst.max = (maxLength, params) => inst.check(_maxLength(maxLength, params));
	inst.length = (len, params) => inst.check(_length(len, params));
	inst.unwrap = () => inst.element;
});
function array(element, params) {
	return _array(ZodArray, element, params);
}
const ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	defineLazy(inst, "shape", () => {
		return def.shape;
	});
	inst.keyof = () => _enum(Object.keys(inst._zod.def.shape));
	inst.catchall = (catchall) => inst.clone({
		...inst._zod.def,
		catchall
	});
	inst.passthrough = () => inst.clone({
		...inst._zod.def,
		catchall: unknown()
	});
	inst.loose = () => inst.clone({
		...inst._zod.def,
		catchall: unknown()
	});
	inst.strict = () => inst.clone({
		...inst._zod.def,
		catchall: never()
	});
	inst.strip = () => inst.clone({
		...inst._zod.def,
		catchall: void 0
	});
	inst.extend = (incoming) => {
		return extend(inst, incoming);
	};
	inst.safeExtend = (incoming) => {
		return safeExtend(inst, incoming);
	};
	inst.merge = (other) => merge(inst, other);
	inst.pick = (mask) => pick(inst, mask);
	inst.omit = (mask) => omit(inst, mask);
	inst.partial = (...args) => partial(ZodOptional, inst, args[0]);
	inst.required = (...args) => required(ZodNonOptional, inst, args[0]);
});
const ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
const ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
const ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = Object.values(def.entries);
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	return new ZodEnum({
		type: "enum",
		entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
		...normalizeParams(params)
	});
}
const ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output$1) => {
			payload.value = output$1;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
const ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
const ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
const ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
const ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
	});
}
const ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
const ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
const ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function custom(fn, _params) {
	return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
	return _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
	return _superRefine(fn);
}
const describe = describe$1;
const meta = meta$1;

//#endregion
//#region src/client/logger.ts
function getLogger$1(category) {
	return getLogger(["replicate", ...category]);
}

//#endregion
//#region src/client/services/context.ts
const contexts = /* @__PURE__ */ new Map();
function getContext(collection$1) {
	const ctx = contexts.get(collection$1);
	if (!ctx) throw new Error(`Collection ${collection$1} not initialized`);
	return ctx;
}
function hasContext(collection$1) {
	return contexts.has(collection$1);
}
function initContext(config$1) {
	let resolver;
	const synced = new Promise((r) => {
		resolver = r;
	});
	let actorResolver;
	const actorReady = new Promise((r) => {
		actorResolver = r;
	});
	const ctx = {
		...config$1,
		fragmentObservers: /* @__PURE__ */ new Map(),
		synced,
		resolve: resolver,
		actorReady,
		resolveActorReady: actorResolver
	};
	contexts.set(config$1.collection, ctx);
	return ctx;
}
function deleteContext(collection$1) {
	contexts.delete(collection$1);
}
function updateContext(collection$1, updates) {
	const ctx = getContext(collection$1);
	Object.assign(ctx, updates);
	return ctx;
}

//#endregion
//#region src/client/services/errors.ts
var SyncError = class extends Data.TaggedError("SyncError") {
	get message() {
		return `Sync failed for document ${this.documentId}: ${String(this.cause)}`;
	}
};

//#endregion
//#region src/client/services/actor.ts
const BATCH_ACCUMULATION_MS = 2;
const createDocumentActor = (documentId, ydoc, syncFn, config$1) => Effect.gen(function* () {
	const mailbox = yield* Queue.unbounded();
	const pendingRef = yield* SubscriptionRef.make(false);
	const stateRef = yield* Ref.make({
		vector: Y.encodeStateVector(ydoc),
		lastError: null,
		retryCount: 0
	});
	const debounceFiberRef = yield* Ref.make(null);
	const retrySchedule = Schedule.exponential(Duration.millis(100)).pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(config$1.maxRetries)));
	const performSync = Effect.gen(function* () {
		const state = yield* Ref.get(stateRef);
		if (Y.encodeStateAsUpdateV2(ydoc, state.vector).length <= 2) return;
		yield* Effect.tryPromise({
			try: () => syncFn(),
			catch: (e) => new SyncError({
				documentId,
				cause: e,
				retriable: true
			})
		});
		const newVector = Y.encodeStateVector(ydoc);
		yield* Ref.update(stateRef, (s) => ({
			...s,
			vector: newVector,
			retryCount: 0,
			lastError: null
		}));
	});
	const scheduleSyncAfterDebounce = Effect.gen(function* () {
		const existingFiber = yield* Ref.get(debounceFiberRef);
		if (existingFiber) yield* Fiber.interrupt(existingFiber);
		yield* SubscriptionRef.set(pendingRef, true);
		const syncFiber = yield* Effect.fork(Effect.gen(function* () {
			yield* Effect.sleep(Duration.millis(config$1.debounceMs));
			yield* performSync.pipe(Effect.retry(retrySchedule), Effect.catchTag("SyncError", (e) => Effect.gen(function* () {
				yield* Ref.update(stateRef, (s) => ({
					...s,
					lastError: e,
					retryCount: config$1.maxRetries
				}));
				yield* Effect.logError(`Sync failed for ${documentId}`, e);
			})), Effect.ensuring(SubscriptionRef.set(pendingRef, false)));
		}));
		yield* Ref.set(debounceFiberRef, syncFiber);
	});
	const handleBatch = (batch) => Effect.gen(function* () {
		let hasLocalChanges = false;
		let shutdownDeferred = null;
		for (const msg of batch) switch (msg._tag) {
			case "LocalChange":
				hasLocalChanges = true;
				break;
			case "ExternalUpdate": {
				const newVector = Y.encodeStateVector(ydoc);
				yield* Ref.update(stateRef, (s) => ({
					...s,
					vector: newVector
				}));
				break;
			}
			case "Shutdown":
				shutdownDeferred = msg.done;
				break;
		}
		if (shutdownDeferred) {
			const existingFiber = yield* Ref.get(debounceFiberRef);
			if (existingFiber) yield* Fiber.interrupt(existingFiber);
			yield* Deferred.succeed(shutdownDeferred, void 0);
			return false;
		}
		if (hasLocalChanges) yield* scheduleSyncAfterDebounce;
		return true;
	});
	const actorLoop = Effect.gen(function* () {
		let running = true;
		while (running) {
			const first = yield* Queue.take(mailbox);
			yield* Effect.sleep(Duration.millis(BATCH_ACCUMULATION_MS));
			const rest = yield* Queue.takeAll(mailbox);
			running = yield* handleBatch(Chunk.prepend(rest, first));
		}
	});
	yield* Effect.forkScoped(actorLoop);
	return {
		documentId,
		send: (msg) => Queue.offer(mailbox, msg).pipe(Effect.asVoid),
		pending: pendingRef,
		shutdown: Effect.gen(function* () {
			const done = yield* Deferred.make();
			yield* Queue.offer(mailbox, {
				_tag: "Shutdown",
				done
			});
			yield* Deferred.await(done);
		})
	};
});

//#endregion
//#region src/client/services/manager.ts
var ActorManagerService = class extends Context.Tag("ActorManager")() {};
const DEFAULT_DEBOUNCE_MS$1 = 200;
const DEFAULT_MAX_RETRIES = 3;
const createActorManager = (config$1 = {}) => Effect.gen(function* () {
	const actorConfig = {
		debounceMs: config$1.debounceMs ?? DEFAULT_DEBOUNCE_MS$1,
		maxRetries: config$1.maxRetries ?? DEFAULT_MAX_RETRIES
	};
	const actorsRef = yield* Ref.make(HashMap.empty());
	const manager = {
		register: (documentId, ydoc, syncFn, debounceMs) => Effect.gen(function* () {
			const actors = yield* Ref.get(actorsRef);
			const existing = HashMap.get(actors, documentId);
			if (Option.isSome(existing)) return existing.value.actor;
			const scope = yield* Scope.make();
			const actor = yield* createDocumentActor(documentId, ydoc, syncFn, debounceMs !== void 0 ? {
				...actorConfig,
				debounceMs
			} : actorConfig).pipe(Effect.provideService(Scope.Scope, scope));
			yield* Ref.update(actorsRef, HashMap.set(documentId, {
				actor,
				scope
			}));
			yield* Effect.log(`Actor registered for document ${documentId}`);
			return actor;
		}),
		get: (documentId) => Ref.get(actorsRef).pipe(Effect.map((actors) => {
			const opt = HashMap.get(actors, documentId);
			return Option.isSome(opt) ? opt.value.actor : null;
		})),
		onLocalChange: (documentId) => Effect.gen(function* () {
			const actor = yield* manager.get(documentId);
			if (actor) yield* actor.send({ _tag: "LocalChange" });
		}),
		onServerUpdate: (documentId) => Effect.gen(function* () {
			const actor = yield* manager.get(documentId);
			if (actor) yield* actor.send({ _tag: "ExternalUpdate" });
		}),
		unregister: (documentId) => Effect.gen(function* () {
			const actors = yield* Ref.get(actorsRef);
			const managed = HashMap.get(actors, documentId);
			if (Option.isNone(managed)) return;
			yield* managed.value.actor.shutdown;
			yield* Scope.close(managed.value.scope, Exit.void);
			yield* Ref.update(actorsRef, HashMap.remove(documentId));
			yield* Effect.log(`Actor unregistered for document ${documentId}`);
		}),
		destroy: () => Effect.gen(function* () {
			const actors = yield* Ref.get(actorsRef);
			yield* Effect.all(Array.from(HashMap.values(actors)).map((managed) => Effect.gen(function* () {
				yield* managed.actor.shutdown;
				yield* Scope.close(managed.scope, Exit.void);
			})), { concurrency: "unbounded" });
			yield* Ref.set(actorsRef, HashMap.empty());
			yield* Effect.log("ActorManager destroyed");
		})
	};
	return manager;
});

//#endregion
//#region src/client/services/runtime.ts
const singletonRef = Ref.unsafeMake(Option.none());
const createRuntimeInternal = (options) => Effect.gen(function* () {
	const scope = yield* Effect.scope;
	const actorManager = yield* createActorManager(options.config).pipe(Effect.provideService(Scope.Scope, scope));
	const seqLayer = createSeqLayer(options.kv);
	const layer = Layer.mergeAll(Layer.succeed(ActorManagerService, actorManager), seqLayer);
	return {
		runtime: yield* Layer.toRuntime(layer),
		actorManager,
		cleanup: () => Effect.runPromise(actorManager.destroy())
	};
});
const createRuntime = (options) => {
	if (!options.singleton) return createRuntimeInternal(options);
	return Effect.gen(function* () {
		const existing = yield* Ref.get(singletonRef);
		if (Option.isSome(existing)) {
			yield* Ref.update(singletonRef, Option.map((state) => ({
				...state,
				refCount: state.refCount + 1
			})));
			return existing.value.runtime;
		}
		const runtime = yield* createRuntimeInternal(options);
		yield* Ref.set(singletonRef, Option.some({
			runtime,
			refCount: 1
		}));
		return runtime;
	});
};
const runWithRuntime = (runtime, effect) => Runtime.runPromise(runtime.runtime)(effect);

//#endregion
//#region src/client/prose.ts
const SERVER_ORIGIN = "server";
const noop$1 = () => void 0;
const logger = getLogger$1(["replicate", "prose"]);
function createSyncFn(document, ydoc, ymap, collectionRef) {
	return async () => {
		const material = serializeYMapValue(ymap);
		const bytes = Y.encodeStateAsUpdateV2(ydoc).buffer;
		await collectionRef.update(document, { metadata: { contentSync: {
			bytes,
			material
		} } }, (draft) => {
			draft.updatedAt = Date.now();
		}).isPersisted.promise;
	};
}
function observeFragment(config$1) {
	const { collection: collection$1, document, field, fragment, ydoc, ymap, collectionRef, debounceMs } = config$1;
	if (!hasContext(collection$1)) {
		logger.warn("Cannot observe fragment - collection not initialized", {
			collection: collection$1,
			document
		});
		return noop$1;
	}
	const ctx = getContext(collection$1);
	const actorManager = ctx.actorManager;
	const runtime = ctx.runtime;
	if (!actorManager || !runtime) {
		logger.warn("Cannot observe fragment - actor system not initialized", {
			collection: collection$1,
			document
		});
		return noop$1;
	}
	const existingCleanup = ctx.fragmentObservers.get(document);
	if (existingCleanup) {
		logger.debug("Fragment already being observed", {
			collection: collection$1,
			document,
			field
		});
		return existingCleanup;
	}
	const syncFn = createSyncFn(document, ydoc, ymap, collectionRef);
	runWithRuntime(runtime, actorManager.register(document, ydoc, syncFn, debounceMs));
	const observerHandler = (_events, transaction) => {
		if (transaction.origin === SERVER_ORIGIN) return;
		runWithRuntime(runtime, actorManager.onLocalChange(document));
	};
	fragment.observeDeep(observerHandler);
	const cleanup$1 = () => {
		fragment.unobserveDeep(observerHandler);
		runWithRuntime(runtime, actorManager.unregister(document));
		ctx.fragmentObservers.delete(document);
		logger.debug("Fragment observer cleaned up", {
			collection: collection$1,
			document,
			field
		});
	};
	ctx.fragmentObservers.set(document, cleanup$1);
	logger.debug("Fragment observer registered", {
		collection: collection$1,
		document,
		field
	});
	return cleanup$1;
}
function isPending(collection$1, document) {
	if (!hasContext(collection$1)) return false;
	const ctx = getContext(collection$1);
	if (!ctx.actorManager || !ctx.runtime) return false;
	let result = false;
	const effect = Effect.gen(function* () {
		const actor = yield* ctx.actorManager.get(document);
		if (!actor) return false;
		return yield* SubscriptionRef.get(actor.pending);
	});
	try {
		result = Effect.runSync(Effect.provide(effect, ctx.runtime.runtime));
	} catch {
		result = false;
	}
	return result;
}
function subscribePending(collection$1, document, callback) {
	if (!hasContext(collection$1)) return noop$1;
	const ctx = getContext(collection$1);
	if (!ctx.actorManager || !ctx.runtime) return noop$1;
	let fiber = null;
	const setupEffect = Effect.gen(function* () {
		const actor = yield* ctx.actorManager.get(document);
		if (!actor) return;
		const stream = actor.pending.changes;
		fiber = yield* Effect.fork(Stream.runForEach(stream, (pending) => Effect.sync(() => callback(pending))));
	});
	try {
		Effect.runSync(Effect.provide(setupEffect, ctx.runtime.runtime));
	} catch {
		return noop$1;
	}
	return () => {
		if (fiber) Effect.runPromise(Fiber.interrupt(fiber));
	};
}
function cleanup(collection$1) {
	if (!hasContext(collection$1)) return;
	const ctx = getContext(collection$1);
	for (const [, cleanupFn] of ctx.fragmentObservers) cleanupFn();
	ctx.fragmentObservers.clear();
	if (ctx.runtime) ctx.runtime.cleanup();
	logger.debug("Prose cleanup complete", { collection: collection$1 });
}
const PROSE_MARKER = Symbol.for("replicate:prose");
function createProseSchema() {
	const schema$1 = custom((val) => {
		if (val == null) return true;
		if (typeof val !== "object") return false;
		return val.type === "doc";
	}, { message: "Expected prose document with type \"doc\"" });
	Object.defineProperty(schema$1, PROSE_MARKER, {
		value: true,
		writable: false
	});
	return schema$1;
}
function emptyProse() {
	return {
		type: "doc",
		content: []
	};
}
function prose() {
	return createProseSchema();
}
prose.empty = emptyProse;
function isProseSchema(schema$1) {
	return schema$1 != null && typeof schema$1 === "object" && PROSE_MARKER in schema$1 && schema$1[PROSE_MARKER] === true;
}
function extractProseFields(schema$1) {
	const fields = [];
	for (const [key, fieldSchema] of Object.entries(schema$1.shape)) {
		let unwrapped = fieldSchema;
		while (unwrapped instanceof ZodOptional || unwrapped instanceof ZodNullable) unwrapped = unwrapped.unwrap();
		if (isProseSchema(unwrapped)) fields.push(key);
	}
	return fields;
}

//#endregion
//#region src/client/services/awareness.ts
const DEFAULT_HEARTBEAT_INTERVAL = 1e4;
const DEFAULT_THROTTLE_MS = 50;
function createAwarenessProvider(config$1) {
	const { convexClient, api, document, client, ydoc, interval = DEFAULT_HEARTBEAT_INTERVAL, syncReady, user } = config$1;
	const awareness = new Awareness(ydoc);
	if (user) awareness.setLocalStateField("user", user);
	let state = "idle";
	let visible = true;
	let heartbeatTimer = null;
	let throttleTimer = null;
	let startTimeout = null;
	let unsubscribeCursors;
	let unsubscribeVisibility;
	let unsubscribePageHide;
	const flightStatus = {
		inFlight: false,
		pending: null
	};
	const remoteClientIds = /* @__PURE__ */ new Map();
	const getVector = () => {
		return Y.encodeStateVector(ydoc).buffer;
	};
	const extractCursorFromState = (awarenessState) => {
		if (!awarenessState) return void 0;
		const cursor = awarenessState.cursor;
		if (cursor?.anchor === void 0 || cursor.head === void 0) return;
		try {
			return {
				anchor: JSON.parse(JSON.stringify(cursor.anchor)),
				head: JSON.parse(JSON.stringify(cursor.head))
			};
		} catch {
			return;
		}
	};
	const extractUserFromState = (awarenessState) => {
		if (!awarenessState) return {};
		const userState = awarenessState.user;
		if (userState) {
			const profile = {};
			if (typeof userState.name === "string") profile.name = userState.name;
			if (typeof userState.color === "string") profile.color = userState.color;
			if (typeof userState.avatar === "string") profile.avatar = userState.avatar;
			if (Object.keys(profile).length > 0) return { profile };
		}
		return {};
	};
	const buildJoinPayload = () => {
		const localState = awareness.getLocalState();
		const cursor = extractCursorFromState(localState);
		const { user: userId, profile } = extractUserFromState(localState);
		return {
			action: "join",
			cursor,
			user: userId,
			profile,
			vector: getVector()
		};
	};
	const executePresence = async (payload) => {
		await convexClient.mutation(api.presence, {
			document,
			client,
			action: payload.action,
			cursor: payload.cursor,
			user: payload.user,
			profile: payload.profile,
			interval: payload.action === "join" ? interval : void 0,
			vector: payload.vector
		});
	};
	const isDestroyed = () => state === "destroyed";
	const sendWithSingleFlight = async (payload) => {
		if (isDestroyed()) return;
		if (flightStatus.inFlight) {
			flightStatus.pending = payload;
			return;
		}
		flightStatus.inFlight = true;
		try {
			await executePresence(payload);
		} finally {
			while (flightStatus.pending && !isDestroyed()) {
				const next = flightStatus.pending;
				flightStatus.pending = null;
				try {
					await executePresence(next);
				} catch {
					break;
				}
			}
			flightStatus.inFlight = false;
		}
	};
	const transitionTo = (newState) => {
		if (!{
			idle: ["joining", "destroyed"],
			joining: [
				"active",
				"leaving",
				"destroyed"
			],
			active: ["leaving", "destroyed"],
			leaving: [
				"idle",
				"joining",
				"destroyed"
			],
			destroyed: []
		}[state].includes(newState)) return false;
		state = newState;
		return true;
	};
	const join = () => {
		if (state === "destroyed" || !visible) return;
		if (state === "idle" || state === "leaving") transitionTo("joining");
		sendWithSingleFlight(buildJoinPayload()).then(() => {
			if (state === "joining") transitionTo("active");
		});
	};
	const leave = () => {
		if (state === "destroyed") return;
		if (state === "idle") return;
		transitionTo("leaving");
		sendWithSingleFlight({ action: "leave" }).then(() => {
			if (state === "leaving") transitionTo("idle");
		});
	};
	const throttledJoin = () => {
		if (throttleTimer) return;
		if (state === "destroyed") return;
		throttleTimer = setTimeout(() => {
			throttleTimer = null;
			if (visible) join();
		}, DEFAULT_THROTTLE_MS);
	};
	const onLocalAwarenessUpdate = (changes, origin) => {
		if (origin === "remote") return;
		if (state === "destroyed") return;
		const localClientId = awareness.clientID;
		if (changes.added.includes(localClientId) || changes.updated.includes(localClientId)) throttledJoin();
	};
	const subscribeToPresence = () => {
		unsubscribeCursors = convexClient.onUpdate(api.sessions, {
			document,
			connected: true,
			exclude: client
		}, (remotes) => {
			if (state === "destroyed") return;
			const validRemotes = remotes.filter((r) => r.document === document);
			const currentRemotes = /* @__PURE__ */ new Set();
			for (const remote of validRemotes) {
				currentRemotes.add(remote.client);
				let remoteClientId = remoteClientIds.get(remote.client);
				if (!remoteClientId) {
					remoteClientId = hashStringToNumber(remote.client);
					remoteClientIds.set(remote.client, remoteClientId);
				}
				const remoteState = { user: {
					name: remote.profile?.name ?? remote.user ?? getStableAnonName(remote.client),
					color: remote.profile?.color ?? getStableAnonColor(remote.client),
					avatar: remote.profile?.avatar,
					clientId: remote.client
				} };
				if (remote.cursor) remoteState.cursor = remote.cursor;
				awareness.states.set(remoteClientId, remoteState);
			}
			for (const [clientStr, clientId] of remoteClientIds) if (!currentRemotes.has(clientStr)) {
				awareness.states.delete(clientId);
				remoteClientIds.delete(clientStr);
			}
			awareness.emit("update", [{
				added: [],
				updated: Array.from(remoteClientIds.values()),
				removed: []
			}, "remote"]);
		});
	};
	const setupVisibilityHandler = () => {
		if (typeof globalThis.document === "undefined") return;
		const handler = () => {
			if (state === "destroyed") return;
			const wasVisible = visible;
			visible = globalThis.document.visibilityState === "visible";
			if (wasVisible && !visible) leave();
			else if (!wasVisible && visible) join();
		};
		globalThis.document.addEventListener("visibilitychange", handler);
		unsubscribeVisibility = () => {
			globalThis.document.removeEventListener("visibilitychange", handler);
		};
	};
	const setupPageHideHandler = () => {
		if (typeof globalThis.window === "undefined") return;
		const handler = (e) => {
			if (e.persisted) return;
			if (state === "destroyed") return;
			convexClient.mutation(api.presence, {
				document,
				client,
				action: "leave"
			});
		};
		globalThis.window.addEventListener("pagehide", handler);
		unsubscribePageHide = () => {
			globalThis.window.removeEventListener("pagehide", handler);
		};
	};
	const startHeartbeat = () => {
		if (state === "destroyed") return;
		join();
		heartbeatTimer = setInterval(() => {
			if (state !== "destroyed" && visible) join();
		}, interval);
	};
	const stopHeartbeat = () => {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	};
	awareness.on("update", onLocalAwarenessUpdate);
	subscribeToPresence();
	setupVisibilityHandler();
	setupPageHideHandler();
	const initHeartbeat = async () => {
		if (syncReady) await syncReady;
		if (state !== "destroyed") startHeartbeat();
	};
	startTimeout = setTimeout(() => {
		initHeartbeat();
	}, 0);
	return {
		awareness,
		document: ydoc,
		destroy: () => {
			if (state === "destroyed") return;
			transitionTo("destroyed");
			if (startTimeout) {
				clearTimeout(startTimeout);
				startTimeout = null;
			}
			if (throttleTimer) {
				clearTimeout(throttleTimer);
				throttleTimer = null;
			}
			flightStatus.pending = null;
			stopHeartbeat();
			awareness.off("update", onLocalAwarenessUpdate);
			unsubscribeCursors?.();
			unsubscribeVisibility?.();
			unsubscribePageHide?.();
			for (const clientId of remoteClientIds.values()) awareness.states.delete(clientId);
			remoteClientIds.clear();
			awareness.emit("update", [{
				added: [],
				updated: [],
				removed: []
			}, "remote"]);
			convexClient.mutation(api.presence, {
				document,
				client,
				action: "leave"
			});
			awareness.destroy();
		}
	};
}
function hashStringToNumber(str) {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return Math.abs(hash);
}
const ANONYMOUS_ADJECTIVES = [
	"Swift",
	"Bright",
	"Calm",
	"Bold",
	"Keen",
	"Quick",
	"Warm",
	"Cool",
	"Sharp",
	"Gentle"
];
const ANONYMOUS_NOUNS = [
	"Fox",
	"Owl",
	"Bear",
	"Wolf",
	"Hawk",
	"Deer",
	"Lynx",
	"Crow",
	"Hare",
	"Seal"
];
const ANONYMOUS_COLORS = [
	"#9F5944",
	"#A9704D",
	"#B08650",
	"#8A7D3F",
	"#6E7644",
	"#8C4A42",
	"#9E7656",
	"#9A5240",
	"#987C4A",
	"#7A8B6E"
];
function getStableAnonName(clientId) {
	const hash = hashStringToNumber(clientId);
	return `${ANONYMOUS_ADJECTIVES[hash % ANONYMOUS_ADJECTIVES.length]} ${ANONYMOUS_NOUNS[(hash >> 4) % ANONYMOUS_NOUNS.length]}`;
}
function getStableAnonColor(clientId) {
	return ANONYMOUS_COLORS[(hashStringToNumber(clientId) >> 8) % ANONYMOUS_COLORS.length];
}

//#endregion
//#region src/client/collection.ts
var YjsOrigin = /* @__PURE__ */ function(YjsOrigin$1) {
	YjsOrigin$1["Local"] = "local";
	YjsOrigin$1["Fragment"] = "fragment";
	YjsOrigin$1["Server"] = "server";
	return YjsOrigin$1;
}(YjsOrigin || {});
const noop = () => void 0;
function handleMutationError(error) {
	const httpError = error;
	if (httpError?.status === 401 || httpError?.status === 403) throw new NonRetriableError("Authentication failed");
	if (httpError?.status === 422) throw new NonRetriableError("Validation error");
	throw error;
}
const DEFAULT_DEBOUNCE_MS = 200;
function convexCollectionOptions(config$1) {
	const { schema: schema$1, getKey, material, convexClient, api, persistence: persistence$1 } = config$1;
	const collection$1 = getFunctionName(api.stream).split(":")[0];
	if (!collection$1) throw new Error("Could not extract collection name from api.stream function reference");
	const proseFields = schema$1 && schema$1 instanceof ZodObject ? extractProseFields(schema$1) : [];
	const proseFieldSet = new Set(proseFields);
	const utils = { async prose(document, field, options) {
		const fieldStr = field;
		if (!proseFieldSet.has(fieldStr)) throw new ProseError({
			document,
			field: fieldStr,
			collection: collection$1
		});
		let ctx = hasContext(collection$1) ? getContext(collection$1) : null;
		if (!ctx) {
			await new Promise((resolve, reject) => {
				const maxWait = 1e4;
				const startTime = Date.now();
				const check = setInterval(() => {
					if (hasContext(collection$1)) {
						clearInterval(check);
						resolve();
					} else if (Date.now() - startTime > maxWait) {
						clearInterval(check);
						reject(new ProseError({
							document,
							field: fieldStr,
							collection: collection$1
						}));
					}
				}, 10);
			});
			ctx = hasContext(collection$1) ? getContext(collection$1) : null;
		}
		if (!ctx) throw new ProseError({
			document,
			field: fieldStr,
			collection: collection$1
		});
		const fragment = ctx.subdocs.getFragment(document, fieldStr);
		if (!fragment) throw new ProseError({
			document,
			field: fieldStr,
			collection: collection$1
		});
		const subdoc = ctx.subdocs.get(document);
		if (!subdoc) throw new ProseError({
			document,
			field: fieldStr,
			collection: collection$1
		});
		if (ctx.actorReady) await ctx.actorReady;
		const collectionRef = ctx.ref;
		if (collectionRef) observeFragment({
			collection: collection$1,
			document,
			field: fieldStr,
			fragment,
			ydoc: subdoc,
			ymap: ctx.subdocs.getFields(document),
			collectionRef,
			debounceMs: options?.debounceMs
		});
		const storedConvexClient = ctx.client;
		const storedApi = ctx.api;
		const storedClientId = ctx.clientId;
		let awarenessProvider = null;
		const hasPresenceApi = storedApi?.sessions && storedApi?.presence;
		if (storedConvexClient && hasPresenceApi && storedClientId) awarenessProvider = createAwarenessProvider({
			convexClient: storedConvexClient,
			api: {
				presence: storedApi.presence,
				sessions: storedApi.sessions
			},
			document,
			client: storedClientId,
			ydoc: subdoc,
			syncReady: ctx.synced,
			user: options?.user
		});
		return {
			fragment,
			provider: awarenessProvider ? {
				awareness: awarenessProvider.awareness,
				document: subdoc
			} : {
				awareness: new Awareness(subdoc),
				document: subdoc
			},
			get pending() {
				return isPending(collection$1, document);
			},
			onPendingChange(callback) {
				return subscribePending(collection$1, document, callback);
			},
			destroy() {
				awarenessProvider?.destroy();
			}
		};
	} };
	const subdocManager = createSubdocManager(collection$1);
	let docPersistence = null;
	initContext({
		collection: collection$1,
		subdocs: subdocManager,
		client: convexClient,
		api,
		persistence: persistence$1,
		fields: proseFieldSet
	});
	let ops = null;
	const seqLayer = createSeqLayer(persistence$1.kv);
	let resolvePersistenceReady;
	const persistenceReadyPromise = new Promise((resolve) => {
		resolvePersistenceReady = resolve;
	});
	let resolveOptimisticReady;
	const optimisticReadyPromise = new Promise((resolve) => {
		resolveOptimisticReady = resolve;
	});
	const recover = async () => {
		if (!api.recovery) return;
		const documents = subdocManager.documents();
		if (documents.length === 0) return;
		for (const document of documents) {
			const localVector = subdocManager.encodeStateVector(document);
			convexClient.query(api.recovery, {
				document,
				vector: localVector.buffer
			}).then((response) => {
				if (response.diff) {
					const diff = new Uint8Array(response.diff);
					subdocManager.applyUpdate(document, diff, YjsOrigin.Server);
				}
			});
		}
	};
	const applyYjsInsert = (mutations) => {
		const deltas = [];
		for (const mut of mutations) {
			const document = String(mut.key);
			const delta = subdocManager.transactWithDelta(document, (fieldsMap) => {
				Object.entries(mut.modified).forEach(([k, v]) => {
					if (proseFieldSet.has(k) && isDoc(v)) {
						const fragment = new Y.XmlFragment();
						fieldsMap.set(k, fragment);
						fragmentFromJSON(fragment, v);
					} else fieldsMap.set(k, v);
				});
			}, YjsOrigin.Local);
			deltas.push(delta);
		}
		return deltas;
	};
	const applyYjsUpdate = (mutations) => {
		const deltas = [];
		for (const mut of mutations) {
			const document = String(mut.key);
			if (!subdocManager.getFields(document)) continue;
			const modifiedFields = mut.modified;
			if (!modifiedFields) continue;
			const delta = subdocManager.transactWithDelta(document, (fields) => {
				Object.entries(modifiedFields).forEach(([k, v]) => {
					if (proseFieldSet.has(k)) return;
					if (fields.get(k) instanceof Y.XmlFragment) return;
					fields.set(k, v);
				});
			}, YjsOrigin.Local);
			deltas.push(delta);
		}
		return deltas;
	};
	const applyYjsDelete = (mutations) => {
		const deltas = [];
		for (const mut of mutations) {
			const document = String(mut.key);
			const delta = subdocManager.encodeState(document);
			subdocManager.delete(document);
			deltas.push(delta);
		}
		return deltas;
	};
	return {
		id: collection$1,
		getKey,
		schema: schema$1,
		utils,
		onInsert: async ({ transaction }) => {
			const deltas = applyYjsInsert(transaction.mutations);
			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
				for (let i = 0; i < transaction.mutations.length; i++) {
					const mut = transaction.mutations[i];
					const delta = deltas[i];
					if (!delta || delta.length === 0) continue;
					const document = String(mut.key);
					const materializedDoc = extractDocumentFromSubdoc(subdocManager, document) ?? mut.modified;
					await convexClient.mutation(api.insert, {
						document,
						bytes: delta.slice().buffer,
						material: materializedDoc
					});
				}
			} catch (error) {
				handleMutationError(error);
			}
		},
		onUpdate: async ({ transaction }) => {
			const mutation = transaction.mutations[0];
			const documentKey = String(mutation.key);
			const metadata = mutation.metadata;
			const isContentSync = !!metadata?.contentSync;
			const deltas = isContentSync ? null : applyYjsUpdate(transaction.mutations);
			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
				if (isContentSync && metadata?.contentSync) {
					const { bytes, material: material$1 } = metadata.contentSync;
					await convexClient.mutation(api.update, {
						document: documentKey,
						bytes,
						material: material$1
					});
					return;
				}
				if (deltas) for (let i = 0; i < transaction.mutations.length; i++) {
					const mut = transaction.mutations[i];
					const delta = deltas[i];
					if (!delta || delta.length === 0) continue;
					const docId = String(mut.key);
					const fullDoc = extractDocumentFromSubdoc(subdocManager, docId) ?? mut.modified;
					await convexClient.mutation(api.update, {
						document: docId,
						bytes: delta.slice().buffer,
						material: fullDoc
					});
				}
			} catch (error) {
				handleMutationError(error);
			}
		},
		onDelete: async ({ transaction }) => {
			const deltas = applyYjsDelete(transaction.mutations);
			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
				const itemsToDelete = transaction.mutations.map((mut) => mut.original).filter((item) => item !== void 0 && Object.keys(item).length > 0);
				ops.delete(itemsToDelete);
				for (let i = 0; i < transaction.mutations.length; i++) {
					const mut = transaction.mutations[i];
					const delta = deltas[i];
					if (!delta || delta.length === 0) continue;
					await convexClient.mutation(api.remove, {
						document: String(mut.key),
						bytes: delta.slice().buffer
					});
				}
			} catch (error) {
				handleMutationError(error);
			}
		},
		sync: {
			rowUpdateMode: "partial",
			sync: (params) => {
				const { markReady, collection: collectionInstance } = params;
				updateContext(collection$1, { ref: collectionInstance });
				const ctx = getContext(collection$1);
				if (ctx.cleanup) {
					ctx.cleanup();
					ctx.cleanup = void 0;
				}
				let subscription = null;
				const ssrDocuments = material?.documents;
				const ssrCrdt = material?.crdt;
				const ssrCursor = material?.cursor;
				const docs = ssrDocuments ? [...ssrDocuments] : [];
				(async () => {
					try {
						docPersistence = persistence$1.createDocPersistence(collection$1, subdocManager.rootDoc);
						await docPersistence.whenSynced;
						const subdocPromises = subdocManager.enablePersistence((document, subdoc) => {
							return persistence$1.createDocPersistence(`${collection$1}:${document}`, subdoc);
						});
						await Promise.all(subdocPromises);
						resolvePersistenceReady?.();
						const clientId = await getClientId(persistence$1.kv);
						updateContext(collection$1, { clientId });
						ops = createReplicateOps(params);
						resolveOptimisticReady?.();
						if (ssrCrdt) for (const [docId, state] of Object.entries(ssrCrdt)) {
							const update = new Uint8Array(state.bytes);
							subdocManager.applyUpdate(docId, update, YjsOrigin.Server);
						}
						await recover();
						if (subdocManager.documents().length > 0) {
							const items = extractAllDocuments(subdocManager);
							ops.replace(items);
						} else ops.replace([]);
						markReady();
						getContext(collection$1).resolve?.();
						const persistedCursor = await Effect.runPromise(Effect.gen(function* () {
							return yield* (yield* SeqService).load(collection$1);
						}).pipe(Effect.provide(seqLayer)));
						const cursor = ssrCursor ?? persistedCursor;
						const replicateRuntime = await Effect.runPromise(Effect.scoped(createRuntime({
							kv: persistence$1.kv,
							config: { debounceMs: DEFAULT_DEBOUNCE_MS }
						})));
						const actorManager = replicateRuntime.actorManager;
						updateContext(collection$1, {
							actorManager,
							runtime: replicateRuntime
						});
						getContext(collection$1).resolveActorReady?.();
						const handleSnapshotChange = async (bytes, document, exists) => {
							if (!exists && !subdocManager.has(document)) return;
							const itemBefore = extractDocumentFromSubdoc(subdocManager, document);
							const update = new Uint8Array(bytes);
							subdocManager.applyUpdate(document, update, YjsOrigin.Server);
							const itemAfter = extractDocumentFromSubdoc(subdocManager, document);
							if (itemAfter) if (itemBefore) ops.upsert([itemAfter]);
							else ops.insert([itemAfter]);
							await runWithRuntime(replicateRuntime, actorManager.onServerUpdate(document));
						};
						const handleDeltaChange = async (bytes, document, exists) => {
							if (!document) return;
							if (!exists && !subdocManager.has(document)) return;
							const itemBefore = extractDocumentFromSubdoc(subdocManager, document);
							const update = new Uint8Array(bytes);
							subdocManager.applyUpdate(document, update, YjsOrigin.Server);
							const itemAfter = extractDocumentFromSubdoc(subdocManager, document);
							if (itemAfter) if (itemBefore) ops.upsert([itemAfter]);
							else ops.insert([itemAfter]);
							else if (itemBefore) ops.delete([itemBefore]);
							await runWithRuntime(replicateRuntime, actorManager.onServerUpdate(document));
						};
						const handleSubscriptionUpdate = async (response) => {
							if (!response || !Array.isArray(response.changes)) return;
							const { changes, seq: newSeq, compact } = response;
							const syncedDocuments = /* @__PURE__ */ new Set();
							for (const change of changes) {
								const { type, bytes, document, exists } = change;
								if (!bytes || !document) continue;
								syncedDocuments.add(document);
								if (type === "snapshot") await handleSnapshotChange(bytes, document, exists ?? true);
								else await handleDeltaChange(bytes, document, exists ?? true);
							}
							if (newSeq !== void 0) {
								persistence$1.kv.set(`cursor:${collection$1}`, newSeq);
								const markPromises = Array.from(syncedDocuments).map((document) => {
									const vector = subdocManager.encodeStateVector(document);
									return convexClient.mutation(api.mark, {
										document,
										client: clientId,
										seq: newSeq,
										vector: vector.buffer
									}).catch(noop);
								});
								Promise.all(markPromises);
							}
							if (compact?.documents?.length) {
								const compactPromises = compact.documents.map((doc) => convexClient.mutation(api.compact, { document: doc }).catch(noop));
								Promise.all(compactPromises);
							}
						};
						subscription = convexClient.onUpdate(api.stream, {
							seq: cursor,
							limit: 1e3
						}, (response) => {
							handleSubscriptionUpdate(response);
						});
					} catch {
						markReady();
					}
				})();
				return {
					material: docs,
					cleanup: () => {
						subscription?.();
						cleanup(collection$1);
						deleteContext(collection$1);
						docPersistence?.destroy();
						subdocManager?.destroy();
					}
				};
			}
		}
	};
}
const collection = { create(options) {
	let persistence$1 = null;
	let resolvedConfig = null;
	let material;
	let instance = null;
	return {
		async init(mat) {
			if (!persistence$1) {
				persistence$1 = await options.persistence();
				resolvedConfig = options.config();
				material = mat;
			}
		},
		get() {
			if (!persistence$1 || !resolvedConfig) throw new Error("Call init() before get()");
			if (!instance) instance = createCollection(convexCollectionOptions({
				...resolvedConfig,
				persistence: persistence$1,
				material
			}));
			return instance;
		}
	};
} };

//#endregion
//#region src/client/persistence/memory.ts
/**
* In-memory key-value store.
*/
var MemoryKeyValueStore = class {
	store = /* @__PURE__ */ new Map();
	async get(key) {
		return this.store.get(key);
	}
	async set(key, value) {
		this.store.set(key, value);
	}
	async del(key) {
		this.store.delete(key);
	}
};
/**
* No-op persistence provider for in-memory usage.
*
* The Y.Doc is kept in memory without persistence.
*/
var MemoryPersistenceProvider = class {
	whenSynced = Promise.resolve();
	destroy() {}
};
/**
* Create an in-memory persistence factory.
*
* Useful for testing where you don't want IndexedDB side effects.
*
* @example
* ```typescript
* // In tests
* convexCollectionOptions<Task>({
*   // ... other options
*   persistence: memoryPersistence(),
* });
* ```
*/
function memoryPersistence() {
	return {
		createDocPersistence: (_, __) => new MemoryPersistenceProvider(),
		kv: new MemoryKeyValueStore()
	};
}

//#endregion
//#region src/client/persistence/sqlite/schema.ts
async function initSchema$1(executor) {
	await executor.execute(`
    CREATE TABLE IF NOT EXISTS snapshots (
      collection TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      state_vector BLOB,
      seq INTEGER DEFAULT 0
    )
  `);
	await executor.execute(`
    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      data BLOB NOT NULL
    )
  `);
	await executor.execute(`
    CREATE INDEX IF NOT EXISTS updates_collection_idx ON updates (collection)
  `);
	await executor.execute(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}
var SqliteKeyValueStore = class {
	constructor(executor) {
		this.executor = executor;
	}
	async get(key) {
		const result = await this.executor.execute("SELECT value FROM kv WHERE key = ?", [key]);
		if (result.rows.length === 0) return void 0;
		return JSON.parse(result.rows[0].value);
	}
	async set(key, value) {
		await this.executor.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
	}
	async del(key) {
		await this.executor.execute("DELETE FROM kv WHERE key = ?", [key]);
	}
};
var SqlitePersistenceProvider = class {
	updateHandler;
	whenSynced;
	constructor(executor, collection$1, ydoc) {
		this.executor = executor;
		this.collection = collection$1;
		this.ydoc = ydoc;
		this.whenSynced = this.loadState();
		this.updateHandler = (update, origin) => {
			if (origin !== "sqlite") this.saveUpdate(update);
		};
		this.ydoc.on("update", this.updateHandler);
	}
	async loadState() {
		const snapshotResult = await this.executor.execute("SELECT data FROM snapshots WHERE collection = ?", [this.collection]);
		if (snapshotResult.rows.length > 0) {
			const raw = snapshotResult.rows[0].data;
			const snapshotData = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
			Y.applyUpdate(this.ydoc, snapshotData, "sqlite");
		}
		const updatesResult = await this.executor.execute("SELECT data FROM updates WHERE collection = ? ORDER BY id ASC", [this.collection]);
		for (const row of updatesResult.rows) {
			const raw = row.data;
			const updateData = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
			Y.applyUpdate(this.ydoc, updateData, "sqlite");
		}
	}
	async saveUpdate(update) {
		await this.executor.execute("INSERT INTO updates (collection, data) VALUES (?, ?)", [this.collection, update]);
	}
	destroy() {
		this.ydoc.off("update", this.updateHandler);
	}
};
function createPersistenceFromExecutor(executor) {
	return {
		createDocPersistence: (collection$1, ydoc) => new SqlitePersistenceProvider(executor, collection$1, ydoc),
		kv: new SqliteKeyValueStore(executor)
	};
}

//#endregion
//#region src/client/persistence/sqlite/native.ts
var OPSqliteExecutor = class {
	constructor(db) {
		this.db = db;
	}
	async execute(sql, params) {
		return { rows: (await this.db.execute(sql, params)).rows || [] };
	}
	close() {
		this.db.close();
	}
};
async function createNativeSqlitePersistence(db, _dbName) {
	const executor = new OPSqliteExecutor(db);
	await initSchema$1(executor);
	return createPersistenceFromExecutor(executor);
}

//#endregion
//#region src/client/persistence/custom.ts
const SNAPSHOT_PREFIX = "snapshot:";
const UPDATE_PREFIX = "update:";
const META_PREFIX = "meta:";
var AdapterKeyValueStore = class {
	constructor(adapter) {
		this.adapter = adapter;
	}
	async get(key) {
		const data = await this.adapter.get(`${META_PREFIX}${key}`);
		if (!data) return void 0;
		return JSON.parse(new TextDecoder().decode(data));
	}
	async set(key, value) {
		await this.adapter.set(`${META_PREFIX}${key}`, new TextEncoder().encode(JSON.stringify(value)));
	}
	async del(key) {
		await this.adapter.delete(`${META_PREFIX}${key}`);
	}
};
var AdapterPersistenceProvider = class {
	updateHandler;
	updateCounter = 0;
	whenSynced;
	constructor(adapter, collection$1, ydoc) {
		this.adapter = adapter;
		this.collection = collection$1;
		this.ydoc = ydoc;
		this.whenSynced = this.loadState();
		this.updateHandler = (update, origin) => {
			if (origin !== "custom") this.saveUpdate(update);
		};
		this.ydoc.on("update", this.updateHandler);
	}
	async loadState() {
		const snapshotData = await this.adapter.get(`${SNAPSHOT_PREFIX}${this.collection}`);
		if (snapshotData) Y.applyUpdate(this.ydoc, snapshotData, "custom");
		const sortedKeys = (await this.adapter.keys(`${UPDATE_PREFIX}${this.collection}:`)).sort();
		for (const key of sortedKeys) {
			const updateData = await this.adapter.get(key);
			if (updateData) {
				Y.applyUpdate(this.ydoc, updateData, "custom");
				const seq = parseInt(key.split(":").pop() || "0", 10);
				if (seq > this.updateCounter) this.updateCounter = seq;
			}
		}
	}
	async saveUpdate(update) {
		this.updateCounter++;
		const paddedCounter = String(this.updateCounter).padStart(10, "0");
		await this.adapter.set(`${UPDATE_PREFIX}${this.collection}:${paddedCounter}`, update);
	}
	destroy() {
		this.ydoc.off("update", this.updateHandler);
	}
};
function createCustomPersistence(adapter) {
	return {
		createDocPersistence: (collection$1, ydoc) => new AdapterPersistenceProvider(adapter, collection$1, ydoc),
		kv: new AdapterKeyValueStore(adapter)
	};
}

//#endregion
//#region src/client/persistence/pglite.ts
async function initSchema(pg) {
	await pg.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      collection TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      state_vector BYTEA,
      seq INTEGER DEFAULT 0
    )
  `);
	await pg.exec(`
    CREATE TABLE IF NOT EXISTS updates (
      id SERIAL PRIMARY KEY,
      collection TEXT NOT NULL,
      data BYTEA NOT NULL
    )
  `);
	await pg.exec(`
    CREATE INDEX IF NOT EXISTS updates_collection_idx ON updates (collection)
  `);
	await pg.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}
var PGliteKeyValueStore = class {
	constructor(pg) {
		this.pg = pg;
	}
	async get(key) {
		const result = await this.pg.query("SELECT value FROM kv WHERE key = $1", [key]);
		if (result.rows.length === 0) return void 0;
		return JSON.parse(result.rows[0].value);
	}
	async set(key, value) {
		await this.pg.query(`INSERT INTO kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`, [key, JSON.stringify(value)]);
	}
	async del(key) {
		await this.pg.query("DELETE FROM kv WHERE key = $1", [key]);
	}
};
var PGlitePersistenceProvider = class {
	updateHandler;
	whenSynced;
	constructor(pg, collection$1, ydoc) {
		this.pg = pg;
		this.collection = collection$1;
		this.ydoc = ydoc;
		this.whenSynced = this.loadState();
		this.updateHandler = (update, origin) => {
			if (origin !== "pglite") this.saveUpdate(update);
		};
		this.ydoc.on("update", this.updateHandler);
	}
	async loadState() {
		const snapshotResult = await this.pg.query("SELECT data FROM snapshots WHERE collection = $1", [this.collection]);
		if (snapshotResult.rows.length > 0) {
			const raw = snapshotResult.rows[0].data;
			const snapshotData = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
			Y.applyUpdate(this.ydoc, snapshotData, "pglite");
		}
		const updatesResult = await this.pg.query("SELECT data FROM updates WHERE collection = $1 ORDER BY id ASC", [this.collection]);
		for (const row of updatesResult.rows) {
			const raw = row.data;
			const updateData = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
			Y.applyUpdate(this.ydoc, updateData, "pglite");
		}
	}
	async saveUpdate(update) {
		await this.pg.query("INSERT INTO updates (collection, data) VALUES ($1, $2)", [this.collection, update]);
	}
	destroy() {
		this.ydoc.off("update", this.updateHandler);
	}
};
async function createPGlitePersistence(pg) {
	await initSchema(pg);
	return {
		createDocPersistence: (collection$1, ydoc) => new PGlitePersistenceProvider(pg, collection$1, ydoc),
		kv: new PGliteKeyValueStore(pg)
	};
}
/**
* Creates a singleton PGlite persistence factory.
* Use this to ensure the PGlite WASM module is only loaded once,
* even when shared across multiple collections.
*
* @example
* ```typescript
* // src/lib/pglite.ts
* import { persistence } from "@trestleinc/replicate/client";
*
* export const pglite = persistence.pglite.once(async () => {
*   const { PGlite } = await import("@electric-sql/pglite");
*   const { live } = await import("@electric-sql/pglite/live");
*   return PGlite.create({ dataDir: "idb://app", extensions: { live } });
* });
*
* // src/collections/useIntervals.ts
* import { pglite } from "$lib/pglite";
*
* export const intervals = collection.create({
*   persistence: pglite,
*   config: () => ({ ... }),
* });
* ```
*/
function oncePGlitePersistence(factory) {
	let instance = null;
	return () => instance ??= factory().then(createPGlitePersistence);
}

//#endregion
//#region src/client/persistence/index.ts
const persistence = {
	pglite: Object.assign(createPGlitePersistence, { once: oncePGlitePersistence }),
	sqlite: createNativeSqlitePersistence,
	memory: memoryPersistence,
	custom: createCustomPersistence
};

//#endregion
//#region src/client/index.ts
const errors = {
	Network: NetworkError,
	IDB: IDBError,
	IDBWrite: IDBWriteError,
	Reconciliation: ReconciliationError,
	Prose: ProseError,
	CollectionNotReady: CollectionNotReadyError,
	NonRetriable: NonRetriableError
};
const schema = { prose: Object.assign(prose, {
	extract,
	empty: prose.empty
}) };

//#endregion
export { collection, errors, persistence, schema };