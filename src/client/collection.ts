import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
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
import { ensureSet } from '$/client/set.js';
import { Checkpoint, CheckpointLive } from '$/client/services/checkpoint.js';
import { Reconciliation, ReconciliationLive } from '$/client/services/reconciliation.js';
import { SnapshotLive } from '$/client/services/snapshot.js';
import {
  initializeReplicateParams,
  replicateInsert,
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
  isFragment,
  fragmentFromJSON,
  serializeYMapValue,
  getFragmentFromYMap,
} from '$/client/merge.js';

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

/** Transaction wrapper containing mutations array */
interface CollectionTransaction<T> {
  transaction: { mutations: CollectionMutation<T>[] };
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

import { OperationType } from '$/shared/types.js';

const cleanupFunctions = new Map<string, () => void>();

/** Origin markers for Yjs transactions - used for undo tracking and debugging */
export enum YjsOrigin {
  Insert = 'insert',
  Update = 'update',
  Remove = 'remove',

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
  /** Undo capture timeout in ms. Changes within this window merge into one undo. Default: 500 */
  undoCaptureTimeout?: number;
  /** Origins to track for undo. Default: insert, update, remove */
  undoTrackedOrigins?: Set<any>;
}

/** Extended collection with fragment and per-document undo/redo support */
export interface ConvexCollection<T extends object> extends Collection<T> {
  /**
   * Get a Y.XmlFragment from a document's field for editor binding.
   * @param documentId - The document ID
   * @param field - The field name containing the Y.XmlFragment
   * @returns The Y.XmlFragment or null if not found/not initialized
   */
  fragment(documentId: string, field: string): Y.XmlFragment | null;

  /**
   * Undo the last change for a specific document.
   * @param documentId - The document ID
   */
  undo(documentId: string): void;

  /**
   * Redo the last undone change for a specific document.
   * @param documentId - The document ID
   */
  redo(documentId: string): void;

  /**
   * Check if undo is available for a specific document.
   * @param documentId - The document ID
   */
  canUndo(documentId: string): boolean;

