import { collection, persistence } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { api } from "$convex/_generated/api";
import { intervalSchema } from "$lib/types";

export const intervals = collection.create({
  persistence: async () => persistence.indexeddb("intervals"),
  config: () => ({
    schema: intervalSchema,
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.intervals,
    getKey: (interval) => interval.id,
  }),
});

export type { Interval } from "$lib/types";
