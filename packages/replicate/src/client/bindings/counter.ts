/**
 * Counter CRDT Binding
 *
 * Sum-based counter that never loses concurrent increments.
 * Uses Y.Array to store delta operations.
 */

import * as Y from 'yjs';
import type { Collection } from '@tanstack/db';
import { getLogger } from '$/shared/logger';
import { hasContext } from '$/client/services/context';
import { getSyncManager, cleanupSyncManager } from './sync-registry';

const SERVER_ORIGIN = 'server';

const logger = getLogger(['replicate', 'counter']);

/**
 * Delta entry stored in Y.Array.
 */
export interface CounterDelta {
	client: string;
	delta: number;
	timestamp: number;
}

/**
 * Counter binding interface.
 */
export interface CounterBinding {
	/** Get current counter value (sum of all deltas). */
	value(): number;

	/** Increment counter by delta (default: 1). */
	increment(delta?: number): void;

	/** Decrement counter by delta (default: 1). */
	decrement(delta?: number): void;

	/** Subscribe to value changes. */
	subscribe(callback: (value: number) => void): () => void;

	/** Whether there are pending local changes. */
	readonly pending: boolean;

	/** Subscribe to pending state changes. */
	onPendingChange(callback: (pending: boolean) => void): () => void;

	/** Clean up resources. */
	destroy(): void;
}

/**
 * Configuration for counter binding.
 */
export interface CounterBindingConfig {
	collection: string;
	document: string;
	field: string;
	array: Y.Array<CounterDelta>;
	ydoc: Y.Doc;
	ymap: Y.Map<unknown>;
	collectionRef: Collection<any>;
	clientId: string;
	debounceMs?: number;
	getMaterial: () => Record<string, unknown> | null;
}


/**
 * Compute counter value by summing all deltas.
 */
function computeValue(array: Y.Array<CounterDelta>): number {
	return array.toArray().reduce((sum, entry) => sum + entry.delta, 0);
}

/**
 * Create sync function for counter.
 */
function createSyncFn(
	document: string,
	ydoc: Y.Doc,
	collectionRef: Collection<any>,
	getMaterial: () => Record<string, unknown> | null
): () => Promise<void> {
	return async () => {
		const delta = Y.encodeStateAsUpdateV2(ydoc);
		const bytes = delta.buffer as ArrayBuffer;
		const material = getMaterial();
		collectionRef.update(
			document,
			{ metadata: { contentSync: { bytes, material } } },
			(draft: { timestamp: number }) => {
				draft.timestamp = Date.now();
			}
		);
	};
}

/**
 * Create a counter binding.
 */
export function createCounterBinding(config: CounterBindingConfig): CounterBinding {
	const { collection, document, field, array, ydoc, collectionRef, clientId, debounceMs, getMaterial } = config;

	if (!hasContext(collection)) {
		logger.warn('Cannot create counter binding - collection not initialized', {
			collection,
			document,
		});
		return {
			value: () => 0,
			increment: () => undefined,
			decrement: () => undefined,
			subscribe: () => () => undefined,
			pending: false,
			onPendingChange: () => () => undefined,
			destroy: () => undefined,
		};
	}

	const subscribers = new Set<(value: number) => void>();
	const syncManager = getSyncManager(collection);
	const syncKey = `${document}:counter:${field}`;

	const syncFn = createSyncFn(document, ydoc, collectionRef, getMaterial);
	const sync = syncManager.register(syncKey, ydoc, syncFn, debounceMs);

	/**
	 * Notify all subscribers of current value.
	 */
	const notifySubscribers = () => {
		const value = computeValue(array);
		subscribers.forEach((cb) => cb(value));
	};

	/**
	 * Observer handler for Y.Array changes.
	 */
	const observerHandler = (_event: Y.YArrayEvent<CounterDelta>, transaction: Y.Transaction) => {
		if (transaction.origin === SERVER_ORIGIN) {
			notifySubscribers();
			return;
		}
		sync.onLocalChange();
		notifySubscribers();
	};

	array.observe(observerHandler);

	return {
		value(): number {
			return computeValue(array);
		},

		increment(delta = 1): void {
			if (delta === 0) return;
			const entry: CounterDelta = {
				client: clientId,
				delta: Math.abs(delta),
				timestamp: Date.now(),
			};
			ydoc.transact(() => array.push([entry]), 'local');
		},

		decrement(delta = 1): void {
			if (delta === 0) return;
			const entry: CounterDelta = {
				client: clientId,
				delta: -Math.abs(delta),
				timestamp: Date.now(),
			};
			ydoc.transact(() => array.push([entry]), 'local');
		},

		subscribe(callback): () => void {
			subscribers.add(callback);
			callback(computeValue(array));
			return () => subscribers.delete(callback);
		},

		get pending(): boolean {
			return sync.isPending();
		},

		onPendingChange(callback): () => void {
			return sync.onPendingChange(callback);
		},

		destroy(): void {
			array.unobserve(observerHandler);
			syncManager.unregister(syncKey);
			subscribers.clear();
			logger.debug('Counter binding destroyed', { collection, document, field });
		},
	};
}

/**
 * Clean up all counter bindings for a collection.
 */
export function cleanup(collection: string): void {
	cleanupSyncManager(collection);
	logger.debug('Counter cleanup complete', { collection });
}
