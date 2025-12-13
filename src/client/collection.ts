import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { set as idbSet } from 'idb-keyval';
import { createMutex } from 'lib0/mutex';
import {
  startOfflineExecutor,
  NonRetriableError,
  type OfflineExecutor,
} from '@tanstack/offline-transactions';
import type { ConvexClient } from 'convex/browser';
import type { FunctionReference } from 'convex/server';
import type { CollectionConfig, Collection } from '@tanstack/db';
import { Effect, Layer } from 'effect';
import { getLogger } from '$/client/logger.js';
import { ProseError } from '$/client/errors.js';
import { ensureSet } from '$/client/set.js';
import { Checkpoint, CheckpointLive } from '$/client/services/checkpoint.js';
import { Reconciliation, ReconciliationLive } from '$/client/services/reconciliation.js';
import { SnapshotLive } from '$/client/services/snapshot.js';
import { Protocol, ProtocolLive } from '$/client/services/protocol.js';
import {
  initializeReplicateParams,
  replicateDelete,
  replicateUpsert,
  replicateReplace,
} from '$/client/replicate.js';
import {
  createYjsDocument,
  getYMap,
  transactWithDelta,
  applyUpdate,
  extractItems,
  extractItem,
  isDoc,
  fragmentFromJSON,
  serializeYMapValue,
  getFragmentFromYMap,
} from '$/client/merge.js';
import type { ProseFields, XmlFragmentJSON } from '$/shared/types.js';

const logger = getLogger(['replicate', 'collection']);

interface HttpError extends Error {
  status?: number;
}

/** Mutation data passed by TanStack DB transaction handlers */
interface CollectionMutation<T> {
  key: string | number;
  modified: T;
  original?: T | Record<string, never>;
  changes?: Partial<T>;
}

/** Metadata for content sync operations */
interface ContentSyncMetadata {
  crdtBytes: ArrayBuffer;
  materializedDoc: unknown;
}

/** Transaction wrapper containing mutations array */
interface CollectionTransaction<T> {
  transaction: {
    mutations: CollectionMutation<T>[];
    metadata?: { contentSync?: ContentSyncMetadata };
  };
}

function handleMutationError(
  error: unknown,
  operation: 'Insert' | 'Update' | 'Delete',
  collection: string
): never {
  const httpError = error as HttpError;
  logger.error(`${operation} failed`, {
    collection,
    error: httpError?.message,
    status: httpError?.status,
  });

  if (httpError?.status === 401 || httpError?.status === 403) {
    throw new NonRetriableError('Authentication failed');
  }
  if (httpError?.status === 422) {
    throw new NonRetriableError('Validation error');
  }
  throw error;
}

const servicesLayer = Layer.mergeAll(
  CheckpointLive,
  ReconciliationLive,
  Layer.provide(SnapshotLive, CheckpointLive)
);

const cleanupFunctions = new Map<string, () => void>();

// Track which document's fragment is currently being edited, per collection
const activeFragmentDoc = new Map<string, string>(); // collection -> documentId

// Track fragment sync handlers per collection:documentId
const fragmentSyncHandlers = new Map<string, () => void>();

/** Origin markers for Yjs transactions - used for undo tracking and debugging */
export enum YjsOrigin {
  Insert = 'insert',
  Update = 'update',
  Remove = 'remove',
  FragmentEdit = 'fragment-edit',

  Subscription = 'subscription',
  Snapshot = 'snapshot',
  SSRInit = 'ssr-init',
}

/** Server-rendered material data for SSR hydration */
export type Materialized<T> = {
  documents: ReadonlyArray<T>;
  checkpoint?: { lastModified: number };
  count?: number;
  crdtBytes?: ArrayBuffer;
};

/** Configuration for creating a Convex-backed collection */
export interface ConvexCollectionOptionsConfig<T extends object> {
  getKey: (item: T) => string | number;
  material?: Materialized<T>;
  convexClient: ConvexClient;
  api: {
    stream: FunctionReference<'query'>;
    insert: FunctionReference<'mutation'>;
    update: FunctionReference<'mutation'>;
    remove: FunctionReference<'mutation'>;
    protocol?: FunctionReference<'query'>;
    material?: FunctionReference<'query'>;
    [key: string]: any;
  };
  collection: string;
  /** Fields that contain prose (rich text) content stored as Y.XmlFragment */
  prose: Array<ProseFields<T>>;
  /** Undo capture timeout in ms. Changes within this window merge into one undo. Default: 500 */
  undoCaptureTimeout?: number;
}

/** Editor binding for BlockNote/TipTap collaboration */
export interface EditorBinding {
  /** The Y.XmlFragment bound to the editor */
  readonly fragment: Y.XmlFragment;

  /** Provider stub for BlockNote compatibility */
  readonly provider: { readonly awareness: null };

