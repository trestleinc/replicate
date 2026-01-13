import * as convex_values0 from "convex/values";
import * as convex_server0 from "convex/server";
import { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";

//#region src/shared/types.d.ts

type SizeUnit = "kb" | "mb" | "gb";
type Size = `${number}${SizeUnit}`;
type DurationUnit = "m" | "h" | "d";
type Duration = `${number}${DurationUnit}`;
interface CompactionConfig {
  sizeThreshold: Size;
  peerTimeout: Duration;
}
//#endregion
//#region src/server/collection.d.ts
interface CollectionOptions<T extends object> {
  compaction?: Partial<CompactionConfig>;
  hooks?: {
    evalRead?: (ctx: GenericQueryCtx<GenericDataModel>, collection: string) => void | Promise<void>;
    evalWrite?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
    evalRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
    evalMark?: (ctx: GenericMutationCtx<GenericDataModel>, client: string) => void | Promise<void>;
    evalCompact?: (ctx: GenericMutationCtx<GenericDataModel>, document: string) => void | Promise<void>;
    onStream?: (ctx: GenericQueryCtx<GenericDataModel>, result: any) => void | Promise<void>;
    onInsert?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
    onUpdate?: (ctx: GenericMutationCtx<GenericDataModel>, doc: T) => void | Promise<void>;
    onRemove?: (ctx: GenericMutationCtx<GenericDataModel>, docId: string) => void | Promise<void>;
    transform?: (docs: T[]) => T[] | Promise<T[]>;
  };
}
declare function createCollection<T extends object>(component: any, name: string, options?: CollectionOptions<T>): {
  __collection: string;
  stream: convex_server0.RegisteredQuery<"public", {
    limit?: number | undefined;
    threshold?: number | undefined;
    seq: number;
  }, Promise<any>>;
  material: convex_server0.RegisteredQuery<"public", {}, Promise<{
    documents: T[];
    count: number;
    crdt?: Record<string, {
      bytes: ArrayBuffer;
      seq: number;
    }> | undefined;
    cursor?: number;
  }>>;
  recovery: convex_server0.RegisteredQuery<"public", {
    document: string;
    vector: ArrayBuffer;
  }, Promise<any>>;
  insert: convex_server0.RegisteredMutation<"public", {
    bytes: ArrayBuffer;
    document: string;
    material: any;
  }, Promise<{
    success: boolean;
    seq: any;
  }>>;
  update: convex_server0.RegisteredMutation<"public", {
    bytes: ArrayBuffer;
    document: string;
    material: any;
  }, Promise<{
    success: boolean;
    seq: any;
  }>>;
  remove: convex_server0.RegisteredMutation<"public", {
    bytes: ArrayBuffer;
    document: string;
  }, Promise<{
    success: boolean;
    seq: any;
  }>>;
  mark: convex_server0.RegisteredMutation<"public", {
    seq?: number | undefined;
    vector?: ArrayBuffer | undefined;
    document: string;
    client: string;
  }, Promise<null>>;
  compact: convex_server0.RegisteredMutation<"public", {
    document: string;
  }, Promise<any>>;
  sessions: convex_server0.RegisteredQuery<"public", {
    connected?: boolean | undefined;
    exclude?: string | undefined;
    group?: boolean | undefined;
    document: string;
  }, Promise<any>>;
  presence: convex_server0.RegisteredMutation<"public", {
    cursor?: {
      field?: string | undefined;
      anchor: any;
      head: any;
    } | undefined;
    vector?: ArrayBuffer | undefined;
    user?: string | undefined;
    profile?: {
      name?: string | undefined;
      color?: string | undefined;
      avatar?: string | undefined;
    } | undefined;
    interval?: number | undefined;
    document: string;
    client: string;
    action: "join" | "leave";
  }, Promise<null>>;
};
declare const collection: {
  readonly create: typeof createCollection;
};
//#endregion
//#region src/server/schema.d.ts
/**
 * Define a table with automatic timestamp field for replication.
 * All replicated tables must have an `id` field and define a `by_doc_id` index.
 *
 * @example
 * ```typescript
 * // convex/schema.ts
 * export default defineSchema({
 *   tasks: table(
 *     { id: v.string(), text: v.string(), isCompleted: v.boolean() },
 *     (t) => t.index('by_doc_id', ['id']).index('by_completed', ['isCompleted'])
 *   ),
 * });
 * ```
 */
declare function table(userFields: Record<string, any>, applyIndexes?: (table: any) => any): any;
//#endregion
//#region src/server/index.d.ts
declare const schema: {
  readonly table: typeof table;
  readonly prose: () => convex_values0.VObject<{
    content?: any[] | undefined;
    type: "doc";
  }, {
    type: convex_values0.VLiteral<"doc", "required">;
    content: convex_values0.VArray<any[] | undefined, convex_values0.VAny<any, "required", string>, "optional">;
  }, "required", "type" | "content">;
};
//#endregion
export { type CollectionOptions, collection, schema };