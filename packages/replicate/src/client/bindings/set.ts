/**
 * Set CRDT Binding
 *
 * Add-wins set for collections. Concurrent adds are unioned.
 * Remove only wins if it happened after the add.
 */

import * as Y from 'yjs';
import type { Collection } from '@tanstack/db';
import { getLogger } from '$/shared/logger';
import { hasContext } from '$/client/services/context';
import { getSyncManager, cleanupSyncManager } from './sync-registry';

const SERVER_ORIGIN = 'server';

const logger = getLogger(['replicate', 'set']);

/**
 * Metadata stored per item in the set.
 */
export interface SetEntry {
	addedBy: string;
	addedAt: number;
}

/**
 * Set binding interface.
 */
export interface SetBinding<T> {
	/** Get all active items in the set. */
	values(): T[];

	/** Check if an item is in the set. */
	has(item: T): boolean;

	/** Add an item to the set. */
	add(item: T): void;

	/** Remove an item from the set. */
	remove(item: T): void;

	/** Subscribe to set changes. */
	subscribe(callback: (values: T[]) => void): () => void;

	/** Clean up resources. */
	destroy(): void;
}

/**
 * Configuration for set binding.
 */
export interface SetBindingConfig<T> {
	collection: string;
	document: string;
	field: string;
	ymap: Y.Map<SetEntry>;
	ydoc: Y.Doc;
	fieldsMap: Y.Map<unknown>;
	collectionRef: Collection<any>;
	clientId: string;
	serialize: (item: T) => string;
	deserialize: (key: string) => T;
	debounceMs?: number;
	getMaterial: () => Record<string, unknown> | null;
}


/**
 * Create sync function for set.
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
 * Create a set binding.
 */
export function createSetBinding<T>(config: SetBindingConfig<T>): SetBinding<T> {
	const {
		collection,
		document,
		field,
		ymap,
		ydoc,
		collectionRef,
		clientId,
		serialize,
		deserialize,
		debounceMs = 50,
		getMaterial,
	} = config;

	if (!hasContext(collection)) {
		logger.warn('Cannot create set binding - collection not initialized', {
			collection,
			document,
		});
		return {
			values: () => [],
			has: () => false,
			add: () => undefined,
			remove: () => undefined,
			subscribe: () => () => undefined,
			destroy: () => undefined,
		};
	}

	const subscribers = new Set<(values: T[]) => void>();
	let destroyed = false;

	const syncManager = getSyncManager(collection);
	const syncKey = `${document}:set:${field}`;
	const syncFn = createSyncFn(document, ydoc, collectionRef, getMaterial);
	const sync = syncManager.register(syncKey, ydoc, syncFn, debounceMs);

	/**
	 * Get all values from the set.
	 */
	const getValues = (): T[] => {
		const items: T[] = [];
		ymap.forEach((_, key) => {
			items.push(deserialize(key));
		});
		return items;
	};

	/**
	 * Notify all subscribers.
	 */
	const notifySubscribers = () => {
		if (destroyed) return;
		const values = getValues();
		subscribers.forEach((cb) => {
			try {
				cb(values);
			} catch (error) {
				logger.error('Set subscriber error', {
					collection,
					document,
					field,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	};

	/**
	 * Observer handler for Y.Map changes.
	 */
	const observerHandler = (
		_events: Y.YEvent<Y.AbstractType<Y.YEvent<Y.AbstractType<unknown>>>>[],
		transaction: Y.Transaction
	) => {
		notifySubscribers();
		if (transaction.origin !== SERVER_ORIGIN) {
			sync.onLocalChange();
		}
	};

	ymap.observeDeep(observerHandler);

	logger.debug('Set binding created', { collection, document, field });

	return {
		values(): T[] {
			return getValues();
		},

		has(item: T): boolean {
			return ymap.has(serialize(item));
		},

		add(item: T): void {
			if (destroyed) return;
			const key = serialize(item);
			ydoc.transact(() => {
				const entry: SetEntry = {
					addedBy: clientId,
					addedAt: Date.now(),
				};
				ymap.set(key, entry);
			}, 'local');
			logger.debug('Set item added', { collection, document, field, key });
		},

		remove(item: T): void {
			if (destroyed) return;
			const key = serialize(item);
			ydoc.transact(() => {
				ymap.delete(key);
			}, 'local');
			logger.debug('Set item removed', { collection, document, field, key });
		},

		subscribe(callback): () => void {
			subscribers.add(callback);
			callback(getValues());
			return () => subscribers.delete(callback);
		},

		destroy(): void {
			if (destroyed) return;
			destroyed = true;
			ymap.unobserveDeep(observerHandler);
			syncManager.unregister(syncKey);
			subscribers.clear();
			logger.debug('Set binding destroyed', { collection, document, field });
		},
	};
}

/**
 * Clean up all set bindings for a collection.
 */
export function cleanup(collection: string): void {
	cleanupSyncManager(collection);
	logger.debug('Set bindings cleanup complete', { collection });
}
