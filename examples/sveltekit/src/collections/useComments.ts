import { collection } from "@trestleinc/replicate/client";
import { api } from "$convex/_generated/api";
import schema from "$convex/schema";
import { createPersistence } from "$lib/sqlite";
import { convexClient } from "$lib/convex";
import { authClient } from "$lib/auth-client";

export const comments = collection.create(schema, "comments", {
  persistence: createPersistence,
  config: () => ({
    convexClient,
    api: api.comments,
    getKey: (comment) => comment.id,
    user: () => {
      const store = authClient.useSession();
      const session = store.get();
      if (!session.data?.user) return undefined;
      return {
        id: session.data.user.id,
        name: session.data.user.name,
        avatar: session.data.user.image ?? undefined,
      };
    },
  }),
});

export type Comment = collection.Infer<typeof comments>;