  /** Current sync state - true if unsent changes exist */
  readonly pending: boolean;

  /** Subscribe to pending state changes. Returns unsubscribe function. */
  onPendingChange(callback: (pending: boolean) => void): () => void;

  /** Undo the last content edit */
  undo(): void;

  /** Redo the last undone edit */
  redo(): void;

  /** Check if undo is available */
  canUndo(): boolean;

  /** Check if redo is available */
  canRedo(): boolean;
}

/** Protocol version info returned by utils.protocol() */
interface ProtocolInfo {
  serverVersion: number;
  localVersion: number;
  needsMigration: boolean;
}

/** Utilities exposed on collection.utils */
interface ConvexCollectionUtils<T extends object> {
  /**
   * Get an editor binding for a prose field.
   * Waits for Y.Doc to be ready (IndexedDB loaded) before returning.
   * @param documentId - The document ID
   * @param field - The prose field name (must be in `prose` config)
   * @returns Promise resolving to EditorBinding
   */
  prose(documentId: string, field: ProseFields<T>): Promise<EditorBinding>;

  /**
   * Get protocol version info for debugging and diagnostics.
   * @returns Promise resolving to version info
   */
  protocol(): Promise<ProtocolInfo>;
}

/** Extended collection with prose field utilities */
export interface ConvexCollection<T extends object> extends Collection<T> {
  /** Utilities for prose field operations */
  utils: ConvexCollectionUtils<T>;
}

// Module-level storage for Y.Doc and Y.Map instances
const collectionDocs = new Map<string, { ydoc: Y.Doc; ymap: Y.Map<unknown> }>();

// Module-level storage for undo configuration per collection
const collectionUndoConfig = new Map<
  string,
  { captureTimeout: number; trackedOrigins: Set<unknown> }
>();

// Default undo capture timeout
const DEFAULT_UNDO_CAPTURE_TIMEOUT = 500;

// Default debounce time for snapshot sync
const DEFAULT_DEBOUNCE_MS = 1000;

// Debounce timers: "collection:documentId" -> timer
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Pending state: "collection:documentId" -> boolean
const pendingState = new Map<string, boolean>();

// Pending listeners: "collection:documentId" -> Set of callbacks
const pendingListeners = new Map<string, Set<(pending: boolean) => void>>();

// Mutex per collection for thread-safe updates
const collectionMutex = new Map<string, ReturnType<typeof createMutex>>();

// Fragment undo managers: "collection:documentId:field" -> UndoManager
const fragmentUndoManagers = new Map<string, Y.UndoManager>();

// Failed sync queue: "collection:documentId" -> true (needs retry)
const failedSyncQueue = new Map<string, boolean>();

// Debounce config per collection
const debounceConfig = new Map<string, number>();

// ============================================================================
// Pending State Management
// ============================================================================

/**
 * Set pending state and notify listeners.
 */
function setPending(collection: string, documentId: string, value: boolean): void {
  const key = `${collection}:${documentId}`;
  const current = pendingState.get(key) ?? false;

  if (current !== value) {
    pendingState.set(key, value);
    const listeners = pendingListeners.get(key);
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb(value);
        } catch (err) {
          logger.error('Pending listener error', { collection, documentId, error: String(err) });
        }
      }
    }
  }
}

/**
 * Get current pending state.
 */
function getPending(collection: string, documentId: string): boolean {
  return pendingState.get(`${collection}:${documentId}`) ?? false;
}

/**
 * Subscribe to pending state changes.
 */
function subscribePending(
  collection: string,
  documentId: string,
  callback: (pending: boolean) => void
): () => void {
  const key = `${collection}:${documentId}`;

  let listeners = pendingListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    pendingListeners.set(key, listeners);
  }

  listeners.add(callback);
  return () => {
    listeners?.delete(callback);
    if (listeners?.size === 0) {
      pendingListeners.delete(key);
    }
  };
}

// ============================================================================
// Mutex Management
// ============================================================================

/**
 * Get or create mutex for a collection.
 */
function getOrCreateMutex(collection: string): ReturnType<typeof createMutex> {
  let mux = collectionMutex.get(collection);
  if (!mux) {
    mux = createMutex();
    collectionMutex.set(collection, mux);
  }
  return mux;
}

// ============================================================================
// Fragment UndoManager (scoped to content field only)
// ============================================================================

/**
 * Get or create an UndoManager scoped to a fragment field.
 * This tracks only content edits, not document-level changes like title.
 */
function getOrCreateFragmentUndoManager(
  collection: string,
  documentId: string,
  field: string,
  fragment: Y.XmlFragment
): Y.UndoManager {
  const key = `${collection}:${documentId}:${field}`;

  let um = fragmentUndoManagers.get(key);
  if (um) return um;

  const config = collectionUndoConfig.get(collection);

  um = new Y.UndoManager([fragment], {
    captureTimeout: config?.captureTimeout ?? DEFAULT_UNDO_CAPTURE_TIMEOUT,
    // Only track local fragment edits, not server syncs
    trackedOrigins: new Set([YjsOrigin.FragmentEdit]),
  });

  fragmentUndoManagers.set(key, um);
  return um;
}

