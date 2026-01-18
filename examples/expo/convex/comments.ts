import { collection } from "@trestleinc/replicate/server";
import { query } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

export const { material, delta, replicate, presence, session } = collection.create<Doc<"comments">>(
	components.replicate,
	"comments",
);

export const get = query({
	args: { id: v.string() },
	handler: async (ctx, { id }) => {
		return await ctx.db
			.query("comments")
			.withIndex("by_doc_id", q => q.eq("id", id))
			.first();
	},
});

export const listByInterval = query({
	args: { intervalId: v.string() },
	handler: async (ctx, { intervalId }) => {
		return await ctx.db
			.query("comments")
			.withIndex("by_interval", q => q.eq("intervalId", intervalId))
			.collect();
	},
});
