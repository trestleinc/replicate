import { collection } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { api } from "$convex/_generated/api";
import schema from "$convex/schema";
import { sqlite } from "$lib/sqlite";

export const intervals = collection.create(schema, "intervals", {
  persistence: sqlite,
  config: () => ({
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.intervals,
    getKey: (interval) => interval.id,
  }),
});

export type Interval = collection.Infer<typeof intervals>;
