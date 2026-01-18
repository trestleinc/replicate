import { collection, persistence } from "@trestleinc/replicate/client";
import { ConvexClient } from "convex/browser";
import { open } from "@op-engineering/op-sqlite";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL!;

export const comments = collection.create(schema, "comments", {
	persistence: async () => {
		const db = open({ name: "comments.db" });
		return persistence.native.sqlite(db, "comments");
	},
	config: () => ({
		convexClient: new ConvexClient(CONVEX_URL),
		api: api.comments,
		getKey: comment => comment.id,
	}),
});

export type Comment = NonNullable<typeof comments.$docType>;
