/**
 * Shared Sync Registry for CRDT Bindings
 *
 * Provides per-collection sync manager instances shared across
 * counter, set, and other CRDT bindings.
 */

import { createSyncManager, type SyncManager } from '$/client/services/sync';
import { getLogger } from '$/shared/logger';

const logger = getLogger(['replicate', 'sync-registry']);

// Per-collection sync managers shared across all binding types
const syncManagers = new Map<string, SyncManager>();

/**
 * Get or create a sync manager for a collection.
 * Shared across all CRDT binding types (counter, set, register, etc.).
 */
export function getSyncManager(collection: string): SyncManager {
	let manager = syncManagers.get(collection);
	if (!manager) {
		manager = createSyncManager(collection);
		syncManagers.set(collection, manager);
		logger.debug('Created sync manager', { collection });
	}
	return manager;
}

/**
 * Clean up the sync manager for a collection.
 * Call when the collection is destroyed.
 */
export function cleanupSyncManager(collection: string): void {
	const manager = syncManagers.get(collection);
	if (manager) {
		manager.destroy();
		syncManagers.delete(collection);
		logger.debug('Cleaned up sync manager', { collection });
	}
}

/**
 * Check if a collection has an active sync manager.
 */
export function hasSyncManager(collection: string): boolean {
	return syncManagers.has(collection);
}
