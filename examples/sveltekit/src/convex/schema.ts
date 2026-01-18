import { defineSchema, type TableDefinition } from "convex/server";
import { v } from "convex/values";
import { schema } from "@trestleinc/replicate/server";

// Re-export versioned schemas for client-side usage
export { intervalSchema } from "./schema/intervals";
export { commentSchema } from "./schema/comments";

const statusValidator = v.union(
	v.literal("backlog"),
	v.literal("todo"),
	v.literal("in_progress"),
	v.literal("done"),
	v.literal("canceled"),
);

const priorityValidator = v.union(
	v.literal("none"),
	v.literal("low"),
	v.literal("medium"),
	v.literal("high"),
	v.literal("urgent"),
);

/**
 * Convex schema definition.
 *
 * This uses schema.table() to define the Convex backend tables.
 * The versioned schemas (intervalSchema, commentSchema) are exported
 * for client-side migrations with the new collection.create() API.
 */
export default defineSchema({
	intervals: schema.table(
		{
			id: v.string(),
			ownerId: v.optional(v.string()),
			isPublic: v.boolean(),
			title: v.string(),
			description: schema.prose(),
			status: statusValidator,
			priority: priorityValidator,
			createdAt: v.number(),
			updatedAt: v.number(),
		},
		(t: TableDefinition) =>
			t
				.index("by_doc_id", ["id"])
				.index("by_timestamp", ["timestamp"])
				.index("by_status", ["status"])
				.index("by_priority", ["priority"])
				.index("by_updated", ["updatedAt"])
				.index("by_owner", ["ownerId"])
				.index("by_public", ["isPublic"]),
	),

	comments: schema.table(
		{
			id: v.string(),
			ownerId: v.optional(v.string()),
			isPublic: v.boolean(),
			intervalId: v.string(),
			body: v.string(),
			createdAt: v.number(),
			updatedAt: v.number(),
		},
		(t: TableDefinition) =>
			t
				.index("by_doc_id", ["id"])
				.index("by_timestamp", ["timestamp"])
				.index("by_interval", ["intervalId"])
				.index("by_owner", ["ownerId"])
				.index("by_public", ["isPublic"]),
	),
});
