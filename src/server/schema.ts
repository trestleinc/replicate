import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Fields automatically added to replicated tables */
export interface ReplicationFields {
  timestamp: number;
}

export const prose = () =>
  v.object({
    type: v.literal("doc"),
    content: v.optional(v.array(v.any())),
  });

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
export function table(userFields: Record<string, any>, applyIndexes?: (table: any) => any): any {
  const tbl = defineTable({
    ...userFields,
    timestamp: v.number(),
  });

  if (applyIndexes) {
    return applyIndexes(tbl);
  }

  return tbl;
}
