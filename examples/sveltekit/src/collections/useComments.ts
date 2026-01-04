import { collection } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { api } from "$convex/_generated/api";
import schema from "$convex/schema";
import { sqlite } from "$lib/sqlite";

export const comments = collection.create(schema, "comments", {
  persistence: sqlite,
  config: () => ({
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.comments,
    getKey: (comment) => comment.id,
  }),
});

export type Comment = collection.Infer<typeof comments>;
