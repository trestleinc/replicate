import { collection, persistence } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { api } from "$convex/_generated/api";
import { intervalSchema } from "$lib/types";
import initSqlJs from "sql.js";

export const intervals = collection.create({
  persistence: async () => {
    const SQL = await initSqlJs({
      locateFile: (file: string) => `https://sql.js.org/dist/${file}`,
    });
    return persistence.sqlite.browser(SQL, "intervals");
  },
  config: () => ({
    schema: intervalSchema,
    convexClient: new ConvexClient(PUBLIC_CONVEX_URL),
    api: api.intervals,
    getKey: (interval) => interval.id,
  }),
});

export type { Interval } from "$lib/types";
