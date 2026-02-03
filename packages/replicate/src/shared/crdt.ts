/**
 * CRDT Type System
 *
 * Unified type definitions for Conflict-free Replicated Data Types.
 * Uses Symbol markers for runtime detection and Map-based dispatch.
 */

import type { GenericValidator } from 'convex/values';

/**
 * CRDT type discriminated union.
 */
export type CrdtType = 'counter' | 'register' | 'set' | 'prose';

/**
 * Symbol marker for CRDT validators.
 * Used for runtime detection without string matching.
 */
export const CRDT_MARKER = Symbol.for('@trestleinc/replicate:crdt');

/**
 * CRDT validator type with marker.
 * Intersection type works better with GenericValidator than interface extension.
 */
export type CrdtValidator = GenericValidator & {
	[CRDT_MARKER]: {
		type: CrdtType;
		resolve?: (conflict: unknown) => unknown;
	};
};

/**
 * Type guard for CRDT validators.
 */
export const isCrdtValidator = (v: GenericValidator): v is CrdtValidator => {
	return CRDT_MARKER in (v as object);
};

/**
 * Extract CRDT type from validator.
 */
export const getCrdtType = (v: CrdtValidator): CrdtType => v[CRDT_MARKER].type;

/**
 * Exhaustiveness checker for discriminated unions.
 * Throws at runtime if an unhandled case is encountered.
 */
export const assertNever = (value: never): never => {
	throw new Error(`Unhandled CRDT type: ${JSON.stringify(value)}`);
};

/**
 * Field metadata with discriminated union for type-specific data.
 */
export interface CrdtFieldInfo {
	field: string;
	type: CrdtType;
	resolve?: (conflict: unknown) => unknown;
}

/**
 * Conflict information for register fields.
 */
export interface Conflict<T> {
	values: T[];
	entries: Array<{
		value: T;
		clientId: string;
		timestamp: number;
	}>;
	latest(): T;
	byClient(id: string): T | undefined;
}

/**
 * Resolve function type for registers.
 */
export type ResolveFn<T> = (conflict: Conflict<T>) => T;
