import * as Y from "yjs";
import { createMutex } from "lib0/mutex";
import type { Persistence, PersistenceProvider } from "$/client/persistence/types";
import type { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  createCollection,
  type CollectionConfig,
  type Collection,
  type NonSingleResult,
  type BaseCollectionConfig,
} from "@tanstack/db";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Effect } from "effect";
import { getLogger } from "$/client/logger";
import { ProseError, NonRetriableError } from "$/client/errors";
import { CursorService, createCursorLayer, type Cursor } from "$/client/services/cursor";
import { createReplicateOps, type BoundReplicateOps } from "$/client/replicate";
import {
  isDoc,
  fragmentFromJSON,
} from "$/client/merge";
import {
  createSubdocManager,
  extractDocumentFromSubdoc,
  extractAllDocuments,
  type SubdocManager,
} from "$/client/subdocs";
import * as prose from "$/client/prose";
import { extractProseFields } from "$/client/prose-schema";
import { CursorTracker } from "$/client/cursor-tracker";
import { z } from "zod";

/** Origin markers for Yjs transactions */
enum YjsOrigin {
  Local = "local",
  Fragment = "fragment",
  Server = "server",
}
import type { ProseFields } from "$/shared/types";

const logger = getLogger(["replicate", "collection"]);

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
  operation: "Insert" | "Update" | "Delete",
  collection: string,
): never {
  const httpError = error as HttpError;
  logger.error(`${operation} failed`, {
    collection,
    error: httpError?.message,
    status: httpError?.status,
  });

  if (httpError?.status === 401 || httpError?.status === 403) {
    throw new NonRetriableError("Authentication failed");
  }
  if (httpError?.status === 422) {
    throw new NonRetriableError("Validation error");
  }
  throw error;
}

const cleanupFunctions = new Map<string, () => void>();

/** Server-rendered material data for SSR hydration */
export interface Materialized<T> {
  documents: readonly T[];
  cursor?: Cursor;
  count?: number;
  crdtBytes?: ArrayBuffer;
}

/** API object from replicate() */
interface ConvexCollectionApi {
  stream: FunctionReference<"query">;
  insert: FunctionReference<"mutation">;
  update: FunctionReference<"mutation">;
  remove: FunctionReference<"mutation">;
  recovery: FunctionReference<"query">;
  mark: FunctionReference<"mutation">;
  compact: FunctionReference<"mutation">;
  material?: FunctionReference<"query">;
  sessions?: FunctionReference<"query">;
  cursors?: FunctionReference<"query">;
  leave?: FunctionReference<"mutation">;
}

export interface ConvexCollectionConfig<
  T extends object = object,
  TSchema extends StandardSchemaV1 = never,
  TKey extends string | number = string | number,
> extends BaseCollectionConfig<T, TKey, TSchema> {
  schema: TSchema;
  convexClient: ConvexClient;
  api: ConvexCollectionApi;
  persistence: Persistence;
  material?: Materialized<T>;
  undoCaptureTimeout?: number;
}

/** Editor binding for BlockNote/TipTap collaboration */
export interface EditorBinding {
  readonly fragment: Y.XmlFragment;
  readonly provider: { readonly awareness: null };
  readonly pending: boolean;
  readonly cursor: CursorTracker;

