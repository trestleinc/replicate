import { collection, persistence } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { open } from "@op-engineering/op-sqlite";
import { api } from "../../convex/_generated/api";
import { intervalSchema, type Interval } from "../types/interval";

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL!;

export const intervals = collection.create({
  persistence: async () => {
    const db = open({ name: "intervals.db" });
    return persistence.sqlite.native(db, "intervals");
  },
  config: () => ({
    schema: intervalSchema,
    convexClient: new ConvexClient(CONVEX_URL),
    api: api.intervals,
    getKey: (interval: Interval) => interval.id,
  }),
});

export type { Interval } from "../types/interval";
