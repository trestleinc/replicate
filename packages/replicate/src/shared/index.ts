/**
 * @trestleinc/replicate - Shared Module
 *
 * Single source of truth for all validators, types, and utilities.
 *
 * Following the val.md pattern:
 * 1. All validators defined here
 * 2. Types derived from validators using Infer<>
 * 3. No duplicate interfaces - types come from validators
 */

import { type Infer, v } from 'convex/values';

// ============================================================================
// Core Validators (used across component, server, client)
// ============================================================================

/**
 * Profile validator for user presence/identity.
 * Used in sessions and presence tracking.
 */
export const profileValidator = v.object({
	name: v.optional(v.string()),
	color: v.optional(v.string()),
	avatar: v.optional(v.string()),
});

// ============================================================================
// Yjs Internal Structure Validators
// ============================================================================

/**
 * Yjs ID validator - internal identifier for CRDT items.
 * Structure: { client: number, clock: number }
 * @see https://docs.yjs.dev/api/internals
 */
export const yjsIdValidator = v.object({
	client: v.number(),
	clock: v.number(),
});

/**
 * Yjs RelativePosition JSON validator - encodes cursor positions that survive
 * concurrent edits. Fields are nullable because the raw RelativePosition object
 * stores them as `ID | null`, and JSON.stringify preserves null values.
 * Fields are also optional since relativePositionToJSON() omits falsy fields.
 *
 * @see https://docs.yjs.dev/api/relative-positions
 */
export const relativePositionValidator = v.object({
	type: v.optional(v.nullable(yjsIdValidator)),
	tname: v.optional(v.nullable(v.string())),
	item: v.optional(v.nullable(yjsIdValidator)),
	assoc: v.optional(v.nullable(v.number())),
});

/**
 * Cursor validator for collaborative editing positions.
 * Tracks anchor/head selection positions using Yjs RelativePosition JSON format
 * and optional field context for multi-field documents.
 */
export const cursorValidator = v.object({
	anchor: relativePositionValidator,
	head: relativePositionValidator,
	field: v.optional(v.string()),
});

// ============================================================================
// ProseMirror Structure Validators
// ============================================================================

/**
 * ProseMirror mark validator (bold, italic, link, etc.)
 * Attrs must remain v.any() due to plugin extensibility.
 */
export const proseMarkValidator = v.object({
	type: v.string(),
	attrs: v.optional(v.record(v.string(), v.any())),
});

/**
 * ProseMirror node validator (paragraph, heading, list, etc.)
 * Content is recursive (nodes contain nodes), so we use v.any() for content array.
 * Attrs must remain v.any() due to plugin extensibility.
 */
export const proseNodeValidator = v.object({
	type: v.string(),
	attrs: v.optional(v.record(v.string(), v.any())),
	content: v.optional(v.array(v.any())), // Recursive - contains proseNodeValidator
	text: v.optional(v.string()),
	marks: v.optional(v.array(proseMarkValidator)),
});

/**
 * Prose validator for ProseMirror-compatible rich text JSON.
 * Used for collaborative rich text editing fields.
 * Root must be a 'doc' node containing an array of block nodes.
 */
export const proseValidator = v.object({
	type: v.literal('doc'),
	content: v.optional(v.array(proseNodeValidator)),
});

// ============================================================================
// Stream/Sync Validators
// ============================================================================

/**
 * Stream change type - the kind of CRDT operation stored in the stream.
 * 'delta' = incremental Yjs update, 'snapshot' = full document state.
 */
export const streamChangeTypeValidator = v.union(v.literal('delta'), v.literal('snapshot'));

/**
 * Individual change in a stream response.
 */
export const streamChangeValidator = v.object({
	document: v.string(),
	bytes: v.bytes(),
	seq: v.number(),
	type: streamChangeTypeValidator,
});

/**
 * Extended stream change with existence flag (used in server responses).
 */
export const streamChangeWithExistsValidator = v.object({
	document: v.string(),
	bytes: v.bytes(),
	seq: v.number(),
	type: streamChangeTypeValidator,
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
		})
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
		})
	),
});

