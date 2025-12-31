import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
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
    profile: v.optional(v.object({
      name: v.optional(v.string()),
      color: v.optional(v.string()),
      avatar: v.optional(v.string()),
    })),
    cursor: v.optional(v.object({
      anchor: v.any(),
      head: v.any(),
      field: v.optional(v.string()),
    })),
    active: v.optional(v.number()),
    timeout: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_collection", ["collection"])
    .index("by_document", ["collection", "document"])
    .index("by_client", ["collection", "document", "client"])
    .index("by_connected", ["collection", "document", "connected"]),
});
