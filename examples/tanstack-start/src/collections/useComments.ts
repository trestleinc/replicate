import { collection } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { commentSchema, type Comment } from "../types/interval";
import { pglite } from "../lib/pglite";

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL!;

export const comments = collection.create({
  persistence: pglite,
  config: () => ({
    schema: commentSchema,
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.comments,
    getKey: (comment: Comment) => comment.id,
  }),
});

export type { Comment } from "../types/interval";