// ============================================================================
// Session/Presence Validators
// ============================================================================

/**
 * Session record for presence tracking.
 * Returned by sessions query.
 */
export const sessionValidator = v.object({
	client: v.string(),
	document: v.string(),
	user: v.optional(v.string()),
	profile: v.optional(profileValidator),
	cursor: v.optional(cursorValidator),
	seen: v.number(),
});

/**
 * Presence action (join or leave).
 * @deprecated Use sessionActionValidator instead
 */
export const presenceActionValidator = v.union(v.literal('join'), v.literal('leave'));

// ============================================================================
// New API Validators (Phase 1: signals.md migration)
// ============================================================================

/**
 * Replicate mutation type - combines insert/update/delete.
 */
export const replicateTypeValidator = v.union(
	v.literal('insert'),
	v.literal('update'),
	v.literal('delete')
);

/**
 * Session action - combines presence (join/leave) and mark (mark/signal).
 */
export const sessionActionValidator = v.union(
	v.literal('join'),
	v.literal('leave'),
	v.literal('mark'),
	v.literal('signal')
);

// ============================================================================
// Mutation Result Validators
// ============================================================================

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
	v.null()
);

// ============================================================================
// SSR/Material Validators
// ============================================================================

/**
 * SSR material query result (non-paginated, backward compatible).
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
			})
		)
	),
	cursor: v.optional(v.number()),
});

// ============================================================================
// Derived Types (Single Source of Truth)
// ============================================================================

/** Yjs ID (client, clock). */
export type YjsId = Infer<typeof yjsIdValidator>;

/** Yjs RelativePosition JSON form. */
export type RelativePosition = Infer<typeof relativePositionValidator>;

/** User profile for presence/identity. */
export type Profile = Infer<typeof profileValidator>;

/** Cursor position for collaborative editing. */
export type Cursor = Infer<typeof cursorValidator>;

/** ProseMirror mark (bold, italic, etc.). */
export type ProseMark = Infer<typeof proseMarkValidator>;

/** ProseMirror node (paragraph, heading, etc.). */
export type ProseNode = Infer<typeof proseNodeValidator>;

/** ProseMirror-compatible JSON structure. */
export type ProseValue = Infer<typeof proseValidator>;

/** Stream change type. */
export type StreamChangeType = Infer<typeof streamChangeTypeValidator>;

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

/** Replicate mutation type. */
export type ReplicateType = Infer<typeof replicateTypeValidator>;

/** Session action type. */
export type SessionAction = Infer<typeof sessionActionValidator>;

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

// ============================================================================
// Additional Types (from types.ts)
// ============================================================================

export interface FragmentValue {
	__xmlFragment: true;
	content?: XmlFragmentJSON;
}

export interface XmlFragmentJSON {
	type: 'doc';
	content?: XmlNodeJSON[];
}

export interface XmlNodeJSON {
	type: string;
	attrs?: Record<string, unknown>;
	content?: XmlNodeJSON[];
	text?: string;
	marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** Operation type for streaming changes */
export enum OperationType {
	Delta = 'delta',
	Snapshot = 'snapshot',
}

/**
 * Extract prose field names from T (fields typed as ProseValue).
 * Used internally for type-safe prose field operations.
 */
export type ProseFields<T> = {
	[K in keyof T]: T[K] extends ProseValue ? K : never;
}[keyof T];

// ============================================================================
// Duration Utilities
// ============================================================================

type DurationUnit = 'm' | 'h' | 'd';
export type Duration = `${number}${DurationUnit}`;

export interface CompactionConfig {
	threshold?: number;
	timeout?: Duration;
	retain?: number;
}

const DURATION_MULTIPLIERS: Record<DurationUnit, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

export function parseDuration(s: Duration): number {
	const match = /^(\d+)(m|h|d)$/i.exec(s);
	if (!match) throw new Error(`Invalid duration: ${s}`);
	const [, num, unit] = match;
	return parseInt(num) * DURATION_MULTIPLIERS[unit.toLowerCase() as DurationUnit];
}
