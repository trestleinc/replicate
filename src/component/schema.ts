import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { profileValidator, cursorValidator } from "$/shared/validators";

export default defineSchema({
	devices: defineTable({
		collection: v.string(),
		userId: v.string(),
		deviceId: v.string(),
		publicKey: v.bytes(),
		name: v.optional(v.string()),
		created: v.number(),
		lastSeen: v.number(),
		approved: v.boolean(),
	})
		.index("by_user", ["collection", "userId"])
		.index("by_device", ["collection", "userId", "deviceId"]),

	wrappedKeys: defineTable({
		collection: v.string(),
		userId: v.string(),
		deviceId: v.string(),
		wrappedUmk: v.bytes(),
		created: v.number(),
	})
		.index("by_user", ["collection", "userId"])
		.index("by_device", ["collection", "userId", "deviceId"]),

	docKeys: defineTable({
		collection: v.string(),
		document: v.string(),
		userId: v.string(),
		wrappedKey: v.bytes(),
		created: v.number(),
	})
		.index("by_document", ["collection", "document"])
		.index("by_user_doc", ["collection", "userId", "document"]),

	deltas: defineTable({
		collection: v.string(),
		document: v.string(),
		bytes: v.bytes(),
		seq: v.number(),
	})
		.index("by_collection", ["collection"])
		.index("by_document", ["collection", "document"])
		.index("by_seq", ["collection", "seq"]),

	snapshots: defineTable({
		collection: v.string(),
		document: v.string(),
		bytes: v.bytes(),
		vector: v.bytes(),
		seq: v.number(),
		created: v.number(),
	}).index("by_document", ["collection", "document"]),

	sessions: defineTable({
		collection: v.string(),
		document: v.string(),
		client: v.string(),
		vector: v.optional(v.bytes()),
		connected: v.boolean(),
		seq: v.number(),
		seen: v.number(),
		user: v.optional(v.string()),
		profile: v.optional(profileValidator),
		cursor: v.optional(cursorValidator),
		timeout: v.optional(v.id("_scheduled_functions")),
	})
		.index("by_collection", ["collection"])
		.index("by_document", ["collection", "document"])
		.index("by_client", ["collection", "document", "client"])
		.index("by_connected", ["collection", "document", "connected"]),
});
