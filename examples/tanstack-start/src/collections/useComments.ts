import { collection, type InferDoc } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { sqlite } from "../lib/sqlite";

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL!;

export const comments = collection.create(schema, "comments", {
	persistence: sqlite,
	config: () => ({
		convexClient: new ConvexClient(CONVEX_URL),
		api: api.comments,
		getKey: comment => comment.id,
	}),
});

export type Comment = InferDoc<typeof comments>;