  onPendingChange(callback: (pending: boolean) => void): () => void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  destroy(): void;
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

// Module-level storage for SubdocManagers per collection
const collectionSubdocManagers = new Map<string, SubdocManager>();

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

const serverStateVectors = new Map<string, Uint8Array>();
const collectionPeerIds = new Map<string, string>();
const collectionConvexClients = new Map<string, ConvexClient>();
const collectionApis = new Map<string, ConvexCollectionApi>();

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
  fragment: Y.XmlFragment,
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

export function convexCollectionOptions<
  TSchema extends z.ZodObject<z.ZodRawShape>,
  TKey extends string | number = string | number,
>(
  config: ConvexCollectionConfig<z.infer<TSchema>, TSchema, TKey>,
): CollectionConfig<z.infer<TSchema>, TKey, TSchema, ConvexCollectionUtils<z.infer<TSchema>>> & {
  id: string;
  utils: ConvexCollectionUtils<z.infer<TSchema>>;
  schema: TSchema;
};

export function convexCollectionOptions(
  config: ConvexCollectionConfig<any, any, any>,
): CollectionConfig<any, any, any, ConvexCollectionUtils<any>> & {
  id: string;
  utils: ConvexCollectionUtils<any>;
  schema: any;
} {
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
  const collection = functionPath.split(":")[0];
  if (!collection) {
    throw new Error("Could not extract collection name from api.stream function reference");
  }

  const proseFields: string[]
    = schema && schema instanceof z.ZodObject ? extractProseFields(schema) : [];

  // DataType is 'any' in implementation - type safety comes from overload signatures
  type DataType = any;
  // Create a Set for O(1) lookup of prose fields
  const proseFieldSet = new Set<string>(proseFields);

  const utils: ConvexCollectionUtils<DataType> = {
    async prose(documentId: string, field: ProseFields<DataType>): Promise<EditorBinding> {
      const fieldStr = field;

      if (!proseFieldSet.has(fieldStr)) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection,
        });
      }

      let subdocManager = collectionSubdocManagers.get(collection);

      if (!subdocManager) {
        await new Promise<void>((resolve, reject) => {
          const maxWait = 10000;
          const startTime = Date.now();
          const check = setInterval(() => {
            if (collectionSubdocManagers.has(collection)) {
              clearInterval(check);
              resolve();
            }
            else if (Date.now() - startTime > maxWait) {
              clearInterval(check);
              reject(
                new ProseError({
                  documentId,
                  field: fieldStr,
                  collection,
                }),
              );
            }
          }, 10);
        });
        subdocManager = collectionSubdocManagers.get(collection);
      }

