import { collection, identity } from "@trestleinc/replicate/client";
import { api } from "$convex/_generated/api";
import schema from "$convex/schema";
import { createPersistence } from "$lib/sqlite";
import { convexClient } from "$lib/convex";
import { authClient } from "$lib/auth-client";

export const intervals = collection.create(schema, "intervals", {
  persistence: createPersistence,
  config: () => ({
    convexClient,
    api: api.intervals,
    getKey: interval => interval.id,
    user: () => {
      const store = authClient.useSession();
      const session = store.get();
      if (!session.data?.user) return undefined;
      return identity.from({
        id: session.data.user.id,
        name: session.data.user.name,
        avatar: session.data.user.image ?? undefined,
        color: identity.color.generate(session.data.user.id),
      });
    },
  }),
});

export type Interval = collection.Infer<typeof intervals>;
