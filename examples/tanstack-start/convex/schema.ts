import { defineSchema, type TableDefinition } from "convex/server";
import { v } from "convex/values";
import { schema } from "@trestleinc/replicate/server";

export default defineSchema({
	intervals: schema.table(
		{
			id: v.string(),
			title: v.string(),
			description: schema.prose(),
			status: v.string(), // backlog | todo | in_progress | done | canceled
			priority: v.string(), // none | low | medium | high | urgent
			createdAt: v.number(),
			updatedAt: v.number(),
		},
		(t: TableDefinition) =>
			t
				.index("by_doc_id", ["id"])
				.index("by_timestamp", ["timestamp"])
				.index("by_status", ["status"])
				.index("by_priority", ["priority"])
				.index("by_updated", ["updatedAt"]),
	),

	comments: schema.table(
		{
			id: v.string(),
			intervalId: v.string(),
			body: v.string(),
			createdAt: v.number(),
			updatedAt: v.number(),
		},
		(t: TableDefinition) =>
			t
				.index("by_doc_id", ["id"])
				.index("by_timestamp", ["timestamp"])
				.index("by_interval", ["intervalId"]),
	),
});
