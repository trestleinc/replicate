import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const registerDevice = mutation({
	args: {
		collection: v.string(),
		userId: v.string(),
		deviceId: v.string(),
		publicKey: v.bytes(),
		name: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("devices")
			.withIndex("by_device", q =>
				q.eq("collection", args.collection).eq("userId", args.userId).eq("deviceId", args.deviceId),
			)
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, {
				publicKey: args.publicKey,
				lastSeen: Date.now(),
				name: args.name,
			});
			return { id: existing._id, isNew: false };
		}

		const userDevices = await ctx.db
			.query("devices")
			.withIndex("by_user", q => q.eq("collection", args.collection).eq("userId", args.userId))
			.collect();

		const isFirstDevice = userDevices.length === 0;

		const id = await ctx.db.insert("devices", {
			collection: args.collection,
			userId: args.userId,
			deviceId: args.deviceId,
			publicKey: args.publicKey,
			name: args.name,
			created: Date.now(),
			lastSeen: Date.now(),
			approved: isFirstDevice,
		});

		return { id, isNew: true, autoApproved: isFirstDevice };
	},
});

export const listDevices = query({
	args: {
		collection: v.string(),
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		return ctx.db
			.query("devices")
			.withIndex("by_user", q => q.eq("collection", args.collection).eq("userId", args.userId))
			.collect();
	},
});

export const getPendingDevices = query({
	args: {
		collection: v.string(),
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		const devices = await ctx.db
			.query("devices")
			.withIndex("by_user", q => q.eq("collection", args.collection).eq("userId", args.userId))
			.collect();

		return devices.filter(d => !d.approved);
	},
});

export const approveDevice = mutation({
	args: {
		collection: v.string(),
		userId: v.string(),
		deviceId: v.string(),
		wrappedUmk: v.bytes(),
	},
	handler: async (ctx, args) => {
		const device = await ctx.db
			.query("devices")
			.withIndex("by_device", q =>
				q.eq("collection", args.collection).eq("userId", args.userId).eq("deviceId", args.deviceId),
			)
			.first();

		if (!device) {
			throw new Error("Device not found");
		}

		await ctx.db.patch(device._id, { approved: true });

		const existingKey = await ctx.db
			.query("wrappedKeys")
			.withIndex("by_device", q =>
				q.eq("collection", args.collection).eq("userId", args.userId).eq("deviceId", args.deviceId),
			)
			.first();

		if (existingKey) {
			await ctx.db.patch(existingKey._id, { wrappedUmk: args.wrappedUmk });
		} else {
			await ctx.db.insert("wrappedKeys", {
				collection: args.collection,
				userId: args.userId,
				deviceId: args.deviceId,
				wrappedUmk: args.wrappedUmk,
				created: Date.now(),
			});
		}

		return { success: true };
	},
});

export const getWrappedUmk = query({
	args: {
		collection: v.string(),
		userId: v.string(),
		deviceId: v.string(),
	},
	handler: async (ctx, args) => {
		const key = await ctx.db
			.query("wrappedKeys")
			.withIndex("by_device", q =>
				q.eq("collection", args.collection).eq("userId", args.userId).eq("deviceId", args.deviceId),
			)
			.first();

		return key?.wrappedUmk ?? null;
	},
});

export const storeDocKey = mutation({
	args: {
		collection: v.string(),
		document: v.string(),
		userId: v.string(),
		wrappedKey: v.bytes(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("docKeys")
			.withIndex("by_user_doc", q =>
				q.eq("collection", args.collection).eq("userId", args.userId).eq("document", args.document),
			)
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, { wrappedKey: args.wrappedKey });
			return { id: existing._id };
		}

		const id = await ctx.db.insert("docKeys", {
			collection: args.collection,
			document: args.document,
			userId: args.userId,
			wrappedKey: args.wrappedKey,
			created: Date.now(),
		});

		return { id };
	},
});

export const getDocKey = query({
	args: {
		collection: v.string(),
		document: v.string(),
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		const key = await ctx.db
			.query("docKeys")
			.withIndex("by_user_doc", q =>
				q.eq("collection", args.collection).eq("userId", args.userId).eq("document", args.document),
			)
			.first();

		return key?.wrappedKey ?? null;
	},
});

export const getDocKeysForUser = query({
	args: {
		collection: v.string(),
		userId: v.string(),
	},
	handler: async (ctx, args) => {
		return ctx.db
			.query("docKeys")
			.withIndex("by_user_doc", q => q.eq("collection", args.collection).eq("userId", args.userId))
			.collect();
	},
});