      if (!subdocManager) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection,
        });
      }

      const fragment = subdocManager.getFragment(documentId, fieldStr);
      if (!fragment) {
        throw new ProseError({
          documentId,
          field: fieldStr,
          collection,
        });
      }

      const subdoc = subdocManager.get(documentId);
      const collectionRef = collectionRefs.get(collection);
      if (collectionRef && subdoc) {
        prose.observeFragment({
          collection,
          documentId,
          field: fieldStr,
          fragment,
          ydoc: subdoc,
          ymap: subdocManager.getFields(documentId)!,
          collectionRef,
          debounceMs: debounceConfig.get(collection) ?? DEFAULT_DEBOUNCE_MS,
        });
      }

      const undoManager = getOrCreateFragmentUndoManager(
        collection,
        documentId,
        fieldStr,
        fragment,
      );

      const storedConvexClient = collectionConvexClients.get(collection);
      const storedApi = collectionApis.get(collection);
      const storedPeerId = collectionPeerIds.get(collection);

      let cursorTracker: CursorTracker | null = null;
      if (storedConvexClient && storedApi?.cursors && storedApi?.leave && storedPeerId) {
        cursorTracker = new CursorTracker({
          convexClient: storedConvexClient,
          api: {
            mark: storedApi.mark,
            cursors: storedApi.cursors,
            leave: storedApi.leave,
          },
          collection,
          document: documentId,
          client: storedPeerId,
          field: fieldStr,
        });
      }

      const binding: EditorBinding = {
        fragment,
        provider: { awareness: null },
        cursor: cursorTracker!,

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

        destroy() {
          cursorTracker?.destroy();
        },
      };

      return binding;
    },
  };

  const subdocManager = createSubdocManager(collection);
  let docPersistence: PersistenceProvider = null as any;

  collectionSubdocManagers.set(collection, subdocManager);

  // Bound replicate operations - set during sync initialization
  // Used by onDelete and other handlers that need to sync with TanStack DB
  let ops: BoundReplicateOps<DataType> = null as any;

  // Create services layer with the persistence KV store
  const cursorLayer = createCursorLayer(persistence.kv);

  let resolvePersistenceReady: (() => void) | undefined;
  const persistenceReadyPromise = new Promise<void>((resolve) => {
    resolvePersistenceReady = resolve;
  });

  let resolveOptimisticReady: (() => void) | undefined;
  const optimisticReadyPromise = new Promise<void>((resolve) => {
    resolveOptimisticReady = resolve;
  });

  const recover = async (): Promise<Cursor> => {
    if (!api.recovery) {
      logger.debug("No recovery API configured", { collection });
      return 0;
    }

    try {
      const localStateVector = Y.encodeStateVector(subdocManager.rootDoc);
      logger.debug("Starting recovery", {
        collection,
        localVectorSize: localStateVector.byteLength,
      });

      const response = await convexClient.query(api.recovery, {
        clientStateVector: localStateVector.buffer as ArrayBuffer,
      });

      if (response.serverStateVector) {
        serverStateVectors.set(collection, new Uint8Array(response.serverStateVector));
      }

      const cursor = response.cursor ?? 0;
      await persistence.kv.set(`cursor:${collection}`, cursor);
      logger.info("Recovery complete", { collection, cursor });
      return cursor;
    }
    catch (error) {
      logger.error("Recovery failed", { collection, error: String(error) });
      return 0;
    }
  };

  const applyYjsInsert = (mutations: CollectionMutation<DataType>[]): Uint8Array[] => {
    const deltas: Uint8Array[] = [];

    for (const mut of mutations) {
      const documentId = String(mut.key);
      const delta = subdocManager.transactWithDelta(
        documentId,
        (fieldsMap) => {
          Object.entries(mut.modified as Record<string, unknown>).forEach(([k, v]) => {
            if (proseFieldSet.has(k) && isDoc(v)) {
              const fragment = new Y.XmlFragment();
              fieldsMap.set(k, fragment);
              fragmentFromJSON(fragment, v);
            }
            else {
              fieldsMap.set(k, v);
            }
          });
        },
        YjsOrigin.Local,
      );
      deltas.push(delta);
    }

    return deltas;
  };

  const applyYjsUpdate = (mutations: CollectionMutation<DataType>[]): Uint8Array[] => {
    const deltas: Uint8Array[] = [];

    for (const mut of mutations) {
      const documentId = String(mut.key);
      const fieldsMap = subdocManager.getFields(documentId);

      if (!fieldsMap) {
        logger.error("Update attempted on non-existent document", { collection, documentId });
        continue;
      }

      const modifiedFields = mut.modified as Record<string, unknown>;
      if (!modifiedFields) {
        logger.warn("mut.modified is null/undefined", { collection, documentId });
        continue;
      }

      const delta = subdocManager.transactWithDelta(
        documentId,
        (fields) => {
          Object.entries(modifiedFields).forEach(([k, v]) => {
            if (proseFieldSet.has(k)) {
              logger.debug("Skipping prose field in applyYjsUpdate", { field: k });
              return;
            }

            const existingValue = fields.get(k);
            if (existingValue instanceof Y.XmlFragment) {
              logger.debug("Preserving live fragment field", { field: k });
              return;
            }

            fields.set(k, v);
          });
        },
        YjsOrigin.Local,
      );
      deltas.push(delta);
    }

    return deltas;
  };

  const applyYjsDelete = (mutations: CollectionMutation<DataType>[]): Uint8Array[] => {
    const deltas: Uint8Array[] = [];

    for (const mut of mutations) {
      const documentId = String(mut.key);
      const delta = subdocManager.encodeState(documentId);
      subdocManager.delete(documentId);
      deltas.push(delta);
    }

    return deltas;
  };

  return {
    id: collection,
    getKey,
    schema: schema,
    utils,

    onInsert: async ({ transaction }: CollectionTransaction<DataType>) => {
      const deltas = applyYjsInsert(transaction.mutations);

      try {
        await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);

        for (let i = 0; i < transaction.mutations.length; i++) {
          const mut = transaction.mutations[i];
          const delta = deltas[i];
          if (!delta || delta.length === 0) continue;

          const documentId = String(mut.key);
          const materializedDoc = extractDocumentFromSubdoc(subdocManager, documentId)
            ?? mut.modified;

          await convexClient.mutation(api.insert, {
            documentId,
            crdtBytes: delta.slice().buffer,
            materializedDoc,
          });
        }
      }
      catch (error) {
        handleMutationError(error, "Insert", collection);
      }
    },

    onUpdate: async ({ transaction }: CollectionTransaction<DataType>) => {
      const mutation = transaction.mutations[0];
      const documentKey = String(mutation.key);

      if (prose.isApplyingFromServer(collection, documentKey)) {
        logger.debug("Skipping onUpdate - data from server", { collection, documentKey });
        return;
      }

      const metadata = mutation.metadata as { contentSync?: ContentSyncMetadata } | undefined;
      const isContentSync = !!metadata?.contentSync;

      const deltas = isContentSync ? null : applyYjsUpdate(transaction.mutations);

      try {
        await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);

        if (isContentSync && metadata?.contentSync) {
          const { crdtBytes, materializedDoc } = metadata.contentSync;
          await convexClient.mutation(api.update, {
            documentId: documentKey,
            crdtBytes,
            materializedDoc,
          });
          return;
        }

        if (deltas) {
          for (let i = 0; i < transaction.mutations.length; i++) {
            const mut = transaction.mutations[i];
            const delta = deltas[i];
            if (!delta || delta.length === 0) continue;

            const docId = String(mut.key);
            const fullDoc = extractDocumentFromSubdoc(subdocManager, docId) ?? mut.modified;

            await convexClient.mutation(api.update, {
              documentId: docId,
              crdtBytes: delta.slice().buffer,
              materializedDoc: fullDoc,
            });
          }
        }
      }
      catch (error) {
        handleMutationError(error, "Update", collection);
      }
    },

    onDelete: async ({ transaction }: CollectionTransaction<DataType>) => {
      const deltas = applyYjsDelete(transaction.mutations);

      try {
        await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
        const itemsToDelete = transaction.mutations
          .map(mut => mut.original)
          .filter((item): item is DataType => item !== undefined && Object.keys(item).length > 0);
        ops.delete(itemsToDelete);

        for (let i = 0; i < transaction.mutations.length; i++) {
          const mut = transaction.mutations[i];
          const delta = deltas[i];
          if (!delta || delta.length === 0) continue;

          await convexClient.mutation(api.remove, {
            documentId: String(mut.key),
            crdtBytes: delta.slice().buffer,
          });
        }
      }
      catch (error) {
        handleMutationError(error, "Delete", collection);
      }
    },

    sync: {
      rowUpdateMode: "partial",
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
        const ssrCursor = material?.cursor;
        const ssrCRDTBytes = material?.crdtBytes;
        const docs: DataType[] = ssrDocuments ? [...ssrDocuments] : [];

        (async () => {
          try {
            const trackedOrigins = new Set([YjsOrigin.Local]);
            collectionUndoConfig.set(collection, {
              captureTimeout: undoCaptureTimeout,
              trackedOrigins,
            });

            docPersistence = persistence.createDocPersistence(collection, subdocManager.rootDoc);

            subdocManager.enablePersistence((documentId, subdoc) => {
              return persistence.createDocPersistence(`${collection}:${documentId}`, subdoc);
            });

            docPersistence.whenSynced.then(() => {
              logger.debug("Persistence synced", { collection });
              resolvePersistenceReady?.();
            });
            await persistenceReadyPromise;
            const docCount = subdocManager.documentIds().length;
            logger.info("Persistence ready", { collection, subdocCount: docCount });

            ops = createReplicateOps<DataType>(params);
            resolveOptimisticReady?.();

            if (ssrCRDTBytes) {
              const update = new Uint8Array(ssrCRDTBytes);
              Y.applyUpdateV2(subdocManager.rootDoc, update, YjsOrigin.Server);
            }

            const recoveryCursor = await recover();

            const docIds = subdocManager.documentIds();
            if (docIds.length > 0) {
              const items = extractAllDocuments(subdocManager) as DataType[];
              ops.replace(items);
              logger.info("Data loaded to TanStack DB", {
                collection,
                itemCount: items.length,
              });
            }
            else {
              ops.replace([]);
              logger.info("No data, cleared TanStack DB", { collection });
            }

            markReady();
            logger.info("Collection ready", { collection, subdocCount: docIds.length });

            const peerId = await Effect.runPromise(
              Effect.gen(function* () {
                const cursorSvc = yield* CursorService;
                return yield* cursorSvc.loadPeerId(collection);
              }).pipe(Effect.provide(cursorLayer)),
            );

            collectionPeerIds.set(collection, peerId);
            collectionConvexClients.set(collection, convexClient);
            collectionApis.set(collection, api);

            const cursor = ssrCursor ?? recoveryCursor;

            logger.info("Starting subscription", {
              collection,
              cursor,
              peerId,
              source: ssrCursor !== undefined ? "SSR" : "recovery",
            });

            // Get mutex for thread-safe updates
            const mux = getOrCreateMutex(collection);

            const handleSnapshotChange = (crdtBytes: ArrayBuffer, documentId: string) => {
              prose.cancelAllPending(collection);

              mux(() => {
                try {
                  logger.debug("Applying snapshot", {
                    collection,
                    documentId,
                    bytesLength: crdtBytes.byteLength,
                  });
                  const update = new Uint8Array(crdtBytes);
                  subdocManager.applyUpdate(documentId, update, YjsOrigin.Server);
                  const item = extractDocumentFromSubdoc(subdocManager, documentId);
                  if (item) {
                    ops.upsert([item as DataType]);
                  }
                  logger.debug("Snapshot applied", { collection, documentId });
                }
                catch (error) {
                  const msg = String(error);
                  logger.error("Error applying snapshot", { collection, documentId, error: msg });
                  throw new Error(`Snapshot application failed: ${error}`);
                }
              });
            };

            const handleDeltaChange = (crdtBytes: ArrayBuffer, documentId: string | undefined) => {
              if (!documentId) {
                logger.debug("Delta skipped (no documentId)", { collection });
                return;
              }

              prose.cancelPending(collection, documentId);
              prose.setApplyingFromServer(collection, documentId, true);

              mux(() => {
                try {
                  logger.debug("Applying delta", {
                    collection,
                    documentId,
                    bytesLength: crdtBytes.byteLength,
                  });

                  const itemBefore = extractDocumentFromSubdoc(subdocManager, documentId);
                  const update = new Uint8Array(crdtBytes);
                  subdocManager.applyUpdate(documentId, update, YjsOrigin.Server);

                  const itemAfter = extractDocumentFromSubdoc(subdocManager, documentId);
                  if (itemAfter) {
                    logger.debug("Upserting item after delta", { collection, documentId });
                    ops.upsert([itemAfter as DataType]);
                  }
                  else if (itemBefore) {
                    logger.debug("Deleting item after delta", { collection, documentId });
                    ops.delete([itemBefore as DataType]);
                  }
                  else {
                    logger.debug("No change detected after delta", { collection, documentId });
                  }
                }
                catch (error) {
                  logger.error("Error applying delta", {
                    collection,
                    documentId,
                    error: String(error),
                  });
                  throw new Error(`Delta application failed for ${documentId}: ${error}`);
                }
                finally {
                  prose.setApplyingFromServer(collection, documentId, false);
                }
              });
            };

            const handleSubscriptionUpdate = async (response: any) => {
              try {
                if (!response || !Array.isArray(response.changes)) {
                  logger.error("Invalid subscription response", { response });
                  return;
                }

                const { changes, cursor: newCursor, compact: compactHint } = response;
                const syncedDocuments = new Set<string>();

                for (const change of changes) {
                  const { operationType, crdtBytes, documentId } = change;
                  if (!crdtBytes || !documentId) {
                    logger.warn("Skipping change with missing crdtBytes or documentId", { change });
                    continue;
                  }

                  syncedDocuments.add(documentId);

                  try {
                    if (operationType === "snapshot") {
                      handleSnapshotChange(crdtBytes, documentId);
                    }
                    else {
                      handleDeltaChange(crdtBytes, documentId);
                    }
                  }
                  catch (changeError) {
                    logger.error("Failed to apply change", {
                      operationType,
                      documentId,
                      error: String(changeError),
                    });
                  }
                }

                if (newCursor !== undefined) {
                  try {
                    const key = `cursor:${collection}`;
                    await persistence.kv.set(key, newCursor);
                    logger.debug("Cursor saved", { collection, cursor: newCursor });

                    for (const documentId of syncedDocuments) {
                      await convexClient.mutation(api.mark, {
                        document: documentId,
                        client: peerId,
                        seq: newCursor,
                      });
                    }
                    logger.debug("Ack sent", {
                      collection,
                      client: peerId,
                      seq: newCursor,
                      documents: syncedDocuments.size,
                    });
                  }
                  catch (ackError) {
                    logger.error("Failed to save cursor or ack", {
                      collection,
                      error: String(ackError),
                    });
                  }
                }

                if (compactHint) {
                  try {
                    const subdoc = subdocManager.get(compactHint);
                    if (subdoc) {
                      const snapshot = Y.encodeStateAsUpdate(subdoc);
                      const stateVector = Y.encodeStateVector(subdoc);
                      await convexClient.mutation(api.compact, {
                        documentId: compactHint,
                        snapshotBytes: snapshot.buffer,
                        stateVector: stateVector.buffer,
                      });
                      logger.info("Compaction triggered", { collection, documentId: compactHint });
                    }
                  }
                  catch (compactError) {
                    logger.error("Compaction failed", {
                      collection,
                      documentId: compactHint,
                      error: String(compactError),
                    });
                  }
                }
              }
              catch (error) {
                logger.error("Subscription handler error", { collection, error: String(error) });
              }
            };

            logger.info("Establishing subscription", {
              collection,
              cursor,
              limit: 1000,
            });

            subscription = convexClient.onUpdate(
              api.stream,
              { cursor, limit: 1000 },
              (response: any) => {
                logger.debug("Subscription received update", {
                  collection,
                  changesCount: response.changes?.length ?? 0,
                  cursor: response.cursor,
                  hasMore: response.hasMore,
                });

                handleSubscriptionUpdate(response);
              },
            );

            // Note: markReady() was already called above (local-first)
            // Subscription is background replication, not blocking
            logger.info("Subscription established", { collection });
          }
          catch (error) {
            logger.error("Failed to set up collection", { error, collection });
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
            collectionSubdocManagers.delete(collection);
            collectionPeerIds.delete(collection);
            collectionConvexClients.delete(collection);
            collectionApis.delete(collection);
            docPersistence?.destroy();
            subdocManager?.destroy();
            cleanupFunctions.delete(collection);
          },
        };
      },
    },
  };
}

