import { collection } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { api } from "$convex/_generated/api";
import { intervalSchema } from "$lib/types";
import { pglite } from "$lib/pglite";

export const intervals = collection.create({
  persistence: pglite,
  config: () => ({
    schema: intervalSchema,
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.intervals,
    getKey: (interval) => interval.id,
  }),
});

export type { Interval } from "$lib/types";
