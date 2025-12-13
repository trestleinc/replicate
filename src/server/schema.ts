import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Fields automatically added to replicated tables */
export type ReplicationFields = {
  version: number;
  timestamp: number;
};

/**
 * Validator for prose (rich text) fields.
 * Validates ProseMirror-compatible JSON structure.
 *
 * @example
 * ```typescript
 * import { prose, replicatedTable } from '@trestleinc/replicate/server';
 *
 * export default defineSchema({
 *   notebooks: replicatedTable({
 *     id: v.string(),
 *     title: v.string(),
 *     content: prose(),
 *   }),
 * });
 * ```
 */
export const prose = () =>
  v.object({
    type: v.literal('doc'),
    content: v.optional(v.array(v.any())),
  });

/**
 * Define a table with automatic version and timestamp fields for replication.
 *
 * @example
 * ```typescript
 * // convex/schema.ts
 * export default defineSchema({
 *   tasks: replicatedTable(
 *     { id: v.string(), text: v.string(), isCompleted: v.boolean() },
 *     (t) => t.index('by_id', ['id'])
 *   ),
 * });
 * ```
 */
export function replicatedTable(
  userFields: Record<string, any>,
  applyIndexes?: (table: any) => any
): any {
  const table = defineTable({
    ...userFields,
    version: v.number(),
    timestamp: v.number(),
  });

  if (applyIndexes) {
    return applyIndexes(table);
  }

  return table;
}
