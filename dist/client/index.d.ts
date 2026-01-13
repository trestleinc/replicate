import * as Y from "yjs";
import { FunctionReference } from "convex/server";
import { BaseCollectionConfig, Collection, NonSingleResult } from "@tanstack/db";
import { Context, Effect, Layer } from "effect";
import { Awareness } from "y-protocols/awareness";
import { ConvexClient } from "convex/browser";
import { StandardSchemaV1 } from "@standard-schema/spec";
import * as effect_Types0 from "effect/Types";
import * as effect_Cause0 from "effect/Cause";
import { z } from "zod";

//#region src/shared/types.d.ts
/** ProseMirror-compatible JSON for XmlFragment serialization */
interface XmlFragmentJSON {
  type: "doc";
  content?: XmlNodeJSON[];
}
declare const PROSE_BRAND: unique symbol;
/**
 * Branded prose type for Zod schemas.
 * Extends XmlFragmentJSON with a unique brand for type-level detection.
 * Use the `prose()` helper from `@trestleinc/replicate/client` to create this type.
 */
interface ProseValue extends XmlFragmentJSON {
  readonly [PROSE_BRAND]: typeof PROSE_BRAND;
}
/** ProseMirror node structure */
interface XmlNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: XmlNodeJSON[];
  text?: string;
  marks?: {
    type: string;
    attrs?: Record<string, unknown>;
  }[];
}
/**
 * Extract prose field names from T (fields typed as ProseValue).
 * Used internally for type-safe prose field operations.
 */
type ProseFields<T> = { [K in keyof T]: T[K] extends ProseValue ? K : never }[keyof T];
//#endregion
//#region src/client/persistence/types.d.ts
/**
 * Low-level storage adapter for custom backends (Chrome extension, localStorage, cloud).
 * For SQLite, use `persistence.sqlite()` directly.
 *
 * @example
 * ```typescript
 * class ChromeStorageAdapter implements StorageAdapter {
 *   async get(key: string) {
 *     const result = await chrome.storage.local.get(key);
 *     return result[key] ? new Uint8Array(result[key]) : undefined;
 *   }
 *   async set(key: string, value: Uint8Array) {
 *     await chrome.storage.local.set({ [key]: Array.from(value) });
 *   }
 *   async delete(key: string) {
 *     await chrome.storage.local.remove(key);
 *   }
 *   async keys(prefix: string) {
 *     const all = await chrome.storage.local.get(null);
 *     return Object.keys(all).filter(k => k.startsWith(prefix));
 *   }
 * }
 * ```
 */
interface StorageAdapter {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  close?(): void;
}
interface PersistenceProvider {
  readonly whenSynced: Promise<void>;
  destroy(): void;
}
/**
 * High-level persistence interface for collections.
 * Create via `persistence.sqlite()`, `persistence.memory()`, or `persistence.custom()`.
 */
interface Persistence {
  createDocPersistence(collection: string, ydoc: Y.Doc): PersistenceProvider;
  readonly kv: KeyValueStore;
}
interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
}
//#endregion
//#region src/client/errors.d.ts
declare const NetworkError_base: new <A extends Record<string, any> = {}>(args: effect_Types0.Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }) => effect_Cause0.YieldableError & {
  readonly _tag: "NetworkError";
} & Readonly<A>;
declare class NetworkError extends NetworkError_base<{
  readonly cause: unknown;
  readonly retryable: true;
  readonly operation: string;
}> {}
declare const IDBError_base: new <A extends Record<string, any> = {}>(args: effect_Types0.Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }) => effect_Cause0.YieldableError & {
  readonly _tag: "IDBError";
} & Readonly<A>;
declare class IDBError extends IDBError_base<{
  readonly operation: "get" | "set" | "delete" | "clear";
  readonly store?: string;
  readonly key?: string;
  readonly cause: unknown;
}> {}
declare const IDBWriteError_base: new <A extends Record<string, any> = {}>(args: effect_Types0.Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }) => effect_Cause0.YieldableError & {
  readonly _tag: "IDBWriteError";
} & Readonly<A>;
declare class IDBWriteError extends IDBWriteError_base<{
  readonly key: string;
  readonly value: unknown;
  readonly cause: unknown;
}> {}
declare const ReconciliationError_base: new <A extends Record<string, any> = {}>(args: effect_Types0.Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }) => effect_Cause0.YieldableError & {
  readonly _tag: "ReconciliationError";
} & Readonly<A>;
declare class ReconciliationError extends ReconciliationError_base<{
  readonly collection: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}
