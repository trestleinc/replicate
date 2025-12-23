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

  peers: defineTable({
    collection: v.string(),
    peerId: v.string(),
    lastSyncedSeq: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_collection", ["collection"])
    .index("by_collection_peer", ["collection", "peerId"]),
});