// ============================================================================
// Debounced Sync Helpers
// ============================================================================

/**
 * Cancel any pending debounced sync for a document.
 * Called when receiving remote updates to avoid conflicts.
 */
function cancelPendingSync(collection: string, documentId: string): void {
  const key = `${collection}:${documentId}`;
  const timer = debounceTimers.get(key);

  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(key);
    logger.debug('Cancelled pending sync due to remote update', { collection, documentId });
  }
}

/**
 * Cancel all pending syncs for a collection.
 * Called when receiving a snapshot that replaces all state.
 */
function cancelAllPendingSyncs(collection: string): void {
  const prefix = `${collection}:`;
  for (const [key, timer] of debounceTimers) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      debounceTimers.delete(key);
    }
  }
  logger.debug('Cancelled all pending syncs', { collection });
}

/**
 * Create TanStack DB collection options with Convex + Yjs replication.
 *
 * @example
 * ```typescript
 * const options = convexCollectionOptions<Task>({
 *   getKey: (t) => t.id,
 *   convexClient,
 *   api: { stream: api.tasks.stream, insert: api.tasks.insert, ... },
 *   collection: 'tasks',
 * });
 * const collection = createCollection(options);
 * ```
 */
export function convexCollectionOptions<T extends object>({
  getKey,
  material,
  convexClient,
  api,
  collection,
  prose: proseFields,
  undoCaptureTimeout = 500,
}: ConvexCollectionOptionsConfig<T>): CollectionConfig<T> & {
  _convexClient: ConvexClient;
  _collection: string;
  _proseFields: Array<ProseFields<T>>;
  _api: ConvexCollectionOptionsConfig<T>['api'];
} {
  // Create a Set for O(1) lookup of prose fields
  const proseFieldSet = new Set<string>(proseFields as string[]);
  const setPromise = ensureSet({
    convexClient,
    api: api.protocol ? { protocol: api.protocol } : undefined,
  });

  let ydoc: Y.Doc = null as any;
  let ymap: Y.Map<unknown> = null as any;
  let persistence: IndexeddbPersistence = null as any;

  let resolvePersistenceReady: (() => void) | undefined;
  const persistenceReadyPromise = new Promise<void>((resolve) => {
    resolvePersistenceReady = resolve;
  });

  let resolveOptimisticReady: (() => void) | undefined;
  const optimisticReadyPromise = new Promise<void>((resolve) => {
    resolveOptimisticReady = resolve;
  });

  const reconcile = () =>
    Effect.gen(function* () {
      if (!api.material) return;

      const materialApi = api.material;
      const reconciliation = yield* Reconciliation;

      const serverResponse = yield* Effect.tryPromise({
        try: () => convexClient.query(materialApi, {}),
        catch: (error) => new Error(`Reconciliation query failed: ${error}`),
      });

      const serverDocs = Array.isArray(serverResponse)
        ? serverResponse
        : ((serverResponse as any).documents as T[] | undefined) || [];

      const removedItems = yield* reconciliation.reconcile(
        ydoc,
        ymap,
        collection,
        serverDocs,
        (doc: T) => String(getKey(doc))
      );

      if (removedItems.length > 0) {
        replicateDelete(removedItems);
      }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logError('Reconciliation failed', { collection, error });
        })
      )
    );

  const applyYjsInsert = (mutations: CollectionMutation<T>[]): Uint8Array => {
    const { delta } = transactWithDelta(
      ydoc,
      () => {
        mutations.forEach((mut) => {
          const itemYMap = new Y.Map();
          // First, set the itemYMap in ymap so fragments are bound to the document
          ymap.set(String(mut.key), itemYMap);
          Object.entries(mut.modified as Record<string, unknown>).forEach(([k, v]) => {
            // Check if this is a prose field (auto-detect from config)
            if (proseFieldSet.has(k) && isDoc(v)) {
              const fragment = new Y.XmlFragment();
              // Add fragment to map FIRST (binds it to the Y.Doc)
              itemYMap.set(k, fragment);
              // THEN populate content (now it's part of the document)
              fragmentFromJSON(fragment, v as XmlFragmentJSON);
            } else {
              itemYMap.set(k, v);
            }
          });
        });
      },
      YjsOrigin.Insert
    );
    return delta;
  };

  const applyYjsUpdate = (mutations: CollectionMutation<T>[]): Uint8Array => {
    const { delta } = transactWithDelta(
      ydoc,
      () => {
        mutations.forEach((mut) => {
          const itemYMap = ymap.get(String(mut.key)) as Y.Map<unknown> | undefined;
          if (itemYMap) {
            const modifiedFields = mut.modified as Record<string, unknown>;
            if (!modifiedFields) {
              logger.warn('mut.modified is null/undefined', { collection, key: String(mut.key) });
              return;
            }
            Object.entries(modifiedFields).forEach(([k, v]) => {
              const existingValue = itemYMap.get(k);

              // Check if this is a prose field
              if (proseFieldSet.has(k) && isDoc(v)) {
                if (existingValue instanceof Y.XmlFragment) {
                  // Clear existing content and apply new content
                  while (existingValue.length > 0) {
                    existingValue.delete(0);
                  }
                  fragmentFromJSON(existingValue, v as XmlFragmentJSON);
                } else {
                  // Create new XmlFragment
                  const fragment = new Y.XmlFragment();
                  // Add fragment to map FIRST (binds it to the Y.Doc)
                  itemYMap.set(k, fragment);
                  // THEN populate content (now it's part of the document)
                  fragmentFromJSON(fragment, v as XmlFragmentJSON);
                }
              } else if (existingValue instanceof Y.XmlFragment) {
                // Skip: preserve live Y.XmlFragment that BlockNote is editing directly.
                // When updating non-fragment fields (like plainText, updatedAt), the entire
                // document is passed including content. Without this check, the Y.XmlFragment
                // would be replaced with plain JSON, breaking the editor.
                logger.debug('Preserving live fragment field during update', { field: k });
              } else {
                // Regular field update
                itemYMap.set(k, v);
              }
            });
          } else {
            logger.error('Update attempted on non-existent item', {
              collection,
              key: String(mut.key),
            });
          }
        });
      },
      YjsOrigin.Update
    );
    return delta;
  };

  const applyYjsDelete = (mutations: CollectionMutation<T>[]): Uint8Array => {
    const { delta } = transactWithDelta(
      ydoc,
      () => {
        mutations.forEach((mut) => {
          ymap.delete(String(mut.key));
        });
      },
      YjsOrigin.Remove
    );
    return delta;
  };

  return {
    id: collection,
    getKey,
    _convexClient: convexClient,
    _collection: collection,
    _proseFields: proseFields,
    _api: api,

    onInsert: async ({ transaction }: CollectionTransaction<T>) => {
      try {
        await Promise.all([setPromise, persistenceReadyPromise, optimisticReadyPromise]);
        const delta = applyYjsInsert(transaction.mutations);
        if (delta.length > 0) {
          const documentKey = String(transaction.mutations[0].key);
          const itemYMap = ymap.get(documentKey) as Y.Map<unknown>;
          // Use serializeYMapValue to convert Y.XmlFragment → XmlFragmentJSON (same as onUpdate)
          const materializedDoc = itemYMap
            ? serializeYMapValue(itemYMap)
            : transaction.mutations[0].modified;
          await convexClient.mutation(api.insert, {
            documentId: documentKey,
            crdtBytes: delta.slice().buffer,
            materializedDoc,
            version: Date.now(),
          });
        }
      } catch (error) {
        handleMutationError(error, 'Insert', collection);
      }
    },

    onUpdate: async ({ transaction }: CollectionTransaction<T>) => {
      try {
        await Promise.all([setPromise, persistenceReadyPromise, optimisticReadyPromise]);

        const mutation = transaction.mutations[0];
        const metadata = transaction.metadata;

        // Check if this is a content sync from syncContent()
        if (metadata?.contentSync) {
          const { crdtBytes, materializedDoc } = metadata.contentSync;
          const documentKey = String(mutation.key);

          await convexClient.mutation(api.update, {
            documentId: documentKey,
            crdtBytes,
            materializedDoc,
            version: Date.now(),
          });
          return;
        }

        // Regular update - apply to Y.Doc and generate delta
        const delta = applyYjsUpdate(transaction.mutations);
        if (delta.length > 0) {
          const documentKey = String(mutation.key);
          const itemYMap = ymap.get(documentKey) as Y.Map<unknown>;
          // Use serializeYMapValue to properly handle XmlFragment fields
          const fullDoc = itemYMap ? serializeYMapValue(itemYMap) : mutation.modified;
          await convexClient.mutation(api.update, {
            documentId: documentKey,
            crdtBytes: delta.slice().buffer,
            materializedDoc: fullDoc,
            version: Date.now(),
          });
        }
      } catch (error) {
        handleMutationError(error, 'Update', collection);
      }
    },

    onDelete: async ({ transaction }: CollectionTransaction<T>) => {
      try {
        await Promise.all([setPromise, persistenceReadyPromise, optimisticReadyPromise]);
        const delta = applyYjsDelete(transaction.mutations);
        const itemsToDelete = transaction.mutations
          .map((mut) => mut.original)
          .filter((item): item is T => item !== undefined && Object.keys(item).length > 0);
        replicateDelete(itemsToDelete);
        if (delta.length > 0) {
          const documentKey = String(transaction.mutations[0].key);
          await convexClient.mutation(api.remove, {
            documentId: documentKey,
            crdtBytes: delta.slice().buffer,
            version: Date.now(),
          });
        }
      } catch (error) {
        handleMutationError(error, 'Delete', collection);
      }
    },

    sync: {
      rowUpdateMode: 'partial',
      sync: (params: any) => {
        const { markReady } = params;

        const existingCleanup = cleanupFunctions.get(collection);
        if (existingCleanup) {
          existingCleanup();
          cleanupFunctions.delete(collection);
        }

        let subscription: (() => void) | null = null;
        const ssrDocuments = material?.documents;
        const ssrCheckpoint = material?.checkpoint;
        const ssrCRDTBytes = material?.crdtBytes;
        const docs: T[] = ssrDocuments ? [...ssrDocuments] : [];

        (async () => {
          try {
            await setPromise;

            ydoc = await createYjsDocument(collection);
            ymap = getYMap<unknown>(ydoc, collection);

            collectionDocs.set(collection, { ydoc, ymap });

            // Store undo config for per-document undo managers
            const trackedOrigins = new Set([YjsOrigin.Insert, YjsOrigin.Update, YjsOrigin.Remove]);
            collectionUndoConfig.set(collection, {
              captureTimeout: undoCaptureTimeout,
              trackedOrigins,
            });

            persistence = new IndexeddbPersistence(collection, ydoc);
            persistence.on('synced', () => {
              logger.debug('IndexedDB persistence synced', { collection });
              resolvePersistenceReady?.();
            });
            await persistenceReadyPromise;
            logger.info('Persistence ready', { collection, ymapSize: ymap.size });

            initializeReplicateParams(params);
            resolveOptimisticReady?.();

            // Note: Fragment sync is handled by ReplicateProvider calling collection.syncContent()
            // This keeps the sync logic in the provider layer, following Yjs patterns

            if (ssrCRDTBytes) {
              applyUpdate(ydoc, new Uint8Array(ssrCRDTBytes), YjsOrigin.SSRInit);
            }

            // === LOCAL-FIRST FLOW ===
            // 1. Local data (IndexedDB/Yjs) is the source of truth
            // 2. Push local data to TanStack DB with replicateReplace (atomic swap)
            // 3. Reconcile phantom documents (hidden in loading state)
            // 4. markReady() - UI renders LOCAL DATA immediately
            // 5. Subscription starts in background (replication, not source of truth)

            // Step 1: Push local data to TanStack DB
            if (ymap.size > 0) {
              const items = extractItems<T>(ymap);
              replicateReplace(items); // Atomic replace, not accumulative insert
              logger.info('Local data loaded to TanStack DB', {
                collection,
                itemCount: items.length,
              });
            } else {
              // No local data - clear TanStack DB to avoid stale state
              replicateReplace([]);
              logger.info('No local data, cleared TanStack DB', { collection });
            }

            // Step 2: Reconcile phantom documents (still in loading state)
            logger.debug('Running reconciliation', { collection, ymapSize: ymap.size });
            await Effect.runPromise(reconcile().pipe(Effect.provide(servicesLayer)));
            logger.debug('Reconciliation complete', { collection });

            // Step 3: Mark ready BEFORE subscription - UI shows local data immediately
            markReady();
            logger.info('Collection ready (local-first)', { collection, ymapSize: ymap.size });

            // Step 4: Load checkpoint for subscription (background replication)
            const checkpoint =
              ssrCheckpoint ||
              (await Effect.runPromise(
                Effect.gen(function* () {
                  const checkpointSvc = yield* Checkpoint;
                  return yield* checkpointSvc.loadCheckpoint(collection);
                }).pipe(Effect.provide(CheckpointLive))
              ));

            logger.info('Checkpoint loaded', {
              collection,
              checkpoint,
              source: ssrCheckpoint ? 'SSR' : 'IndexedDB',
              ymapSize: ymap.size,
            });

            // Get mutex for thread-safe updates
            const mux = getOrCreateMutex(collection);

            const handleSnapshotChange = (crdtBytes: ArrayBuffer) => {
              // Cancel all pending syncs - snapshot replaces everything
              cancelAllPendingSyncs(collection);

              mux(() => {
                try {
                  logger.debug('Applying snapshot', {
                    collection,
                    bytesLength: crdtBytes.byteLength,
                  });
                  applyUpdate(ydoc, new Uint8Array(crdtBytes), YjsOrigin.Snapshot);
                  const items = extractItems<T>(ymap);
                  logger.debug('Snapshot applied', { collection, itemCount: items.length });
                  replicateReplace(items);
                } catch (error) {
                  logger.error('Error applying snapshot', { collection, error: String(error) });
                  throw new Error(`Snapshot application failed: ${error}`);
                }
              });
            };

            const handleDeltaChange = (crdtBytes: ArrayBuffer, documentId: string | undefined) => {
              // Cancel any pending sync for this document to avoid conflicts
              if (documentId) {
                cancelPendingSync(collection, documentId);
              }

              mux(() => {
                try {
                  logger.debug('Applying delta', {
                    collection,
                    documentId,
                    bytesLength: crdtBytes.byteLength,
                  });

                  const itemBefore = documentId ? extractItem<T>(ymap, documentId) : null;
                  applyUpdate(ydoc, new Uint8Array(crdtBytes), YjsOrigin.Subscription);

                  if (!documentId) {
                    logger.debug('Delta applied (no documentId)', { collection });
                    return;
                  }

                  const itemAfter = extractItem<T>(ymap, documentId);
                  if (itemAfter) {
                    logger.debug('Upserting item after delta', { collection, documentId });
                    replicateUpsert([itemAfter]);
                  } else if (itemBefore) {
                    logger.debug('Deleting item after delta', { collection, documentId });
                    replicateDelete([itemBefore]);
                  } else {
                    logger.debug('No change detected after delta', { collection, documentId });
                  }
                } catch (error) {
                  logger.error('Error applying delta', {
                    collection,
                    documentId,
                    error: String(error),
                  });
                  throw new Error(`Delta application failed for ${documentId}: ${error}`);
                }
              });
            };

            // Simple async subscription handler - bypasses Effect for reliability
            const handleSubscriptionUpdate = async (response: any) => {
              try {
                // Validate response shape
                if (!response || !Array.isArray(response.changes)) {
                  logger.error('Invalid subscription response', { response });
                  return;
                }

                const { changes, checkpoint: newCheckpoint } = response;

                // Process each change
                for (const change of changes) {
                  const { operationType, crdtBytes, documentId } = change;
                  if (!crdtBytes) {
                    logger.warn('Skipping change with missing crdtBytes', { change });
                    continue;
                  }

                  try {
                    if (operationType === 'snapshot') {
                      handleSnapshotChange(crdtBytes);
                    } else {
                      handleDeltaChange(crdtBytes, documentId);
                    }
                  } catch (changeError) {
                    logger.error('Failed to apply change', {
                      operationType,
                      documentId,
                      error: String(changeError),
                    });
                    // Continue processing other changes
                  }
                }

                // Save checkpoint using direct IndexedDB call
                if (newCheckpoint) {
                  try {
                    const key = `checkpoint:${collection}`;
                    await idbSet(key, newCheckpoint);
                    logger.debug('Checkpoint saved', { collection, checkpoint: newCheckpoint });
                  } catch (checkpointError) {
                    logger.error('Failed to save checkpoint', {
                      collection,
                      error: String(checkpointError),
                    });
                  }
                }
              } catch (error) {
                logger.error('Subscription handler error', { collection, error: String(error) });
              }
            };

            logger.info('Establishing subscription', {
              collection,
              checkpoint,
              limit: 1000,
            });

            subscription = convexClient.onUpdate(
              api.stream,
              { checkpoint, limit: 1000 },
              (response: any) => {
                logger.debug('Subscription received update', {
                  collection,
                  changesCount: response.changes?.length ?? 0,
                  checkpoint: response.checkpoint,
                  hasMore: response.hasMore,
                });

                // Call async handler directly - no Effect wrapper
                handleSubscriptionUpdate(response);
              }
            );

            // Note: markReady() was already called above (local-first)
            // Subscription is background replication, not blocking
            logger.info('Subscription established', { collection });
          } catch (error) {
            logger.error('Failed to set up collection', { error, collection });
            // Still mark ready on error so UI isn't stuck loading
            markReady();
          }
        })();

        return {
          material: docs,
          cleanup: () => {
            subscription?.();

            const prefix = `${collection}:`;

            // Cancel all pending debounced syncs
            for (const [key, timer] of debounceTimers) {
              if (key.startsWith(prefix)) {
                clearTimeout(timer);
                debounceTimers.delete(key);
              }
            }

            // Clear pending state and listeners
            for (const key of pendingState.keys()) {
              if (key.startsWith(prefix)) {
                pendingState.delete(key);
              }
            }
            for (const key of pendingListeners.keys()) {
              if (key.startsWith(prefix)) {
                pendingListeners.delete(key);
              }
            }

            // Clear failed sync queue
            for (const key of failedSyncQueue.keys()) {
              if (key.startsWith(prefix)) {
                failedSyncQueue.delete(key);
              }
            }

            // Destroy fragment undo managers
            for (const [key, um] of fragmentUndoManagers) {
              if (key.startsWith(prefix)) {
                um.destroy();
                fragmentUndoManagers.delete(key);
              }
            }

            // Clean up fragment sync handlers
            const keysToDelete = [...fragmentSyncHandlers.keys()].filter((k) =>
              k.startsWith(prefix)
            );
            for (const key of keysToDelete) {
              fragmentSyncHandlers.get(key)?.();
              fragmentSyncHandlers.delete(key);
            }

            // Clean up mutex
            collectionMutex.delete(collection);

            // Clean up debounce config
            debounceConfig.delete(collection);

            collectionUndoConfig.delete(collection);
            collectionDocs.delete(collection);
            activeFragmentDoc.delete(collection);
            persistence?.destroy();
            ydoc?.destroy();
            cleanupFunctions.delete(collection);
          },
        };
      },
    },
  };
}