  /**
   * Check if redo is available for a specific document.
   * @param documentId - The document ID
   */
  canRedo(documentId: string): boolean;
}

// Module-level storage for Y.Doc and Y.Map instances
const collectionDocs = new Map<string, { ydoc: Y.Doc; ymap: Y.Map<unknown> }>();

// Module-level storage for per-document undo managers
const documentUndoManagers = new Map<string, Map<string, Y.UndoManager>>();

// Module-level storage for undo configuration per collection
const collectionUndoConfig = new Map<
  string,
  { captureTimeout: number; trackedOrigins: Set<unknown> }
>();

// Default undo capture timeout
const DEFAULT_UNDO_CAPTURE_TIMEOUT = 500;

/**
 * Get or create an UndoManager for a specific document.
 * Creates the undo manager lazily on first access.
 */
function getOrCreateDocumentUndoManager(
  collectionName: string,
  documentId: string
): Y.UndoManager | null {
  const docs = collectionDocs.get(collectionName);
  if (!docs) return null;

  let docManagers = documentUndoManagers.get(collectionName);
  if (!docManagers) {
    docManagers = new Map();
    documentUndoManagers.set(collectionName, docManagers);
  }

  let undoManager = docManagers.get(documentId);
  if (!undoManager) {
    const itemYMap = docs.ymap.get(documentId);
    if (itemYMap instanceof Y.Map) {
      const config = collectionUndoConfig.get(collectionName);
      undoManager = new Y.UndoManager(itemYMap, {
        captureTimeout: config?.captureTimeout ?? DEFAULT_UNDO_CAPTURE_TIMEOUT,
        trackedOrigins:
          config?.trackedOrigins ?? new Set([YjsOrigin.Insert, YjsOrigin.Update, YjsOrigin.Remove]),
      });
      docManagers.set(documentId, undoManager);
    }
  }

  return undoManager ?? null;
}

/**
 * Get existing UndoManager for a document (doesn't create if missing).
 */
function getDocumentUndoManager(collectionName: string, documentId: string): Y.UndoManager | null {
  return documentUndoManagers.get(collectionName)?.get(documentId) ?? null;
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
  undoCaptureTimeout = 500,
  undoTrackedOrigins,
}: ConvexCollectionOptionsConfig<T>): CollectionConfig<T> & {
  _convexClient: ConvexClient;
  _collection: string;
} {
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
            if (isFragment(v)) {
              const fragment = new Y.XmlFragment();
              // Add fragment to map FIRST (binds it to the Y.Doc)
              itemYMap.set(k, fragment);
              // THEN populate content (now it's part of the document)
              if (v.content) {
                fragmentFromJSON(fragment, v.content);
              }
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

              if (isFragment(v)) {
                if (existingValue instanceof Y.XmlFragment) {
                  // Clear existing content and apply new content
                  while (existingValue.length > 0) {
                    existingValue.delete(0);
                  }
                  if (v.content) {
                    fragmentFromJSON(existingValue, v.content);
                  }
                } else {
                  // Create new XmlFragment
                  const fragment = new Y.XmlFragment();
                  // Add fragment to map FIRST (binds it to the Y.Doc)
                  itemYMap.set(k, fragment);
                  // THEN populate content (now it's part of the document)
                  if (v.content) {
                    fragmentFromJSON(fragment, v.content);
                  }
                }
              } else {
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
        const delta = applyYjsUpdate(transaction.mutations);
        if (delta.length > 0) {
          const documentKey = String(transaction.mutations[0].key);
          const itemYMap = ymap.get(documentKey) as Y.Map<unknown>;
          // Use serializeYMapValue to properly handle XmlFragment fields
          const fullDoc = itemYMap
            ? serializeYMapValue(itemYMap)
            : transaction.mutations[0].modified;
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
            const trackedOrigins =
              undoTrackedOrigins ?? new Set([YjsOrigin.Insert, YjsOrigin.Update, YjsOrigin.Remove]);
            collectionUndoConfig.set(collection, {
              captureTimeout: undoCaptureTimeout,
              trackedOrigins,
            });

            persistence = new IndexeddbPersistence(collection, ydoc);
            persistence.on('synced', () => resolvePersistenceReady?.());
            await persistenceReadyPromise;

            initializeReplicateParams(params);
            resolveOptimisticReady?.();

            if (ssrCRDTBytes) {
              applyUpdate(ydoc, new Uint8Array(ssrCRDTBytes), YjsOrigin.SSRInit);
            }

            if (ymap.size > 0) {
              const items = extractItems<T>(ymap);
              replicateInsert(items);
              logger.info('Initial sync completed', { collection, itemCount: items.length });
            }

            await Effect.runPromise(reconcile().pipe(Effect.provide(servicesLayer)));

            const checkpoint =
              ssrCheckpoint ||
              (await Effect.runPromise(
                Effect.gen(function* () {
                  const checkpointSvc = yield* Checkpoint;
                  return yield* checkpointSvc.loadCheckpoint(collection);
                }).pipe(Effect.provide(CheckpointLive))
              ));

            const handleSnapshotChange = (crdtBytes: ArrayBuffer) => {
              applyUpdate(ydoc, new Uint8Array(crdtBytes), YjsOrigin.Snapshot);
              replicateReplace(extractItems<T>(ymap));
            };

            const handleDeltaChange = (crdtBytes: ArrayBuffer, documentId: string | undefined) => {
              const itemBefore = documentId ? extractItem<T>(ymap, documentId) : null;
              applyUpdate(ydoc, new Uint8Array(crdtBytes), YjsOrigin.Subscription);

              if (!documentId) return;

              const itemAfter = extractItem<T>(ymap, documentId);
              if (itemAfter) {
                replicateUpsert([itemAfter]);
              } else if (itemBefore) {
                replicateDelete([itemBefore]);
              }
            };

            const subscriptionHandler = (response: any) =>
              Effect.gen(function* () {
                const checkpointSvc = yield* Checkpoint;
                const { changes, checkpoint: newCheckpoint } = response;

                for (const change of changes) {
                  const { operationType, crdtBytes, documentId } = change;
                  if (operationType === 'snapshot') {
                    handleSnapshotChange(crdtBytes);
                  } else {
                    handleDeltaChange(crdtBytes, documentId);
                  }
                }

                yield* checkpointSvc.saveCheckpoint(collection, newCheckpoint);
              }).pipe(Effect.provide(servicesLayer));

            subscription = convexClient.onUpdate(
              api.stream,
              { checkpoint, limit: 1000 },
              (response: any) => {
                Effect.runPromise(
                  subscriptionHandler(response).pipe(
                    Effect.catchAllCause((cause) =>
                      Effect.logError('Subscription handler error', { cause })
                    )
                  )
                );
              }
            );

            markReady();
          } catch (error) {
            logger.error('Failed to set up collection', { error, collection });
            markReady();
          }
        })();

        return {
          material: docs,
          cleanup: () => {
            subscription?.();
            // Destroy per-document undo managers
            const docManagers = documentUndoManagers.get(collection);
            if (docManagers) {
              docManagers.forEach((um) => {
                um.destroy();
              });
              documentUndoManagers.delete(collection);
            }
            collectionUndoConfig.delete(collection);
            collectionDocs.delete(collection);
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
 * Wrap a collection with offline transaction handling and reconnection logic.
 * Must be called after createCollection to enable offline-first behavior.
 *
 * @example
 * ```typescript
 * const rawCollection = createCollection(convexCollectionOptions<Task>({ ... }));
 * const collection = handleReconnect(rawCollection);
 * ```
 */
export function handleReconnect<T extends object>(
  rawCollection: Collection<T>
): ConvexCollection<T> {
  // Extract config from rawCollection
  const config = (rawCollection as any).config;
  const convexClient = config._convexClient;
  const collection = config._collection;

  if (!convexClient || !collection) {
    throw new Error(
      'handleReconnect requires a collection created with convexCollectionOptions. ' +
        'Make sure you pass convexClient and collection to convexCollectionOptions.'
    );
  }

  const offline: OfflineExecutor = startOfflineExecutor({
    collections: { [collection]: rawCollection as any },
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
          collection,
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
        collection,
        code: diagnostic.code,
        message: diagnostic.message,
      });
    },
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      offline.notifyOnline();
    });
  }

  // Add collection methods for fragment and per-document undo/redo
  const collectionWithMethods = rawCollection as ConvexCollection<T>;

  collectionWithMethods.fragment = (documentId: string, field: string) => {
    const docs = collectionDocs.get(collection);
    if (!docs) return null;
    return getFragmentFromYMap(docs.ymap, documentId, field);
  };

  collectionWithMethods.undo = (documentId: string) => {
    const undoManager = getOrCreateDocumentUndoManager(collection, documentId);
    undoManager?.undo();
  };

  collectionWithMethods.redo = (documentId: string) => {
    const undoManager = getOrCreateDocumentUndoManager(collection, documentId);
    undoManager?.redo();
  };

  collectionWithMethods.canUndo = (documentId: string) => {
    const undoManager = getDocumentUndoManager(collection, documentId);
    return undoManager?.canUndo() ?? false;
  };

  collectionWithMethods.canRedo = (documentId: string) => {
    const undoManager = getDocumentUndoManager(collection, documentId);
    return undoManager?.canRedo() ?? false;
  };

  return collectionWithMethods;
}

/**
 * Get the Y.Doc for a collection.
 * Useful for advanced Yjs operations like awareness or custom bindings.
 *
 * @param collectionName - The collection name
 * @returns The Y.Doc or null if not initialized
 */
export function getYDoc(collectionName: string): Y.Doc | null {
  return collectionDocs.get(collectionName)?.ydoc ?? null;
}
