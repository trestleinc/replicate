import { collection, persistence } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { open } from "@op-engineering/op-sqlite";
import { api } from "../../convex/_generated/api";
import { commentSchema, type Comment } from "../types/interval";

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL!;

export const comments = collection.create({
  persistence: async () => {
    const db = open({ name: "comments.db" });
    return persistence.sqlite.native(db, "comments");
  },
  config: () => ({
    schema: commentSchema,
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.comments,
    getKey: (comment: Comment) => comment.id,
  }),
});

export type { Comment } from "../types/interval";
