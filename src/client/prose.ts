import * as Y from "yjs";
import type { Collection } from "@tanstack/db";
import { getLogger } from "$/client/logger";
import { serializeYMapValue } from "$/client/merge";
import { getContext, hasContext } from "$/client/services/context";
import { createSyncManager, type SyncManager } from "$/client/services/sync";

const SERVER_ORIGIN = "server";
const noop = (): void => undefined;

const logger = getLogger(["replicate", "prose"]);

// Per-collection sync managers
const syncManagers = new Map<string, SyncManager>();

function getSyncManager(collection: string): SyncManager {
	let manager = syncManagers.get(collection);
	if (!manager) {
		manager = createSyncManager(collection);
		syncManagers.set(collection, manager);
	}
	return manager;
}

export interface ProseObserverConfig {
	collection: string;
	document: string;
	field: string;
	fragment: Y.XmlFragment;
	ydoc: Y.Doc;
	ymap: Y.Map<unknown>;
	collectionRef: Collection<any>;
	debounceMs?: number;
}

function createSyncFn(
	document: string,
	ydoc: Y.Doc,
	ymap: Y.Map<unknown>,
	collectionRef: Collection<any>,
): () => Promise<void> {
	return async () => {
		const material = serializeYMapValue(ymap);
		const delta = Y.encodeStateAsUpdateV2(ydoc);
		const bytes = delta.buffer as ArrayBuffer;

		const result = collectionRef.update(
			document,
			{ metadata: { contentSync: { bytes, material } } },
			(draft: any) => {
				draft.timestamp = Date.now();
			},
		);
		await result.isPersisted.promise;
	};
}

export function observeFragment(config: ProseObserverConfig): () => void {
	const { collection, document, field, fragment, ydoc, ymap, collectionRef, debounceMs } = config;

	if (!hasContext(collection)) {
		logger.warn("Cannot observe fragment - collection not initialized", { collection, document });
		return noop;
	}

	const ctx = getContext(collection);

	const existingCleanup = ctx.fragmentObservers.get(document);
	if (existingCleanup) {
		logger.debug("Fragment already being observed", { collection, document, field });
		return existingCleanup;
	}

	const syncFn = createSyncFn(document, ydoc, ymap, collectionRef);
	const syncManager = getSyncManager(collection);

	// Register sync - this is synchronous, no error handling needed
	const sync = syncManager.register(document, ydoc, syncFn, debounceMs);
	logger.debug("Fragment observer registered", { collection, document, field });

	const observerHandler = (_events: Y.YEvent<any>[], transaction: Y.Transaction) => {
		if (transaction.origin === SERVER_ORIGIN) {
			return;
		}

		// Trigger local change sync
		sync.onLocalChange();
	};

	fragment.observeDeep(observerHandler);

	const cleanup = () => {
		fragment.unobserveDeep(observerHandler);
		syncManager.unregister(document);
		ctx.fragmentObservers.delete(document);
		logger.debug("Fragment observer cleaned up", { collection, document, field });
	};

	ctx.fragmentObservers.set(document, cleanup);

	return cleanup;
}

export function isPending(collection: string, document: string): boolean {
	const syncManager = syncManagers.get(collection);
	if (!syncManager) return false;

	const sync = syncManager.get(document);
	return sync?.isPending() ?? false;
}

export function subscribePending(
	collection: string,
	document: string,
	callback: (pending: boolean) => void,
): () => void {
	const syncManager = syncManagers.get(collection);
	if (!syncManager) return noop;

	const sync = syncManager.get(document);
	if (!sync) return noop;

	return sync.onPendingChange(callback);
}

export function cleanup(collection: string): void {
	const syncManager = syncManagers.get(collection);
	if (syncManager) {
		syncManager.destroy();
		syncManagers.delete(collection);
	}

	if (!hasContext(collection)) return;
	const ctx = getContext(collection);

	for (const [, cleanupFn] of ctx.fragmentObservers) {
		cleanupFn();
	}
	ctx.fragmentObservers.clear();

	logger.debug("Prose cleanup complete", { collection });
}