type LazyCollectionConfig<TSchema extends z.ZodObject<z.ZodRawShape>> = Omit<
  ConvexCollectionConfig<z.infer<TSchema>, TSchema, string>,
  "persistence" | "material"
>;

interface LazyCollection<T extends object> {
  init(material?: Materialized<T>): Promise<void>;
  get(): Collection<T, string, ConvexCollectionUtils<T>, any, T> & NonSingleResult;
}

export type ConvexCollection<T extends object>
  = Collection<T, any, ConvexCollectionUtils<T>, any, T> & NonSingleResult;

interface CreateCollectionOptions<TSchema extends z.ZodObject<z.ZodRawShape>> {
  persistence: () => Promise<Persistence>;
  config: () => Omit<LazyCollectionConfig<TSchema>, "material">;
}

export const collection = {
  create<TSchema extends z.ZodObject<z.ZodRawShape>>(
    options: CreateCollectionOptions<TSchema>,
  ): LazyCollection<z.infer<TSchema>> {
    let persistence: Persistence | null = null;
    let resolvedConfig: LazyCollectionConfig<TSchema> | null = null;
    let material: Materialized<z.infer<TSchema>> | undefined;
    type Instance = LazyCollection<z.infer<TSchema>>["get"] extends () => infer R ? R : never;
    let instance: Instance | null = null;

    return {
      async init(mat?: Materialized<z.infer<TSchema>>) {
        if (!persistence) {
          persistence = await options.persistence();
          resolvedConfig = options.config();
          material = mat;
        }
      },

      get() {
        if (!persistence || !resolvedConfig) {
          throw new Error("Call init() before get()");
        }
        if (!instance) {
          const opts = convexCollectionOptions({
            ...resolvedConfig,
            persistence,
            material,
          } as any);
          instance = createCollection(opts) as any;
        }
        return instance!;
      },
    };
  },
};