declare const ProseError_base: new <A extends Record<string, any> = {}>(args: effect_Types0.Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }) => effect_Cause0.YieldableError & {
  readonly _tag: "ProseError";
} & Readonly<A>;
declare class ProseError extends ProseError_base<{
  readonly document: string;
  readonly field: string;
  readonly collection: string;
}> {}
declare const CollectionNotReadyError_base: new <A extends Record<string, any> = {}>(args: effect_Types0.Equals<A, {}> extends true ? void : { readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }) => effect_Cause0.YieldableError & {
  readonly _tag: "CollectionNotReadyError";
} & Readonly<A>;
declare class CollectionNotReadyError extends CollectionNotReadyError_base<{
  readonly collection: string;
  readonly reason: string;
}> {}
/** Error that should not be retried (auth failures, validation errors) */
declare class NonRetriableError extends Error {
  constructor(message: string);
}
//#endregion
//#region src/client/services/seq.d.ts
type Seq = number;
//#endregion
//#region src/client/services/awareness.d.ts
interface UserIdentity {
  name?: string;
  color?: string;
  avatar?: string;
}
//#endregion
//#region src/client/collection.d.ts
/** Server-rendered material data for SSR hydration */
interface Materialized<T> {
  documents: readonly T[];
  cursor?: Seq;
  count?: number;
  crdt?: Record<string, {
    bytes: ArrayBuffer;
    seq: number;
  }>;
}
/** API object from replicate() */
interface ConvexCollectionApi {
  stream: FunctionReference<"query">;
  insert: FunctionReference<"mutation">;
  update: FunctionReference<"mutation">;
  remove: FunctionReference<"mutation">;
  recovery: FunctionReference<"query">;
  mark: FunctionReference<"mutation">;
  compact: FunctionReference<"mutation">;
  material?: FunctionReference<"query">;
  sessions?: FunctionReference<"query">;
  presence?: FunctionReference<"mutation">;
}
interface ConvexCollectionConfig<T extends object = object, TSchema extends StandardSchemaV1 = never, TKey extends string | number = string | number> extends BaseCollectionConfig<T, TKey, TSchema> {
  schema: TSchema;
  convexClient: ConvexClient;
  api: ConvexCollectionApi;
  persistence: Persistence;
  material?: Materialized<T>;
}
/**
 * Binding returned by collection.utils.prose() for collaborative editing.
 *
 * Compatible with TipTap's Collaboration/CollaborationCursor and BlockNote's
 * collaboration config. The editor handles undo/redo internally via y-prosemirror.
 */
