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
	type: v.literal('doc'),
	content: v.optional(v.array(v.any())),
});

// ============================================================================
// Stream/Sync Validators
// ============================================================================

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
	profile: v.optional(v.any()),
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

export { getLogger, type Logger } from './logger';
