import { v } from "convex/values";
import { schema } from "@trestleinc/replicate/server";

/**
 * Versioned schema for comments collection.
 *
 * When you need to add/remove/change fields:
 * 1. Increment the version number
 * 2. Update the shape with the new structure
 * 3. Add the previous version to history
 * 4. Add defaults for any new optional fields
 */
export const commentSchema = schema.define({
	version: 1,

	shape: v.object({
		id: v.string(),
		ownerId: v.optional(v.string()),
		isPublic: v.boolean(),
		intervalId: v.string(),
		body: v.string(),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),

	// Default values for optional fields (applied during migrations)
	defaults: {
		isPublic: false,
	},

	// Previous schema versions (empty for v1)
	history: {},
});
