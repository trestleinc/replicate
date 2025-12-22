import * as Y from 'yjs';
import { createMutex } from 'lib0/mutex';
import type { Persistence, PersistenceProvider } from '$/client/persistence/types';
import type { ConvexClient } from 'convex/browser';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { CollectionConfig, Collection, NonSingleResult, InferSchemaOutput } from '@tanstack/db';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Effect, Layer } from 'effect';
import { getLogger } from '$/client/logger';
import { ProseError, NonRetriableError } from '$/client/errors';
import { Checkpoint, createCheckpointLayer } from '$/client/services/checkpoint';
import { Reconciliation, ReconciliationLive } from '$/client/services/reconciliation';
import { createReplicateOps, type BoundReplicateOps } from '$/client/replicate';
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
} from '$/client/merge';
import * as prose from '$/client/prose';
import { extractProseFields } from '$/client/prose-schema';
import { z } from 'zod';

/** Origin markers for Yjs transactions */
enum YjsOrigin {
  Local = 'local',
  Fragment = 'fragment',
  Server = 'server',
}
import type { ProseFields, XmlFragmentJSON } from '$/shared/types';

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
  metadata?: unknown;
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

const cleanupFunctions = new Map<string, () => void>();

/** Server-rendered material data for SSR hydration */
export type Materialized<T> = {
  documents: ReadonlyArray<T>;
  checkpoint?: { lastModified: number };
  count?: number;
  crdtBytes?: ArrayBuffer;
};

/** API object from replicate() */
interface ConvexCollectionApi {
  stream: FunctionReference<'query'>;
  insert: FunctionReference<'mutation'>;
  update: FunctionReference<'mutation'>;
  remove: FunctionReference<'mutation'>;
  recovery: FunctionReference<'query'>;
  material?: FunctionReference<'query'>;
}

interface ConvexCollectionOptionsBaseConfig<
  T extends object,
  TSchema extends StandardSchemaV1 = never,
  TKey extends string | number = string | number
> {
  schema: TSchema;
  getKey: (item: T) => TKey;
  material?: Materialized<T>;
  convexClient: ConvexClient;
  api: ConvexCollectionApi;
  undoCaptureTimeout?: number;
  persistence: Persistence;
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

// Default debounce time for prose sync
const DEFAULT_DEBOUNCE_MS = 1000;

// Mutex per collection for thread-safe updates
const collectionMutex = new Map<string, ReturnType<typeof createMutex>>();

// Fragment undo managers: "collection:documentId:field" -> UndoManager
const fragmentUndoManagers = new Map<string, Y.UndoManager>();

// Debounce config per collection
const debounceConfig = new Map<string, number>();

// Collection references - set in sync.sync() callback, used by utils.prose()
const collectionRefs = new Map<string, Collection<any>>();

// Server state vectors for recovery sync
const serverStateVectors = new Map<string, Uint8Array>();

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
    trackedOrigins: new Set([YjsOrigin.Fragment]),
  });

  fragmentUndoManagers.set(key, um);
  return um;
}

type ConvexCollectionOptionsResult<
  T extends object,
  TKey extends string | number = string | number,
  TSchema extends StandardSchemaV1 = never
> = CollectionConfig<T, TKey, TSchema> & NonSingleResult & {
  _convexClient: ConvexClient;
  _collection: string;
  _proseFields: string[];
  _persistence: Persistence;
  utils: ConvexCollectionUtils<T>;
  schema: TSchema;
};

/**
 * Create TanStack DB collection options with Convex + Yjs replication.
 * Schema is required - types and prose fields are auto-detected.
 *
 * @example
 * ```typescript
 * import { prose } from '@trestleinc/replicate/client';
 *
 * const taskSchema = z.object({
 *   id: z.string(),
 *   title: z.string(),
 *   content: prose(),  // Rich text field - auto-detected
 * });
 *
 * const collection = createCollection(
 *   convexCollectionOptions({
 *     schema: taskSchema,
 *     getKey: (t) => t.id,
 *     convexClient,
 *     api: api.tasks,  // __collection is extracted automatically
 *     persistence,
 *   })
 * );
 * ```
 */
export function convexCollectionOptions<
  TSchema extends z.ZodObject<z.ZodRawShape>,
  TKey extends string | number = string | number
