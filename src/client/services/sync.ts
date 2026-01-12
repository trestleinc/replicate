import * as Y from "yjs";
import { getLogger } from "$/client/logger";

const logger = getLogger(["replicate", "sync"]);

export interface DocumentSync {
	onLocalChange(): void;
	onServerUpdate(): void;
	isPending(): boolean;
	onPendingChange(callback: (pending: boolean) => void): () => void;
	destroy(): void;
}

export function createDocumentSync(
	documentId: string,
	ydoc: Y.Doc,
	syncFn: () => Promise<void>,
	debounceMs = 200,
): DocumentSync {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let pending = false;
	let destroyed = false;
	const pendingListeners = new Set<(pending: boolean) => void>();

	const setPending = (value: boolean) => {
		if (pending !== value) {
			pending = value;
			pendingListeners.forEach(cb => cb(value));
		}
	};

	const performSync = async () => {
		if (destroyed) return;

		// Validate Y.Doc before sync
		if (!ydoc || (ydoc as unknown as { destroyed?: boolean }).destroyed) {
			logger.error("Cannot sync - Y.Doc is destroyed", { documentId });
			setPending(false);
			return;
		}

		try {
			await syncFn();
		} catch (error) {
			logger.error("Sync failed", {
				documentId,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setPending(false);
		}
	};

	return {
		onLocalChange() {
			if (destroyed) return;
			if (timeoutId) clearTimeout(timeoutId);
			setPending(true);
			timeoutId = setTimeout(performSync, debounceMs);
		},

		onServerUpdate() {
			// Server updates don't require action - Yjs handles merging
			// This is kept for API compatibility if needed in future
		},

		isPending() {
			return pending;
		},

		onPendingChange(callback: (pending: boolean) => void) {
			pendingListeners.add(callback);
			return () => pendingListeners.delete(callback);
		},

		destroy() {
			destroyed = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			pendingListeners.clear();
		},
	};
}

// Per-collection sync managers to avoid cross-collection conflicts
const collectionSyncs = new Map<string, Map<string, DocumentSync>>();

function getSyncsForCollection(collection: string): Map<string, DocumentSync> {
	let syncs = collectionSyncs.get(collection);
	if (!syncs) {
		syncs = new Map();
		collectionSyncs.set(collection, syncs);
	}
	return syncs;
}

export function createSyncManager(collection: string) {
	const syncs = getSyncsForCollection(collection);

	return {
		register(
			documentId: string,
			ydoc: Y.Doc,
			syncFn: () => Promise<void>,
			debounceMs?: number,
		): DocumentSync {
			const existing = syncs.get(documentId);
			if (existing) return existing;

			const sync = createDocumentSync(documentId, ydoc, syncFn, debounceMs);
			syncs.set(documentId, sync);
			logger.debug("Sync registered", { collection, documentId });
			return sync;
		},

		get(documentId: string): DocumentSync | null {
			return syncs.get(documentId) ?? null;
		},

		unregister(documentId: string): void {
			const sync = syncs.get(documentId);
			if (sync) {
				sync.destroy();
				syncs.delete(documentId);
				logger.debug("Sync unregistered", { collection, documentId });
			}
		},

		destroy(): void {
			for (const [, sync] of syncs) {
				sync.destroy();
			}
			syncs.clear();
			collectionSyncs.delete(collection);
			logger.debug("Sync manager destroyed", { collection });
		},
	};
}

export type SyncManager = ReturnType<typeof createSyncManager>;
