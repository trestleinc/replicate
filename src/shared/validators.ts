/**
 * Centralized Convex Validators - Single Source of Truth
 *
 * Following the val.md pattern from crane/bridge:
 * 1. All validators defined here
 * 2. Types derived from validators using Infer<>
 * 3. No duplicate interfaces - types come from validators
 *
 * @see https://github.com/trestleinc/crane/blob/main/val.md
 */

import { type Infer, v } from "convex/values";

// ─────────────────────────────────────────────────────────────────────────────
// Core Validators (used across component, server, client)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Profile validator for user presence/identity.
 * Used in sessions and presence tracking.
 */
export const profileValidator = v.object({
	name: v.optional(v.string()),
	color: v.optional(v.string()),
	avatar: v.optional(v.string()),
});

/**
 * Cursor validator for collaborative editing positions.
 * Tracks anchor/head selection positions and optional field context.
 */
export const cursorValidator = v.object({
	anchor: v.any(),
	head: v.any(),
	field: v.optional(v.string()),
});

/**
 * Prose validator for ProseMirror-compatible rich text JSON.
 * Used for collaborative rich text editing fields.
 */
export const proseValidator = v.object({
	type: v.literal("doc"),
	content: v.optional(v.array(v.any())),
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream/Sync Validators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Individual change in a stream response.
 */
export const streamChangeValidator = v.object({
	document: v.string(),
	bytes: v.bytes(),
	seq: v.number(),
	type: v.string(),
});

/**
 * Extended stream change with existence flag (used in server responses).
 */
export const streamChangeWithExistsValidator = v.object({
	document: v.string(),
	bytes: v.bytes(),
	seq: v.number(),
	type: v.string(),
	exists: v.boolean(),
});

/**
 * Stream query result with changes, cursor, and compaction hints.
 */
export const streamResultValidator = v.object({
	changes: v.array(streamChangeValidator),
	seq: v.number(),
	more: v.boolean(),
	compact: v.optional(
		v.object({
			documents: v.array(v.string()),
		}),
	),
});

/**
 * Stream result with exists flag on changes (server-enriched response).
 */
export const streamResultWithExistsValidator = v.object({
	changes: v.array(streamChangeWithExistsValidator),
	seq: v.number(),
	more: v.boolean(),
	compact: v.optional(
		v.object({
			documents: v.array(v.string()),
		}),
	),
});

// ─────────────────────────────────────────────────────────────────────────────
// Session/Presence Validators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session record for presence tracking.
 * Returned by sessions query.
 */
export const sessionValidator = v.object({
	client: v.string(),
	document: v.string(),
	user: v.optional(v.string()),
	profile: v.optional(v.any()),
	cursor: v.optional(cursorValidator),
	seen: v.number(),
});

/**
 * Presence action (join or leave).
 */
export const presenceActionValidator = v.union(v.literal("join"), v.literal("leave"));

// ─────────────────────────────────────────────────────────────────────────────
// Mutation Result Validators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard success/seq result for insert/update/delete mutations.
 */
export const successSeqValidator = v.object({
	success: v.boolean(),
	seq: v.number(),
});

/**
 * Compaction result with statistics.
 */
export const compactResultValidator = v.object({
	success: v.boolean(),
	removed: v.number(),
	retained: v.number(),
	size: v.number(),
});

/**
 * Recovery query result with optional diff and state vector.
 */
export const recoveryResultValidator = v.object({
	diff: v.optional(v.bytes()),
	vector: v.bytes(),
});

/**
 * Document state result (for SSR/hydration).
 */
export const documentStateValidator = v.union(
	v.object({
		bytes: v.bytes(),
		seq: v.number(),
	}),
	v.null(),
);

// ─────────────────────────────────────────────────────────────────────────────
// SSR/Material Validators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SSR material query result.
 */
export const materialResultValidator = v.object({
	documents: v.any(),
	count: v.number(),
	crdt: v.optional(
		v.record(
			v.string(),
			v.object({
				bytes: v.bytes(),
				seq: v.number(),
			}),
		),
	),
	cursor: v.optional(v.number()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Derived Types (Single Source of Truth)
// ─────────────────────────────────────────────────────────────────────────────

/** User profile for presence/identity. */
export type Profile = Infer<typeof profileValidator>;

/** Cursor position for collaborative editing. */
export type Cursor = Infer<typeof cursorValidator>;

/** ProseMirror-compatible JSON structure. */
export type ProseValue = Infer<typeof proseValidator>;

/** Individual stream change. */
export type StreamChange = Infer<typeof streamChangeValidator>;

/** Stream change with exists flag. */
export type StreamChangeWithExists = Infer<typeof streamChangeWithExistsValidator>;

/** Stream query result. */
export type StreamResult = Infer<typeof streamResultValidator>;

/** Stream result with exists flags. */
export type StreamResultWithExists = Infer<typeof streamResultWithExistsValidator>;

/** Session record for presence. */
export type Session = Infer<typeof sessionValidator>;

/** Presence action type. */
export type PresenceAction = Infer<typeof presenceActionValidator>;

/** Success/seq mutation result. */
export type SuccessSeq = Infer<typeof successSeqValidator>;

/** Compaction result with stats. */
export type CompactResult = Infer<typeof compactResultValidator>;

/** Recovery query result. */
export type RecoveryResult = Infer<typeof recoveryResultValidator>;

/** Document state for SSR. */
export type DocumentState = Infer<typeof documentStateValidator>;

/** SSR material result. */
export type MaterialResult = Infer<typeof materialResultValidator>;