interface EditorBinding {
  /** Yjs XmlFragment for content sync */
  readonly fragment: Y.XmlFragment;
  /**
   * Provider with Yjs Awareness for cursor/presence sync.
   * Pass to CollaborationCursor.configure({ provider: binding.provider })
   * or BlockNote's collaboration.provider
   */
  readonly provider: {
    readonly awareness: Awareness;
    readonly document: Y.Doc;
  };
  /** Whether there are unsaved local changes */
  readonly pending: boolean;
  /** Subscribe to pending state changes */
  onPendingChange(callback: (pending: boolean) => void): () => void;
  /** Cleanup - call when unmounting editor */
  destroy(): void;
}
interface ProseOptions {
  /** User identity for collaborative presence */
  user?: UserIdentity;
  /**
   * Debounce delay in milliseconds before syncing changes to server.
   * Local changes are batched during this window for efficiency.
   * @default 200
   */
  debounceMs?: number;
}
interface ConvexCollectionUtils<T extends object> {
  prose(document: string, field: ProseFields<T>, options?: ProseOptions): Promise<EditorBinding>;
}
type LazyCollectionConfig<TSchema extends z.ZodObject<z.ZodRawShape>> = Omit<ConvexCollectionConfig<z.infer<TSchema>, TSchema, string>, "persistence" | "material">;
interface LazyCollection<T extends object> {
  init(material?: Materialized<T>): Promise<void>;
  get(): Collection<T, string, ConvexCollectionUtils<T>, any, T> & NonSingleResult;
}
type ConvexCollection<T extends object> = Collection<T, any, ConvexCollectionUtils<T>, any, T> & NonSingleResult;
interface CreateCollectionOptions<TSchema extends z.ZodObject<z.ZodRawShape>> {
  persistence: () => Promise<Persistence>;
  config: () => Omit<LazyCollectionConfig<TSchema>, "material">;
}
declare const collection: {
  create<TSchema extends z.ZodObject<z.ZodRawShape>>(options: CreateCollectionOptions<TSchema>): LazyCollection<z.infer<TSchema>>;
};
//#endregion
//#region src/client/merge.d.ts
/**
 * Extract plain text from ProseMirror/BlockNote JSON content.
 * Handles various content structures defensively for search and display.
 */
declare function extract(content: unknown): string;
//#endregion
//#region src/client/prose.d.ts
declare function emptyProse(): ProseValue;
declare function prose(): z.ZodType<ProseValue>;
declare namespace prose {
  var empty: typeof emptyProse;
}
//#endregion
//#region src/client/persistence/memory.d.ts
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
declare function memoryPersistence(): Persistence;
//#endregion
//#region src/client/persistence/sqlite/native.d.ts
interface OPSQLiteDatabase {
  execute(sql: string, params?: unknown[]): Promise<{
    rows: Record<string, unknown>[];
  }>;
  close(): void;
}
declare function createNativeSqlitePersistence(db: OPSQLiteDatabase, _dbName: string): Promise<Persistence>;
//#endregion
//#region src/client/persistence/custom.d.ts
declare function createCustomPersistence(adapter: StorageAdapter): Persistence;
//#endregion
//#region src/client/persistence/pglite.d.ts
interface PGliteInterface {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{
    rows: T[];
  }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}
declare function createPGlitePersistence(pg: PGliteInterface): Promise<Persistence>;
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
declare function oncePGlitePersistence(factory: () => Promise<PGliteInterface>): () => Promise<Persistence>;
//#endregion
//#region src/client/persistence/index.d.ts
declare const persistence: {
  readonly pglite: typeof createPGlitePersistence & {
    once: typeof oncePGlitePersistence;
  };
  readonly sqlite: typeof createNativeSqlitePersistence;
  readonly memory: typeof memoryPersistence;
  readonly custom: typeof createCustomPersistence;
};
//#endregion
//#region src/client/index.d.ts
declare const errors: {
  readonly Network: typeof NetworkError;
  readonly IDB: typeof IDBError;
  readonly IDBWrite: typeof IDBWriteError;
  readonly Reconciliation: typeof ReconciliationError;
  readonly Prose: typeof ProseError;
  readonly CollectionNotReady: typeof CollectionNotReadyError;
  readonly NonRetriable: typeof NonRetriableError;
};
declare const schema: {
  readonly prose: typeof prose & {
    extract: typeof extract;
    empty: () => ProseValue;
  };
};
//#endregion
export { type ConvexCollection, type EditorBinding, type Materialized, type Persistence, type ProseOptions, type Seq, type StorageAdapter, type UserIdentity, collection, errors, persistence, schema };