/**
 * Initialize a collection with offline transaction handling.
 * This is called internally by convexCollectionOptions and sets up:
 * - Offline executor for transaction retry
 * - Online event listener for reconnection
 * - utils.prose() method for editor binding
 *
 * @internal
 */
function initializeCollectionWithOffline<T extends object>(
  collection: Collection<T>,
  collectionName: string,
  convexClient: ConvexClient,
  proseFields: Array<ProseFields<T>>
): ConvexCollection<T> {
  const proseFieldSet = new Set<string>(proseFields as string[]);

  const _offline: OfflineExecutor = startOfflineExecutor({
    collections: { [collectionName]: collection as any },
    mutationFns: {},

    beforeRetry: (transactions) => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
      const filtered = transactions.filter((tx) => {
        const isRecent = tx.createdAt.getTime() > cutoff;
        const notExhausted = tx.retryCount < 10;
        return isRecent && notExhausted;
      });

      if (filtered.length < transactions.length) {
        logger.warn('Filtered stale transactions', {
          collection: collectionName,
          before: transactions.length,
          after: filtered.length,
        });
      }

      return filtered;
    },

    onLeadershipChange: (_) => {
      // Leadership changed
    },

    onStorageFailure: (diagnostic) => {
      logger.warn('Storage failed - online-only mode', {
        collection: collectionName,
        code: diagnostic.code,
        message: diagnostic.message,
      });
    },
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      _offline.notifyOnline();
    });
  }

  // Internal syncContent function (not exposed on interface)
  const syncContent = (documentId: string, delta?: Uint8Array) => {
    const docs = collectionDocs.get(collectionName);
    if (!docs) {
      throw new Error(`Collection ${collectionName} not initialized`);
    }

    const itemYMap = docs.ymap.get(documentId) as Y.Map<unknown> | undefined;
    if (!itemYMap) {
      throw new Error(`Document ${documentId} not found in collection ${collectionName}`);
    }

    // Capture CRDT bytes and materialized doc
    const crdtBytes = delta?.slice().buffer ?? Y.encodeStateAsUpdate(docs.ydoc).buffer;
    const materializedDoc = serializeYMapValue(itemYMap);

    // Use TanStack DB's metadata to pass sync info through the transaction system
    return (collection as any).update(
      documentId,
      { metadata: { contentSync: { crdtBytes, materializedDoc } } },
      (draft: any) => {
        // Touch updatedAt to trigger change detection
        draft.updatedAt = Date.now();
      }
    );
  };

  // Create utils object with prose() method
  const utils: ConvexCollectionUtils<T> = {
    async prose(documentId: string, field: ProseFields<T>): Promise<EditorBinding> {
      const fieldStr = field as string;

      // Validate field is in prose config
      if (!proseFieldSet.has(fieldStr)) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection: collectionName,
        });
      }

      // Wait for collection to be ready (Y.Doc initialized from IndexedDB)
      let docs = collectionDocs.get(collectionName);

      if (!docs) {
        // Poll until ready - Y.Doc initialization is async
        await new Promise<void>((resolve, reject) => {
          const maxWait = 10000; // 10 second timeout
          const startTime = Date.now();
          const check = setInterval(() => {
            if (collectionDocs.has(collectionName)) {
              clearInterval(check);
              resolve();
            } else if (Date.now() - startTime > maxWait) {
              clearInterval(check);
              reject(
                new ProseError({
                  documentId,
                  field: fieldStr,
                  collection: collectionName,
                })
              );
            }
          }, 10);
        });
        docs = collectionDocs.get(collectionName);
      }

      if (!docs) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection: collectionName,
        });
      }

      const fragment = getFragmentFromYMap(docs.ymap, documentId, fieldStr);
      if (!fragment) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection: collectionName,
        });
      }

      // Setup fragment observer with debounced sync
      const handlerKey = `${collectionName}:${documentId}`;
      if (!fragmentSyncHandlers.has(handlerKey)) {
        // Create a wrapper that has access to syncContent
        const mux = getOrCreateMutex(collectionName);

        const observerHandler = (_events: Y.YEvent<any>[], transaction: Y.Transaction) => {
          // Skip server-originated changes
          if (
            transaction.origin === YjsOrigin.Subscription ||
            transaction.origin === YjsOrigin.Snapshot ||
            transaction.origin === YjsOrigin.SSRInit
          ) {
            return;
          }

          // Schedule debounced sync within mutex
          mux(() => {
            const key = `${collectionName}:${documentId}`;

            // Clear existing timer
            const existing = debounceTimers.get(key);
            if (existing) clearTimeout(existing);

            // Mark as pending
            setPending(collectionName, documentId, true);

            // Get debounce time
            const debounceMs = debounceConfig.get(collectionName) ?? DEFAULT_DEBOUNCE_MS;

            // Schedule sync
            const timer = setTimeout(async () => {
              debounceTimers.delete(key);

              try {
                const result = syncContent(documentId);
                await result.isPersisted.promise;

                // Success - clear pending and any failed queue entry
                failedSyncQueue.delete(key);
                setPending(collectionName, documentId, false);
                logger.debug('Debounced sync completed', {
                  collection: collectionName,
                  documentId,
                });
              } catch (err) {
                logger.error('Sync failed, queued for retry', {
                  collection: collectionName,
                  documentId,
                  error: String(err),
                });
                // Queue for retry on next change - keep pending true
                failedSyncQueue.set(key, true);
              }
            }, debounceMs);

            debounceTimers.set(key, timer);

            // Also retry any failed syncs for this document
            if (failedSyncQueue.has(key)) {
              failedSyncQueue.delete(key);
              logger.debug('Retrying failed sync', { collection: collectionName, documentId });
            }
          });
        };

        fragment.observeDeep(observerHandler);
        fragmentSyncHandlers.set(handlerKey, () => fragment.unobserveDeep(observerHandler));
        logger.debug('Fragment observer registered', {
          collection: collectionName,
          documentId,
          field: fieldStr,
        });
      }

      // Track active document
      activeFragmentDoc.set(collectionName, documentId);

      // Create fragment-scoped undo manager
      const undoManager = getOrCreateFragmentUndoManager(
        collectionName,
        documentId,
        fieldStr,
        fragment
      );

      // Return EditorBinding with reactive pending state
      return {
        fragment,
        provider: { awareness: null },

        get pending() {
          return getPending(collectionName, documentId);
        },

        onPendingChange(callback: (pending: boolean) => void) {
          return subscribePending(collectionName, documentId, callback);
        },

        undo() {
          undoManager.undo();
        },

        redo() {
          undoManager.redo();
        },

        canUndo() {
          return undoManager.canUndo();
        },

        canRedo() {
          return undoManager.canRedo();
        },
      } satisfies EditorBinding;
    },

    async protocol(): Promise<ProtocolInfo> {
      const protocolApi = (collection as any).config?._api?.protocol;
      if (!protocolApi) {
        throw new Error('Protocol API endpoint required. Add protocol to your api config.');
      }

      const protocolLayer = ProtocolLive(convexClient, { protocol: protocolApi });

      const { serverVersion, localVersion } = await Effect.runPromise(
        Effect.gen(function* () {
          const protocol = yield* Protocol;
          const server = yield* protocol.getServerVersion();
          const local = yield* protocol.getStoredVersion();
          return { serverVersion: server, localVersion: local };
        }).pipe(Effect.provide(protocolLayer))
      );

      return {
        serverVersion,
        localVersion,
        needsMigration: serverVersion > localVersion,
      };
    },
  };

  // Extend collection with utils
  const collectionWithUtils = collection as ConvexCollection<T>;
  (collectionWithUtils as any).utils = utils;

  return collectionWithUtils;
}

// Store initialized collections to avoid double initialization
const initializedCollections = new Map<string, ConvexCollection<any>>();

/**
 * Get or create a ConvexCollection from a raw collection.
 * This ensures offline handling is initialized exactly once per collection.
 *
 * @internal
 */
export function getOrInitializeCollection<T extends object>(
  collection: Collection<T>
): ConvexCollection<T> {
  const config = (collection as any).config;
  const collectionName = config._collection as string;
  const convexClient = config._convexClient as ConvexClient;
  const proseFields = config._proseFields as Array<ProseFields<T>>;

  if (!convexClient || !collectionName) {
    throw new Error(
      'Collection must be created with convexCollectionOptions. ' +
        'Make sure you pass convexClient and collection to convexCollectionOptions.'
    );
  }

  // Check if already initialized
  const existing = initializedCollections.get(collectionName);
  if (existing) {
    return existing as ConvexCollection<T>;
  }

  // Initialize and cache
  const initialized = initializeCollectionWithOffline(
    collection,
    collectionName,
    convexClient,
    proseFields
  );
  initializedCollections.set(collectionName, initialized);

  return initialized;
}