>(
  config: ConvexCollectionOptionsBaseConfig<z.infer<TSchema>, TSchema, TKey>
): ConvexCollectionOptionsResult<z.infer<TSchema>, TKey, TSchema>;

// Implementation (must be compatible with both overloads)
export function convexCollectionOptions(
  config: ConvexCollectionOptionsBaseConfig<any, any, any>
): ConvexCollectionOptionsResult<any, any, any> {
  const {
    schema,
    getKey,
    material,
    convexClient,
    api,
    undoCaptureTimeout = 500,
    persistence,
  } = config;

  // Extract collection name from function reference path (e.g., "intervals:stream" -> "intervals")
  const functionPath = getFunctionName(api.stream);
  const collection = functionPath.split(':')[0];
  if (!collection) {
    throw new Error('Could not extract collection name from api.stream function reference');
  }

  const proseFields: string[] =
    schema && schema instanceof z.ZodObject ? extractProseFields(schema) : [];

  // DataType is 'any' in implementation - type safety comes from overload signatures
  type DataType = any;
  // Create a Set for O(1) lookup of prose fields
  const proseFieldSet = new Set<string>(proseFields);

  // Create utils object - prose() waits for Y.Doc to be ready via collectionDocs
  const utils: ConvexCollectionUtils<DataType> = {
    async prose(documentId: string, field: ProseFields<DataType>): Promise<EditorBinding> {
      const fieldStr = field as string;

      // Validate field is in prose config
      if (!proseFieldSet.has(fieldStr)) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection,
        });
      }

      // Wait for collection to be ready (Y.Doc initialized from persistence)
      let docs = collectionDocs.get(collection);

      if (!docs) {
        // Poll until ready - Y.Doc initialization is async
        await new Promise<void>((resolve, reject) => {
          const maxWait = 10000; // 10 second timeout
          const startTime = Date.now();
          const check = setInterval(() => {
            if (collectionDocs.has(collection)) {
              clearInterval(check);
              resolve();
            } else if (Date.now() - startTime > maxWait) {
              clearInterval(check);
              reject(
                new ProseError({
                  documentId,
                  field: fieldStr,
                  collection,
                })
              );
            }
          }, 10);
        });
        docs = collectionDocs.get(collection);
      }

      if (!docs) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection,
        });
      }

      const fragment = getFragmentFromYMap(docs.ymap, documentId, fieldStr);
      if (!fragment) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection,
        });
      }

      // Setup fragment observer via prose module (handles debounced sync)
      const collectionRef = collectionRefs.get(collection);
      if (collectionRef) {
        prose.observeFragment({
          collection,
          documentId,
          field: fieldStr,
          fragment,
          ydoc: docs.ydoc,
          ymap: docs.ymap,
          collectionRef,
          debounceMs: debounceConfig.get(collection) ?? DEFAULT_DEBOUNCE_MS,
        });
      }

      const undoManager = getOrCreateFragmentUndoManager(
        collection,
        documentId,
        fieldStr,
        fragment
      );

      // Return EditorBinding with reactive pending state from prose module
      return {
        fragment,
        provider: { awareness: null },

        get pending() {
          return prose.isPending(collection, documentId);
        },

        onPendingChange(callback: (pending: boolean) => void) {
          return prose.subscribePending(collection, documentId, callback);
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
  };

  let ydoc: Y.Doc = null as any;
  let ymap: Y.Map<unknown> = null as any;
  let docPersistence: PersistenceProvider = null as any;

  // Bound replicate operations - set during sync initialization
  // Used by onDelete and other handlers that need to sync with TanStack DB
  let ops: BoundReplicateOps<DataType> = null as any;

  // Create services layer with the persistence KV store
  const checkpointLayer = createCheckpointLayer(persistence.kv);
  const servicesLayer = Layer.mergeAll(checkpointLayer, ReconciliationLive);

  let resolvePersistenceReady: (() => void) | undefined;
  const persistenceReadyPromise = new Promise<void>((resolve) => {
    resolvePersistenceReady = resolve;
  });

  let resolveOptimisticReady: (() => void) | undefined;
  const optimisticReadyPromise = new Promise<void>((resolve) => {
    resolveOptimisticReady = resolve;
  });

  const reconcile = (ops: BoundReplicateOps<DataType>) =>
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
        : ((serverResponse as any).documents as DataType[] | undefined) || [];

      const removedItems = yield* reconciliation.reconcile(
        ydoc,
        ymap,
        collection,
        serverDocs,
        (doc: DataType) => String(getKey(doc))
      );

      if (removedItems.length > 0) {
        ops.delete(removedItems);
      }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logError('Reconciliation failed', { collection, error });
        })
      )
    );

  /**
   * Recovery sync using state vectors.
   * Fetches missing data from server based on local state vector.
   */
  const recoverSync = async (): Promise<void> => {
    if (!api.recovery) {
      logger.debug('No recovery API configured, skipping recovery sync', { collection });
      return;
    }

    try {
      // Encode local state vector
      const localStateVector = Y.encodeStateVector(ydoc);

      logger.debug('Starting recovery sync', {
        collection,
        localVectorSize: localStateVector.byteLength,
      });

      // Query server for diff
      const response = await convexClient.query(api.recovery, {
        clientStateVector: localStateVector.buffer as ArrayBuffer,
      });

      // Apply diff if any
      if (response.diff) {
        const mux = getOrCreateMutex(collection);
        mux(() => {
          applyUpdate(ydoc, new Uint8Array(response.diff), YjsOrigin.Server);
        });

        logger.info('Recovery sync applied diff', {
          collection,
          diffSize: response.diff.byteLength,
        });
      } else {
        logger.debug('Recovery sync - no diff needed', { collection });
      }

      // Store server state vector for future reference
      if (response.serverStateVector) {
        serverStateVectors.set(collection, new Uint8Array(response.serverStateVector));
      }
    } catch (error) {
      logger.error('Recovery sync failed', {
        collection,
        error: String(error),
      });
      // Don't throw - recovery is best-effort, subscription will catch up
    }
  };

  const applyYjsInsert = (mutations: CollectionMutation<DataType>[]): Uint8Array => {
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
      YjsOrigin.Local
    );
    return delta;
  };

  const applyYjsUpdate = (mutations: CollectionMutation<DataType>[]): Uint8Array => {
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

              // ALWAYS skip prose fields - they are managed by Y.XmlFragment directly
              // User edits go: BlockNote → Y.XmlFragment → observer → debounce → server
              // Server sync goes: subscription → applyUpdate(ydoc) → CRDT merge
              // Writing serialized JSON back would corrupt the CRDT state
              if (proseFieldSet.has(k)) {
                logger.debug('Skipping prose field in applyYjsUpdate', { field: k });
                return;
              }

              // Also skip if existing value is a Y.XmlFragment (defensive check)
              if (existingValue instanceof Y.XmlFragment) {
                logger.debug('Preserving live fragment field', { field: k });
                return;
              }

              // Regular field update
              itemYMap.set(k, v);
            });
          } else {
            logger.error('Update attempted on non-existent item', {
              collection,
              key: String(mut.key),
            });
          }
        });
      },
      YjsOrigin.Local
    );
    return delta;
  };

  const applyYjsDelete = (mutations: CollectionMutation<DataType>[]): Uint8Array => {
    const { delta } = transactWithDelta(
      ydoc,
      () => {
        mutations.forEach((mut) => {
          ymap.delete(String(mut.key));
        });
      },
      YjsOrigin.Local
    );
    return delta;
  };

  return {
    id: collection,
    getKey,
    schema: schema as any,
    _convexClient: convexClient,
    _collection: collection,
    _proseFields: proseFields,
    _persistence: persistence,
    utils,

    onInsert: async ({ transaction }: CollectionTransaction<DataType>) => {
      try {
        await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
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
          });
        }
      } catch (error) {
        handleMutationError(error, 'Insert', collection);
      }
    },

    onUpdate: async ({ transaction }: CollectionTransaction<DataType>) => {
      try {
        const mutation = transaction.mutations[0];
        const documentKey = String(mutation.key);

        // Skip if this update originated from server (prevents echo loops)
        // Now checks DOCUMENT-level flag, not collection-level
        if (prose.isApplyingFromServer(collection, documentKey)) {
          logger.debug('Skipping onUpdate - data from server', { collection, documentKey });
          return;
        }

        await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);

        // Metadata is on mutation, not transaction (TanStack DB API)
        const metadata = mutation.metadata as { contentSync?: ContentSyncMetadata } | undefined;

        // Check if this is a content sync from utils.prose()
        if (metadata?.contentSync) {
          const { crdtBytes, materializedDoc } = metadata.contentSync;

          await convexClient.mutation(api.update, {
            documentId: documentKey,
            crdtBytes,
            materializedDoc,
          });
          return;
        }

        // Regular update - apply to Y.Doc and generate delta
        const delta = applyYjsUpdate(transaction.mutations);
        if (delta.length > 0) {
          const itemYMap = ymap.get(documentKey) as Y.Map<unknown>;
          // Use serializeYMapValue to properly handle XmlFragment fields
          const fullDoc = itemYMap ? serializeYMapValue(itemYMap) : mutation.modified;
          await convexClient.mutation(api.update, {
            documentId: documentKey,
            crdtBytes: delta.slice().buffer,
            materializedDoc: fullDoc,
          });
        }
      } catch (error) {
        handleMutationError(error, 'Update', collection);
      }
    },

    onDelete: async ({ transaction }: CollectionTransaction<DataType>) => {
      try {
        await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
        const delta = applyYjsDelete(transaction.mutations);
        const itemsToDelete = transaction.mutations
          .map((mut) => mut.original)
          .filter((item): item is DataType => item !== undefined && Object.keys(item).length > 0);
        ops.delete(itemsToDelete);
        if (delta.length > 0) {
          const documentKey = String(transaction.mutations[0].key);
          await convexClient.mutation(api.remove, {
            documentId: documentKey,
            crdtBytes: delta.slice().buffer,
          });
        }
      } catch (error) {
        handleMutationError(error, 'Delete', collection);
      }
    },

    sync: {
      rowUpdateMode: 'partial',
      sync: (params: any) => {
        const { markReady, collection: collectionInstance } = params;

        // Store collection reference for utils.prose() to access
        collectionRefs.set(collection, collectionInstance);

        const existingCleanup = cleanupFunctions.get(collection);
        if (existingCleanup) {
          existingCleanup();
          cleanupFunctions.delete(collection);
        }

        let subscription: (() => void) | null = null;
        const ssrDocuments = material?.documents;
        const ssrCheckpoint = material?.checkpoint;
        const ssrCRDTBytes = material?.crdtBytes;
        const docs: DataType[] = ssrDocuments ? [...ssrDocuments] : [];

        (async () => {
          try {
            ydoc = await createYjsDocument(collection, persistence.kv);
            ymap = getYMap<unknown>(ydoc, collection);

            collectionDocs.set(collection, { ydoc, ymap });

            // Store undo config for per-document undo managers
            const trackedOrigins = new Set([YjsOrigin.Local]);
            collectionUndoConfig.set(collection, {
              captureTimeout: undoCaptureTimeout,
              trackedOrigins,
            });

            docPersistence = persistence.createDocPersistence(collection, ydoc);
            docPersistence.whenSynced.then(() => {
              logger.debug('Persistence synced', { collection });
              resolvePersistenceReady?.();
            });
            await persistenceReadyPromise;
            logger.info('Persistence ready', { collection, ymapSize: ymap.size });

            // Create bound replicate operations for this collection
            // These are tied to this collection's TanStack DB params
            ops = createReplicateOps<DataType>(params);
            resolveOptimisticReady?.();

            // Note: Fragment sync is handled by utils.prose() debounce handler
            // calling collection.update() with contentSync metadata

            if (ssrCRDTBytes) {
              applyUpdate(ydoc, new Uint8Array(ssrCRDTBytes), YjsOrigin.Server);
            }

            // === LOCAL-FIRST FLOW WITH RECOVERY ===
            // 1. Local data (IndexedDB/Yjs) is the source of truth
            // 2. Recovery sync - get any missing data from server using state vectors
            // 3. Push local+recovered data to TanStack DB with ops.replace
            // 4. Reconcile phantom documents (hidden in loading state)
            // 5. markReady() - UI renders DATA immediately
            // 6. Subscription starts in background (replication)

            // Step 1: Recovery sync - fetch missing server data
            await recoverSync();

            // Step 2: Push local+recovered data to TanStack DB
            if (ymap.size > 0) {
              const items = extractItems<DataType>(ymap);
              ops.replace(items); // Atomic replace, not accumulative insert
              logger.info('Data loaded to TanStack DB', {
                collection,
                itemCount: items.length,
              });
            } else {
              // No data - clear TanStack DB to avoid stale state
              ops.replace([]);
              logger.info('No data, cleared TanStack DB', { collection });
            }

            // Step 3: Reconcile phantom documents (still in loading state)
            logger.debug('Running reconciliation', { collection, ymapSize: ymap.size });
            await Effect.runPromise(reconcile(ops).pipe(Effect.provide(servicesLayer)));
            logger.debug('Reconciliation complete', { collection });

            // Step 4: Mark ready - UI shows data immediately
            markReady();
            logger.info('Collection ready', { collection, ymapSize: ymap.size });

            // Step 4: Load checkpoint for subscription (background replication)
            const checkpoint =
              ssrCheckpoint ||
              (await Effect.runPromise(
                Effect.gen(function* () {
                  const checkpointSvc = yield* Checkpoint;
                  return yield* checkpointSvc.loadCheckpoint(collection);
                }).pipe(Effect.provide(checkpointLayer))
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
              prose.cancelAllPending(collection);

              mux(() => {
                try {
                  logger.debug('Applying snapshot', {
                    collection,
                    bytesLength: crdtBytes.byteLength,
                  });
                  applyUpdate(ydoc, new Uint8Array(crdtBytes), YjsOrigin.Server);
                  const items = extractItems<DataType>(ymap);
                  logger.debug('Snapshot applied', { collection, itemCount: items.length });
                  ops.replace(items);
                } catch (error) {
                  logger.error('Error applying snapshot', { collection, error: String(error) });
                  throw new Error(`Snapshot application failed: ${error}`);
                }
              });
            };

            const handleDeltaChange = (crdtBytes: ArrayBuffer, documentId: string | undefined) => {
              // Cancel any pending sync for this document to avoid conflicts
              if (documentId) {
                prose.cancelPending(collection, documentId);
                // Mark that we're applying server data to prevent echo loops (DOCUMENT-level)
                prose.setApplyingFromServer(collection, documentId, true);
              }

              mux(() => {
                try {
                  logger.debug('Applying delta', {
                    collection,
                    documentId,
                    bytesLength: crdtBytes.byteLength,
                  });

                  const itemBefore = documentId ? extractItem<DataType>(ymap, documentId) : null;
                  applyUpdate(ydoc, new Uint8Array(crdtBytes), YjsOrigin.Server);

                  if (!documentId) {
                    logger.debug('Delta applied (no documentId)', { collection });
                    return;
                  }

                  const itemAfter = extractItem<DataType>(ymap, documentId);
                  if (itemAfter) {
                    logger.debug('Upserting item after delta', { collection, documentId });
                    ops.upsert([itemAfter]);
                  } else if (itemBefore) {
                    logger.debug('Deleting item after delta', { collection, documentId });
                    ops.delete([itemBefore]);
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
                } finally {
                  // Clear document-level flag after delta processing
                  if (documentId) {
                    prose.setApplyingFromServer(collection, documentId, false);
                  }
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

                // Save checkpoint using persistence KV store
                if (newCheckpoint) {
                  try {
                    const key = `checkpoint:${collection}`;
                    await persistence.kv.set(key, newCheckpoint);
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

            // Clean up prose module state (debounce timers, pending state, observers)
            prose.cleanup(collection);

            const prefix = `${collection}:`;

            // Destroy fragment undo managers
            for (const [key, um] of fragmentUndoManagers) {
              if (key.startsWith(prefix)) {
                um.destroy();
                fragmentUndoManagers.delete(key);
              }
            }

            // Clean up mutex
            collectionMutex.delete(collection);

            // Clean up debounce config
            debounceConfig.delete(collection);

            // Clean up collection references
            collectionRefs.delete(collection);

            collectionUndoConfig.delete(collection);
            collectionDocs.delete(collection);
            docPersistence?.destroy();
            ydoc?.destroy();
            cleanupFunctions.delete(collection);
          },
        };
      },
    },
  };
}
