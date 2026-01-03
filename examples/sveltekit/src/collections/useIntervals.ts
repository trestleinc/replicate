import { collection } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { api } from "$convex/_generated/api";
import schema from "$convex/schema";
import { pglite } from "$lib/pglite";

export const intervals = collection.create(schema, "intervals", {
  persistence: pglite,
  config: () => ({
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.intervals,
    getKey: (interval) => interval.id,
  }),
});

export type Interval = NonNullable<typeof intervals.$docType>;
