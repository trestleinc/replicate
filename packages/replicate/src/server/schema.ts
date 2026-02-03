/**
 * Server Schema Helpers
 *
 * CRDT type factories for server-side schema definition.
 */

import { v } from 'convex/values';
import type { GenericValidator } from 'convex/values';
import { CRDT_MARKER, type CrdtType, type CrdtValidator, type Conflict } from '$/shared/crdt';
import { proseValidator } from '$/shared';

/**
 * Helper to mark a validator as a CRDT type.
 */
const markCrdt = <T extends GenericValidator>(
	validator: T,
	type: CrdtType,
	resolve?: (conflict: unknown) => unknown
): CrdtValidator =>
	Object.assign(validator, {
		[CRDT_MARKER]: { type, resolve },
	}) as CrdtValidator;

/**
 * Default resolve function: picks value with latest timestamp.
 */
const defaultResolve = <T>(conflict: Conflict<T>): T => conflict.latest();

/**
 * Counter CRDT - sum-based counter that never loses increments.
 *
 * Storage format: Array of delta operations from each client.
 * Final value is computed by summing all deltas.
 *
 * @example
 * shape: v.object({
 *   viewCount: schema.counter(),
 * })
 */
export const counter = (): CrdtValidator =>
	markCrdt(
		v.optional(
			v.array(
				v.object({
					client: v.string(),
					delta: v.number(),
					timestamp: v.number(),
				})
			)
		),
		'counter'
	);

/**
 * Register CRDT - multi-value register with custom conflict resolution.
 *
 * Each client's value is preserved until resolved.
 * Defaults to latest() resolver if not provided.
 *
 * @example
 * shape: v.object({
 *   status: schema.register(v.string(), {
 *     resolve: (conflict) => conflict.latest()
 *   }),
 * })
 */
export const register = <T>(
	validator: GenericValidator,
	options?: { resolve?: (conflict: Conflict<T>) => T }
): CrdtValidator =>
	markCrdt(
		v.record(
			v.string(),
			v.object({
				timestamp: v.number(),
				value: validator,
			})
		),
		'register',
		(options?.resolve ?? defaultResolve) as (conflict: unknown) => unknown
	);

/**
 * Set CRDT - add-wins set for collections.
 *
 * Concurrent adds are unioned. Remove only wins if after add.
 * Storage format: Record with JSON-stringified items as keys,
 * each mapping to metadata about who added it and when.
 *
 * @example
 * shape: v.object({
 *   tags: schema.set(v.string()),
 * })
 */
export const set = (_validator: GenericValidator): CrdtValidator =>
	markCrdt(
		v.optional(
			v.record(
				v.string(), // JSON-stringified item as key
				v.object({
					addedBy: v.string(),
					addedAt: v.number(),
				})
			)
		),
		'set'
	);

/**
 * Prose CRDT - rich text with character-level merging.
 *
 * @example
 * shape: v.object({
 *   description: schema.prose(),
 * })
 */
export const prose = (): CrdtValidator => markCrdt(proseValidator, 'prose');
