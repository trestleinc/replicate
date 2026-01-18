import { collection } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { sqlite } from "../lib/sqlite";

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL!;

export const intervals = collection.create(schema, "intervals", {
	persistence: sqlite,
	config: () => ({
		convexClient: new ConvexClient(CONVEX_URL),
		api: api.intervals,
		getKey: interval => interval.id,
	}),
});

export type Interval = NonNullable<typeof intervals.$docType>;
