/**
 * Register CRDT Binding
 *
 * Multi-value register with custom conflict resolution.
 * Each client's value is preserved until resolved.
 */

import * as Y from 'yjs';
import { getLogger } from '$/shared/logger';
import type { Conflict, ResolveFn } from '$/shared/crdt';

const logger = getLogger(['replicate', 'register']);

/**
 * Entry stored per client in register.
 */
export interface RegisterEntry<T> {
	value: T;
	timestamp: number;
}

/**
 * Register binding interface.
 */
export interface RegisterBinding<T> {
	/** Get resolved value using the resolve function. */
	value(): T;

	/** Get all concurrent values. */
	values(): T[];

	/** Check if there are multiple concurrent values. */
	hasConflict(): boolean;

	/** Get conflict info (null if no conflict). */
	conflict(): Conflict<T> | null;

	/** Set value for current client. */
	set(value: T): void;

	/** Subscribe to changes. */
	subscribe(callback: (value: T, conflict: Conflict<T> | null) => void): () => void;

	/** Clean up resources. */
	destroy(): void;
}

/**
 * Configuration for register binding.
 */
export interface RegisterBindingConfig<T> {
	ymap: Y.Map<RegisterEntry<T>>;
	clientId: string;
	resolve?: ResolveFn<T>;
	onLocalChange?: () => void;
}

/**
 * Create a Conflict object from register entries.
 */
function createConflict<T>(
	entries: Array<{ value: T; clientId: string; timestamp: number }>
): Conflict<T> {
	return {
		values: entries.map((e) => e.value),
		entries,
		latest() {
			if (entries.length === 0) {
				throw new Error('Cannot get latest from empty conflict');
			}
			return entries.reduce((a, b) => (b.timestamp > a.timestamp ? b : a)).value;
		},
		byClient(id: string) {
			return entries.find((e) => e.clientId === id)?.value;
		},
	};
}

/**
 * Extract all entries from register Y.Map.
 */
function extractEntries<T>(
	ymap: Y.Map<RegisterEntry<T>>
): Array<{ value: T; clientId: string; timestamp: number }> {
	const entries: Array<{ value: T; clientId: string; timestamp: number }> = [];

	ymap.forEach((entry, clientId) => {
		if (entry && typeof entry === 'object' && 'value' in entry && 'timestamp' in entry) {
			entries.push({
				value: entry.value,
				clientId,
				timestamp: entry.timestamp,
			});
		}
	});

	return entries;
}

/**
 * Default resolve function: picks latest by timestamp.
 */
const defaultResolve = <T>(conflict: Conflict<T>): T => conflict.latest();

/**
 * Create a register binding.
 */
export function createRegisterBinding<T>(config: RegisterBindingConfig<T>): RegisterBinding<T> {
	const { ymap, clientId, resolve, onLocalChange } = config;

	// Use provided resolve or default to latest()
	const resolveFn = resolve ?? defaultResolve;

	const subscribers = new Set<(value: T, conflict: Conflict<T> | null) => void>();
	let destroyed = false;

	const getEntries = () => extractEntries(ymap);

	const getConflict = (): Conflict<T> | null => {
		const entries = getEntries();
		return entries.length <= 1 ? null : createConflict(entries);
	};

	const getValue = (): T => {
		const entries = getEntries();

		if (entries.length === 0) {
			// No value set - return resolved empty conflict
			return resolveFn(createConflict([]));
		}

		if (entries.length === 1) {
			return entries[0].value;
		}

		// Multiple values - resolve conflict
		return resolveFn(createConflict(entries));
	};

	const notifySubscribers = () => {
		if (destroyed) return;
		const value = getValue();
		const conflict = getConflict();
		for (const callback of subscribers) {
			try {
				callback(value, conflict);
			} catch (error) {
				logger.error('Register subscriber error', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	};

	// Observe Y.Map changes
	ymap.observe(notifySubscribers);

	return {
		value(): T {
			if (destroyed) throw new Error('RegisterBinding destroyed');
			return getValue();
		},

		values(): T[] {
			if (destroyed) throw new Error('RegisterBinding destroyed');
			return getEntries().map((e) => e.value);
		},

		hasConflict(): boolean {
			if (destroyed) throw new Error('RegisterBinding destroyed');
			return getEntries().length > 1;
		},

		conflict(): Conflict<T> | null {
			if (destroyed) throw new Error('RegisterBinding destroyed');
			return getConflict();
		},

		set(value: T): void {
			if (destroyed) throw new Error('RegisterBinding destroyed');

			const entry: RegisterEntry<T> = {
				value,
				timestamp: Date.now(),
			};

			ymap.set(clientId, entry);
			onLocalChange?.();

			logger.debug('Register value set', {
				clientId,
				hasConflict: getEntries().length > 1,
			});
		},

		subscribe(callback): () => void {
			if (destroyed) throw new Error('RegisterBinding destroyed');

			subscribers.add(callback);
			// Immediately call with current value
			callback(getValue(), getConflict());

			return () => {
				subscribers.delete(callback);
			};
		},

		destroy(): void {
			if (destroyed) return;
			destroyed = true;
			ymap.unobserve(notifySubscribers);
			subscribers.clear();
			logger.debug('Register binding destroyed', { clientId });
		},
	};
}

/**
 * Clean up register bindings.
 * No global state to clean up for registers.
 */
export function cleanup(): void {
	// Registers don't have global state
}
