import { collection } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { api } from "$convex/_generated/api";
import { commentSchema } from "$lib/types";
import { pglite } from "$lib/pglite";

export const comments = collection.create({
  persistence: pglite,
  config: () => ({
    schema: commentSchema,
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.comments,
    getKey: (comment) => comment.id,
  }),
});

export type { Comment } from "$lib/types";
