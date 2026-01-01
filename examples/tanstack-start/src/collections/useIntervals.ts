import { collection } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { intervalSchema, type Interval } from "../types/interval";
import { pglite } from "../lib/pglite";

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL!;

export const intervals = collection.create({
  persistence: pglite,
  config: () => ({
    schema: intervalSchema,
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.intervals,
    getKey: (interval: Interval) => interval.id,
  }),
});

export type { Interval } from "../types/interval";
