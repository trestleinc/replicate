import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    collection: v.string(),
    documentId: v.string(),
    crdtBytes: v.bytes(),
    seq: v.number(),
  })
    .index("by_collection", ["collection"])
    .index("by_collection_document", ["collection", "documentId"])
    .index("by_seq", ["collection", "seq"]),

  snapshots: defineTable({
    collection: v.string(),
    documentId: v.string(),
    snapshotBytes: v.bytes(),
    stateVector: v.bytes(),
    snapshotSeq: v.number(),
    createdAt: v.number(),
  }).index("by_document", ["collection", "documentId"]),

  sessions: defineTable({
    collection: v.string(),
    document: v.string(),
    client: v.string(),
    seq: v.number(),
    seen: v.number(),
    user: v.optional(v.string()),
    profile: v.optional(v.object({
      name: v.optional(v.string()),
      color: v.optional(v.string()),
      avatar: v.optional(v.string()),
    })),
    cursor: v.optional(v.object({
      anchor: v.number(),
      head: v.number(),
      field: v.optional(v.string()),
    })),
    active: v.optional(v.number()),
  })
    .index("collection", ["collection"])
    .index("document", ["collection", "document"])
    .index("client", ["collection", "document", "client"]),
});
