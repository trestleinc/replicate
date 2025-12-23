import { replicate } from "@trestleinc/replicate/server";
import { query } from "./_generated/server";
import { components } from "./_generated/api";
import { v } from "convex/values";
import type { Interval } from "../lib/types";

const r = replicate(components.replicate);

export const { stream, material, insert, update, remove, recovery, mark, compact } = r<Interval>({
  collection: "intervals",
});

export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    return await ctx.db
      .query("intervals")
      .withIndex("by_doc_id", q => q.eq("id", id))
      .first();
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("intervals").withIndex("by_updated").order("desc").collect();
  },
});

export const listByStatus = query({
  args: { status: v.string() },
  handler: async (ctx, { status }) => {
    return await ctx.db
      .query("intervals")
      .withIndex("by_status", q => q.eq("status", status))
      .collect();
  },
});
