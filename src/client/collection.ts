import * as Y from "yjs";
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
import type { SchemaDefinition } from "convex/server";
import type { GenericValidator } from "convex/values";
import type { VersionedSchema } from "$/server/migration";
import type { MigrationErrorHandler, ClientMigrationMap } from "$/client/migration";
import { runMigrations } from "$/client/migration";
import type { DocFromSchema, TableNamesFromSchema } from "$/client/types";
import { findProseFields } from "$/client/validators";
import { ProseError, NonRetriableError } from "$/client/errors";
import { createSeqService, type Seq } from "$/client/services/seq";
import { getClientId } from "$/client/services/session";
import { createReplicateOps, type BoundReplicateOps } from "$/client/ops";
import { isDoc, fragmentFromJSON } from "$/client/merge";
import { createDocumentManager, serializeDocument, extractAllDocuments } from "$/client/documents";
import { createDeleteDelta, applyDeleteMarkerToDoc } from "$/client/deltas";
import * as prose from "$/client/prose";
import { getLogger } from "$/client/logger";
import {
	initContext,
	getContext,
	hasContext,
	updateContext,
	deleteContext,
} from "$/client/services/context";
import { createAwarenessProvider, type ConvexAwarenessProvider } from "$/client/services/awareness";
import {
	createDocumentPresence,
	type DocumentHandle,
	type DocumentPresence,
	type DocumentPresenceProvider,
	type PresenceState,
} from "$/client/document";

export type { DocumentHandle, DocumentPresence, PresenceState };
import type { UserIdentity } from "$/client/identity";
import { Awareness } from "y-protocols/awareness";

enum YjsOrigin {
	Local = "local",
	Fragment = "fragment",
	Server = "server",
}

const noop = (): void => undefined;

const logger = getLogger(["replicate", "collection"]);

import type { ProseFields } from "$/shared/types";

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

interface ContentSyncMetadata {
	bytes: ArrayBuffer;
	material: unknown;
}

/** Transaction wrapper containing mutations array */
interface CollectionTransaction<T> {
	transaction: {
		mutations: CollectionMutation<T>[];
	};
}

function handleMutationError(error: unknown): never {
	const httpError = error as HttpError;

	if (httpError?.status === 401 || httpError?.status === 403) {
		throw new NonRetriableError("Authentication failed");
	}
	if (httpError?.status === 422) {
		throw new NonRetriableError("Validation error");
	}
	throw error;
}

/** Server-rendered material data for SSR hydration */
export interface Materialized<T> {
	documents: readonly T[];
	cursor?: Seq;
	count?: number;
	crdt?: Record<string, { bytes: ArrayBuffer; seq: number }>;
}

export interface PaginatedPage<T> {
	page: readonly T[];
	isDone: boolean;
	continueCursor: string;
}

export interface PaginatedMaterial<T> {
	pages: readonly PaginatedPage<T>[];
	cursor: string;
	isDone: boolean;
}

export interface PaginationConfig {
	pageSize?: number;
}

export type PaginationStatus = "idle" | "busy" | "done" | "error";

export interface PaginationState {
	status: PaginationStatus;
	count: number;
	cursor: string | null;
	error?: Error;
}

interface ConvexCollectionApi {
	material: FunctionReference<"query">;
	delta: FunctionReference<"query">;
	replicate: FunctionReference<"mutation">;
	presence: FunctionReference<"mutation">;
	session: FunctionReference<"query">;
}

export interface ConvexCollectionConfig<
	T extends object = object,
	TKey extends string | number = string | number,
> extends Omit<BaseCollectionConfig<T, TKey, never>, "schema"> {
	validator?: GenericValidator;
	convexClient: ConvexClient;
	api: ConvexCollectionApi;
	persistence: Persistence;
	material?: Materialized<T>;
	user?: () => UserIdentity | undefined;
}

/**
 * Binding returned by collection.utils.prose() for collaborative editing.
 *
 * Compatible with TipTap's Collaboration/CollaborationCursor and BlockNote's
 * collaboration config. The editor handles undo/redo internally via y-prosemirror.
 */
export interface EditorBinding {
	/** Yjs XmlFragment for content sync */
	readonly fragment: Y.XmlFragment;

	/**
	 * Provider with Yjs Awareness for cursor/presence sync.
	 * Pass to CollaborationCursor.configure({ provider: binding.provider })
	 * or BlockNote's collaboration.provider
	 */
	readonly provider: {
		readonly awareness: Awareness;
		readonly document: Y.Doc;
	};

	/** Whether there are unsaved local changes */
	readonly pending: boolean;

	/** Subscribe to pending state changes */
	onPendingChange(callback: (pending: boolean) => void): () => void;

	/** Cleanup - call when unmounting editor */
	destroy(): void;
}

export interface ProseOptions {
	/** User identity for collaborative presence */
	user?: UserIdentity;
	/**
	 * Debounce delay in milliseconds before syncing changes to server.
	 * Local changes are batched during this window for efficiency.
	 * @default 200
	 */
	debounceMs?: number;
}

interface ConvexCollectionUtils<T extends object> {
	prose(document: string, field: ProseFields<T>, options?: ProseOptions): Promise<EditorBinding>;
}

export interface SessionInfo {
	client: string;
	document: string;
	user?: string;
	profile?: { name?: string; color?: string; avatar?: string };
	cursor?: unknown;
	connected: boolean;
}

export interface SessionAPI {
	get(docId?: string): SessionInfo[];
	subscribe(callback: (sessions: SessionInfo[]) => void): () => void;
}

interface ConvexCollectionExtensions<T extends object> {
	doc(id: string): DocumentHandle<T>;
	readonly session: SessionAPI;
}

export function convexCollectionOptions<
	T extends object = object,
	TKey extends string | number = string | number,
>(
	config: ConvexCollectionConfig<T, TKey>,
): CollectionConfig<T, TKey, never, ConvexCollectionUtils<T>> & {
	id: string;
	utils: ConvexCollectionUtils<T>;
	extensions: ConvexCollectionExtensions<T>;
} {
	const { validator, getKey, material, convexClient, api, persistence, user: userGetter } = config;

	const functionPath = getFunctionName(api.delta);
	const collection = functionPath.split(":")[0];
	if (!collection) {
		throw new Error("Could not extract collection name from api.delta function reference");
	}

	const proseFields: string[] = validator ? findProseFields(validator) : [];

	// DataType is 'any' in implementation - type safety comes from overload signatures
	type DataType = any;
	// Create a Set for O(1) lookup of prose fields
	const proseFieldSet = new Set<string>(proseFields);

	const utils: ConvexCollectionUtils<DataType> = {
		async prose(
			document: string,
			field: ProseFields<DataType>,
			options?: ProseOptions,
		): Promise<EditorBinding> {
			const fieldStr = field;

			if (!proseFieldSet.has(fieldStr)) {
				throw new ProseError({
					document,
					field: fieldStr,
					collection,
				});
			}

			let ctx = hasContext(collection) ? getContext(collection) : null;

			if (!ctx) {
				await new Promise<void>((resolve, reject) => {
					const maxWait = 10000;
					const startTime = Date.now();
					const check = setInterval(() => {
						if (hasContext(collection)) {
							clearInterval(check);
							resolve();
						} else if (Date.now() - startTime > maxWait) {
							clearInterval(check);
							reject(
								new ProseError({
									document,
									field: fieldStr,
									collection,
								}),
							);
						}
					}, 10);
				});
				ctx = hasContext(collection) ? getContext(collection) : null;
			}

			if (!ctx) {
				throw new ProseError({
					document,
					field: fieldStr,
					collection,
				});
			}

			const fragment = ctx.docManager.getFragment(document, fieldStr);
			if (!fragment) {
				throw new ProseError({
					document,
					field: fieldStr,
					collection,
				});
			}

			const subdoc = ctx.docManager.get(document);
			if (!subdoc) {
				throw new ProseError({
					document,
					field: fieldStr,
					collection,
				});
			}

			const collectionRef = ctx.ref;
			if (collectionRef) {
				prose.observeFragment({
					collection,
					document,
					field: fieldStr,
					fragment,
					ydoc: subdoc,
					ymap: ctx.docManager.getFields(document)!,
					collectionRef,
					debounceMs: options?.debounceMs,
				});
			}

			const storedConvexClient = ctx.client;
			const storedApi = ctx.api;
			const storedClientId = ctx.clientId;

			let awarenessProvider: ConvexAwarenessProvider | null = null;
			const hasPresenceApi = storedApi?.session && storedApi?.presence;
			if (storedConvexClient && hasPresenceApi && storedClientId) {
				const resolvedUser = options?.user ?? ctx.userGetter?.();
				awarenessProvider = createAwarenessProvider({
					convexClient: storedConvexClient,
					api: {
						presence: storedApi.presence!,
						session: storedApi.session!,
					},
					document,
					client: storedClientId,
					ydoc: subdoc,
					syncReady: ctx.synced,
					user: resolvedUser,
				});
			}

			const binding: EditorBinding = {
				fragment,
				provider: awarenessProvider
					? { awareness: awarenessProvider.awareness, document: subdoc }
					: { awareness: new Awareness(subdoc), document: subdoc },

				get pending() {
					return prose.isPending(collection, document);
				},

				onPendingChange(callback: (pending: boolean) => void) {
					return prose.subscribePending(collection, document, callback);
				},

				destroy() {
					awarenessProvider?.destroy();
				},
			};

			return binding;
		},
	};

	const documentHandles = new Map<string, DocumentHandle<DataType>>();
	const presenceProviders = new Map<string, DocumentPresenceProvider>();

	const getOrCreateDocumentHandle = (documentId: string): DocumentHandle<DataType> => {
		let handle = documentHandles.get(documentId);
		if (handle) return handle;

		const ctx = hasContext(collection) ? getContext(collection) : null;
		if (!ctx) {
			throw new Error(`Collection ${collection} not initialized. Call init() first.`);
		}

		const subdoc = ctx.docManager.getOrCreate(documentId);

		let presenceProvider = presenceProviders.get(documentId);
		if (!presenceProvider) {
			const hasPresenceApi = ctx.api?.session && ctx.api?.presence;
			if (ctx.client && hasPresenceApi && ctx.clientId) {
				presenceProvider = createDocumentPresence({
					convexClient: ctx.client,
					api: {
						presence: ctx.api.presence!,
						session: ctx.api.session!,
					},
					document: documentId,
					client: ctx.clientId,
					ydoc: subdoc,
					syncReady: ctx.synced,
					userGetter: ctx.userGetter,
				});
				presenceProviders.set(documentId, presenceProvider);
			}
		}

		const presence: DocumentPresence = presenceProvider ?? {
			join: () => {},
			leave: () => {},
			update: () => {},
			get: () => ({ local: null, remote: [] }),
			subscribe: () => () => {},
		};

		handle = {
			id: documentId,
			presence,
			awareness: presenceProvider?.awareness ?? new Awareness(subdoc),

			async prose(field: ProseFields<DataType>, options?: ProseOptions): Promise<EditorBinding> {
				return utils.prose(documentId, field, options);
			},
		};

		documentHandles.set(documentId, handle);
		return handle;
	};

	let sessionCache: SessionInfo[] = [];
	const sessionSubscribers = new Set<(sessions: SessionInfo[]) => void>();
	let sessionUnsubscribe: (() => void) | null = null;

	const initSessionSubscription = (): void => {
		if (sessionUnsubscribe) return;

		const ctx = hasContext(collection) ? getContext(collection) : null;
		if (!ctx?.client || !ctx?.api?.session) return;

		sessionUnsubscribe = ctx.client.onUpdate(
			ctx.api.session,
			{ connected: true },
			(sessions: SessionInfo[]) => {
				sessionCache = sessions;
				sessionSubscribers.forEach(cb => cb(sessions));
			},
		);
	};

	const sessionApi: SessionAPI = {
		get(docId?: string): SessionInfo[] {
			if (docId) {
				return sessionCache.filter(s => s.document === docId);
			}
			return sessionCache;
		},

		subscribe(callback: (sessions: SessionInfo[]) => void): () => void {
			initSessionSubscription();
			sessionSubscribers.add(callback);
			callback(sessionCache);
			return () => {
				sessionSubscribers.delete(callback);
				if (sessionSubscribers.size === 0 && sessionUnsubscribe) {
					sessionUnsubscribe();
					sessionUnsubscribe = null;
				}
			};
		},
	};

	const extensions: ConvexCollectionExtensions<DataType> = {
		doc(id: string): DocumentHandle<DataType> {
			return getOrCreateDocumentHandle(id);
		},
		session: sessionApi,
	};

	const docManager = createDocumentManager(collection);
	const docPersistence: PersistenceProvider = null as any;

	initContext({
		collection,
		docManager,
		client: convexClient,
		api,
		persistence,
		fields: proseFieldSet,
		userGetter,
	});

	// Bound replicate operations - set during sync initialization
	// Used by onDelete and other handlers that need to sync with TanStack DB
	let ops: BoundReplicateOps<DataType> = null as any;

	// Create seq service with the persistence KV store
	const seqService = createSeqService(persistence.kv);

	let resolvePersistenceReady: (() => void) | undefined;
	const persistenceReadyPromise = new Promise<void>(resolve => {
		resolvePersistenceReady = resolve;
	});

	let resolveOptimisticReady: (() => void) | undefined;
	const optimisticReadyPromise = new Promise<void>(resolve => {
		resolveOptimisticReady = resolve;
	});

	const recover = async (): Promise<void> => {
		const docIds = docManager.documents();
		if (docIds.length === 0) return;

		const recoveryPromises = docIds.map(async docId => {
			try {
				const vector = docManager.encodeStateVector(docId);
				const result = await convexClient.query(api.delta, {
					document: docId,
					vector: vector.buffer as ArrayBuffer,
				});

				if (result.mode === "recovery" && result.diff) {
					const update = new Uint8Array(result.diff);
					docManager.applyUpdate(docId, update, YjsOrigin.Server);
				}
			} catch {
				noop();
			}
		});

		await Promise.all(recoveryPromises);
	};

	const applyYjsInsert = (mutations: CollectionMutation<DataType>[]): Uint8Array[] => {
		const deltas: Uint8Array[] = [];

		for (const mut of mutations) {
			const document = String(mut.key);
			const delta = docManager.transactWithDelta(
				document,
				fieldsMap => {
					Object.entries(mut.modified as Record<string, unknown>).forEach(([k, v]) => {
						if (proseFieldSet.has(k) && isDoc(v)) {
							const fragment = new Y.XmlFragment();
							fieldsMap.set(k, fragment);
							fragmentFromJSON(fragment, v);
						} else {
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
			const document = String(mut.key);
			const fieldsMap = docManager.getFields(document);

			if (!fieldsMap) {
				continue;
			}

			const modifiedFields = mut.modified as Record<string, unknown>;
			if (!modifiedFields) {
				continue;
			}

			const delta = docManager.transactWithDelta(
				document,
				fields => {
					Object.entries(modifiedFields).forEach(([k, v]) => {
						if (proseFieldSet.has(k)) {
							return;
						}

						const existingValue = fields.get(k);
						if (existingValue instanceof Y.XmlFragment) {
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
			const document = String(mut.key);
			const ydoc = docManager.get(document);

			if (ydoc) {
				const delta = applyDeleteMarkerToDoc(ydoc);
				deltas.push(delta);
			} else {
				const delta = createDeleteDelta();
				deltas.push(delta);
			}
		}

		return deltas;
	};

	return {
		id: collection,
		getKey,
		utils,
		extensions,

		onInsert: async ({ transaction }: CollectionTransaction<DataType>) => {
			const deltas = applyYjsInsert(transaction.mutations);

			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);

				for (let i = 0; i < transaction.mutations.length; i++) {
					const mut = transaction.mutations[i];
					const delta = deltas[i];
					if (!delta || delta.length === 0) continue;

					const document = String(mut.key);
					const materializedDoc = serializeDocument(docManager, document) ?? mut.modified;

					await convexClient.mutation(api.replicate, {
						document: document,
						bytes: delta.slice().buffer,
						material: materializedDoc,
						type: "insert",
					});
				}
			} catch (error) {
				handleMutationError(error);
			}
		},

		onUpdate: async ({ transaction }: CollectionTransaction<DataType>) => {
			const mutation = transaction.mutations[0];
			const documentKey = String(mutation.key);

			const metadata = mutation.metadata as { contentSync?: ContentSyncMetadata } | undefined;
			const isContentSync = !!metadata?.contentSync;

			const deltas = isContentSync ? null : applyYjsUpdate(transaction.mutations);

			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);

				if (isContentSync && metadata?.contentSync) {
					const { bytes, material } = metadata.contentSync;
					await convexClient.mutation(api.replicate, {
						document: documentKey,
						bytes,
						material,
						type: "update",
					});
					return;
				}

				if (deltas) {
					for (let i = 0; i < transaction.mutations.length; i++) {
						const mut = transaction.mutations[i];
						const delta = deltas[i];
						if (!delta || delta.length === 0) continue;

						const docId = String(mut.key);
						const fullDoc = serializeDocument(docManager, docId) ?? mut.modified;

						await convexClient.mutation(api.replicate, {
							document: docId,
							bytes: delta.slice().buffer,
							material: fullDoc,
							type: "update",
						});
					}
				}
			} catch (error) {
				handleMutationError(error);
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

					await convexClient.mutation(api.replicate, {
						document: String(mut.key),
						bytes: delta.slice().buffer,
						type: "delete",
					});
				}
			} catch (error) {
				handleMutationError(error);
			}
		},

		sync: {
			rowUpdateMode: "partial",
			sync: (params: any) => {
				const { markReady, collection: collectionInstance } = params;

				updateContext(collection, { ref: collectionInstance });

				const ctx = getContext(collection);
				if (ctx.cleanup) {
					ctx.cleanup();
					ctx.cleanup = undefined;
				}

				let subscription: (() => void) | null = null;
				const ssrDocuments = material?.documents;
				type CrdtRecord = Record<string, { bytes: ArrayBuffer; seq: number }>;
				const ssrCrdt = material?.crdt as CrdtRecord | undefined;
				const ssrCursor = material?.cursor;
				const docs: DataType[] = ssrDocuments ? [...ssrDocuments] : [];

				(async () => {
					try {
						const existingDocIds = await persistence.listDocuments(collection);
						for (const docId of existingDocIds) {
							docManager.getOrCreate(docId);
						}

						const docPromises = docManager.enablePersistence((document, ydoc) => {
							return persistence.createDocPersistence(`${collection}:${document}`, ydoc);
						});
						await Promise.all(docPromises);

						resolvePersistenceReady?.();

						const clientId = await getClientId(persistence.kv);
						updateContext(collection, { clientId });

						ops = createReplicateOps<DataType>(params);
						resolveOptimisticReady?.();

						if (ssrCrdt) {
							for (const [docId, state] of Object.entries(ssrCrdt)) {
								const update = new Uint8Array(state.bytes);
								docManager.applyUpdate(docId, update, YjsOrigin.Server);
							}
						}

						await recover();

						const docIds = docManager.documents();
						if (docIds.length > 0) {
							const items = extractAllDocuments(docManager) as DataType[];
							ops.replace(items);
						} else {
							ops.replace([]);
						}

						markReady();
						getContext(collection).resolve?.();

						const persistedCursor = await seqService.load(collection);
						let cursor = ssrCursor ?? persistedCursor;

						if (cursor > 0 && docManager.documents().length === 0) {
							cursor = 0;
							persistence.kv.set(`cursor:${collection}`, 0);
						}

						// Signal that sync is ready (no actor system needed - sync manager is self-contained)
						getContext(collection).resolveActorReady?.();

						const handleSnapshotChange = async (
							bytes: ArrayBuffer,
							document: string,
							exists: boolean,
						) => {
							const hadLocally = docManager.has(document);

							if (!exists && hadLocally) {
								const itemBefore = serializeDocument(docManager, document);
								if (itemBefore) {
									ops.delete([itemBefore as DataType]);
								}
								docManager.delete(document);
								return;
							}

							if (!exists && !hadLocally) {
								return;
							}

							const itemBefore = serializeDocument(docManager, document);
							const update = new Uint8Array(bytes);
							docManager.applyUpdate(document, update, YjsOrigin.Server);
							const itemAfter = serializeDocument(docManager, document);

							if (itemAfter) {
								if (itemBefore) {
									ops.upsert([itemAfter as DataType]);
								} else {
									ops.insert([itemAfter as DataType]);
								}
							} else if (itemBefore) {
								// itemAfter is null but itemBefore exists - document serialization failed
								// Keep existing item to prevent data loss
								logger.warn("Document serialization returned null after snapshot update", {
									document,
									collection,
									hadFieldsAfter: !!docManager.getFields(document),
								});
								// Re-add the previous item to prevent it from disappearing
								ops.upsert([itemBefore as DataType]);
							}
						};

						const handleDeltaChange = async (
							bytes: ArrayBuffer,
							document: string | undefined,
							exists: boolean,
						) => {
							if (!document) {
								return;
							}

							const hadLocally = docManager.has(document);

							if (!exists && hadLocally) {
								const itemBefore = serializeDocument(docManager, document);
								if (itemBefore) {
									ops.delete([itemBefore as DataType]);
								}
								docManager.delete(document);
								return;
							}

							if (!exists && !hadLocally) {
								return;
							}

							const itemBefore = serializeDocument(docManager, document);
							const update = new Uint8Array(bytes);
							docManager.applyUpdate(document, update, YjsOrigin.Server);
							const itemAfter = serializeDocument(docManager, document);

							if (itemAfter) {
								if (itemBefore) {
									ops.upsert([itemAfter as DataType]);
								} else {
									ops.insert([itemAfter as DataType]);
								}
							} else if (itemBefore) {
								// itemAfter is null but itemBefore exists - document serialization failed
								// Keep existing item to prevent data loss
								logger.warn("Document serialization returned null after delta update", {
									document,
									collection,
									hadFieldsAfter: !!docManager.getFields(document),
								});
								// Re-add the previous item to prevent it from disappearing
								ops.upsert([itemBefore as DataType]);
							}
						};

						const handleSubscriptionUpdate = async (response: any) => {
							if (!response || !Array.isArray(response.changes)) {
								return;
							}

							const { changes, seq: newSeq } = response;
							const syncedDocuments = new Set<string>();

							for (const change of changes) {
								const { type, bytes, document, exists } = change;
								if (!bytes || !document) {
									continue;
								}

								syncedDocuments.add(document);

								if (type === "snapshot") {
									await handleSnapshotChange(bytes, document, exists ?? true);
								} else {
									await handleDeltaChange(bytes, document, exists ?? true);
								}
							}

							if (newSeq !== undefined) {
								persistence.kv.set(`cursor:${collection}`, newSeq);

								// Mark presence for synced documents - fire and forget but log errors
								// Using void to explicitly acknowledge this is intentionally not awaited
								// as presence marking is non-critical background work
								const markPromises = Array.from(syncedDocuments).map(document => {
									const vector = docManager.encodeStateVector(document);
									return convexClient
										.mutation(api.presence, {
											document,
											client: clientId,
											action: "mark",
											seq: newSeq,
											vector: vector.buffer as ArrayBuffer,
										})
										.catch((error: Error) => {
											logger.warn("Failed to mark presence", {
												document,
												collection,
												error: error.message,
											});
										});
								});
								void Promise.all(markPromises);
							}
						};

						subscription = convexClient.onUpdate(
							api.delta,
							{ seq: cursor, limit: 1000 },
							(response: any) => {
								handleSubscriptionUpdate(response);
							},
						);

						// Note: markReady() was already called above (local-first)
						// Subscription is background replication, not blocking
					} catch (error) {
						// Log error before marking ready to aid debugging sync failures
						logger.error("Sync initialization failed", {
							collection,
							error: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined,
						});
						markReady();
					}
				})();

				return {
					material: docs,
					cleanup: () => {
						subscription?.();
						prose.cleanup(collection);
						deleteContext(collection);
						docPersistence?.destroy();
						docManager?.destroy();
					},
				};
			},
		},
	};
}

type LazyCollectionConfig<T extends object> = Omit<
	ConvexCollectionConfig<T, string>,
	"persistence" | "material" | "validator"
>;

export interface LazyCollection<T extends object> {
	init(material?: Materialized<T> | PaginatedMaterial<T>): Promise<void>;
	get(): Collection<T, string, ConvexCollectionUtils<T>, never, T> &
		NonSingleResult &
		ConvexCollectionExtensions<T>;
	readonly $docType?: T;
	readonly pagination: {
		load(): Promise<PaginatedPage<T> | null>;
		readonly status: PaginationStatus;
		readonly canLoadMore: boolean;
		readonly count: number;
		subscribe(callback: (state: PaginationState) => void): () => void;
	};
}

export type ConvexCollection<T extends object> = Collection<
	T,
	any,
	ConvexCollectionUtils<T>,
	never,
	T
> &
	NonSingleResult &
	ConvexCollectionExtensions<T>;

interface CreateCollectionOptions<T extends object> {
	persistence: () => Promise<Persistence>;
	config: () => Omit<LazyCollectionConfig<T>, "material">;
	pagination?: PaginationConfig;
}

/** Options for new versioned schema API */
interface CreateVersionedCollectionOptions<T extends object> {
	schema: VersionedSchema<GenericValidator>;
	persistence: () => Promise<Persistence>;
	config: () => {
		convexClient: ConvexClient;
		api: ConvexCollectionApi;
		getKey: (doc: T) => string | number;
		user?: () => UserIdentity | undefined;
	};
	clientMigrations?: ClientMigrationMap;
	onMigrationError?: MigrationErrorHandler;
	pagination?: PaginationConfig;
}

/**
 * Create a collection with versioned schema support.
 * Handles automatic client-side migrations when schema version changes.
 */
function createVersionedCollection<T extends object>(
	options: CreateVersionedCollectionOptions<T>,
): LazyCollection<T> {
	const { schema: versionedSchema, clientMigrations, onMigrationError } = options;

	let persistence: Persistence | null = null;
	let resolvedConfig: LazyCollectionConfig<T> | null = null;
	let material: Materialized<T> | undefined;
	type Instance = LazyCollection<T>["get"] extends () => infer R ? R : never;
	let instance: Instance | null = null;
	let collectionName: string | null = null;

	let paginationState: PaginationState = {
		status: "idle",
		count: 0,
		cursor: null,
	};
	const listeners = new Set<(state: PaginationState) => void>();

	const isPaginatedMaterial = (
		mat: Materialized<T> | PaginatedMaterial<T> | undefined,
	): mat is PaginatedMaterial<T> => {
		return mat !== undefined && "pages" in mat && Array.isArray(mat.pages);
	};

	const convertPaginatedToMaterial = (paginated: PaginatedMaterial<T>): Materialized<T> => {
		const allDocs = paginated.pages.flatMap(p => p.page);
		return {
			documents: allDocs,
			count: allDocs.length,
		};
	};

	return {
		async init(mat?: Materialized<T> | PaginatedMaterial<T>) {
			if (!persistence) {
				persistence = await options.persistence();
				const userConfig = options.config();

				// Extract collection name from api.delta function path
				const functionPath = getFunctionName(userConfig.api.delta);
				collectionName = functionPath.split(":")[0] ?? "unknown";

				// Convert versioned config to legacy config format
				resolvedConfig = {
					convexClient: userConfig.convexClient,
					api: userConfig.api,
					getKey: userConfig.getKey,
					user: userConfig.user,
				} as LazyCollectionConfig<T>;

				if (isPaginatedMaterial(mat)) {
					material = convertPaginatedToMaterial(mat);
					paginationState = {
						status: mat.isDone ? "done" : "idle",
						count: mat.pages.reduce((sum, p) => sum + p.page.length, 0),
						cursor: mat.cursor,
					};
				} else {
					material = mat;
				}

				// Run migrations if SQLite persistence is available
				if (persistence.db && collectionName) {
					await runMigrations({
						collection: collectionName,
						schema: versionedSchema,
						db: persistence.db,
						clientMigrations,
						onError: onMigrationError,
						listDocuments: async () => persistence!.listDocuments(collectionName!),
					});
				}
			}
		},

		get() {
			if (!persistence || !resolvedConfig) {
				throw new Error("Call init() before get()");
			}
			if (!instance) {
				const opts = convexCollectionOptions<T, string>({
					...resolvedConfig,
					validator: versionedSchema.shape,
					persistence,
					material,
				});
				const baseCollection = createCollection(opts);
				instance = Object.assign(baseCollection, opts.extensions) as Instance;
			}
			return instance!;
		},

		pagination: {
			async load(): Promise<PaginatedPage<T> | null> {
				if (!persistence || !resolvedConfig) {
					throw new Error("Call init() before pagination.load()");
				}
				if (paginationState.status === "done") {
					return null;
				}
				// TODO: Implement pagination for versioned collections
				return null;
			},
			get status() {
				return paginationState.status;
			},
			get canLoadMore() {
				return paginationState.status !== "done" && paginationState.status !== "busy";
			},
			get count() {
				return paginationState.count;
			},
			subscribe(callback: (state: PaginationState) => void) {
				listeners.add(callback);
				return () => listeners.delete(callback);
			},
		},
	};
}

export namespace collection {
	export type Infer<C> = C extends { $docType?: infer T } ? NonNullable<T> : never;
}

/**
 * Create a collection with versioned schema (new API).
 *
 * @example
 * ```typescript
 * const tasks = collection.create({
 *   schema: taskSchema,
 *   persistence: () => persistence.web.sqlite(),
 *   config: () => ({
 *     convexClient: new ConvexClient(url),
 *     api: api.tasks,
 *     getKey: (t) => t.id,
 *   }),
 *   onMigrationError: async (error, ctx) => {
 *     if (ctx.canResetSafely) return { action: "reset" };
 *     return { action: "keep-old-schema" };
 *   },
 * });
 * ```
 */
function createCollection_versioned<T extends object>(
	options: CreateVersionedCollectionOptions<T>,
): LazyCollection<T> {
	return createVersionedCollection<T>(options);
}

/**
 * Create a collection with Convex schema (legacy API).
 */
function createCollection_legacy<
	Schema extends SchemaDefinition<any, any>,
	TableName extends TableNamesFromSchema<Schema>,
>(
	schema: Schema,
	table: TableName,
	options: CreateCollectionOptions<DocFromSchema<Schema, TableName>>,
): LazyCollection<DocFromSchema<Schema, TableName>> {
	type LegacyT = DocFromSchema<Schema, TableName>;

	const tableDefinition = (schema.tables as Record<string, { validator?: GenericValidator }>)[
		table
	];
	if (!tableDefinition) {
		throw new Error(`Table "${table}" not found in schema`);
	}
	const validator = tableDefinition.validator;

	let persistence: Persistence | null = null;
	let resolvedConfig: LazyCollectionConfig<LegacyT> | null = null;
	let material: Materialized<LegacyT> | undefined;
	type Instance = LazyCollection<LegacyT>["get"] extends () => infer R ? R : never;
	let instance: Instance | null = null;

	let paginationState: PaginationState = {
		status: "idle",
		count: 0,
		cursor: null,
	};
	const listeners = new Set<(state: PaginationState) => void>();

	const notify = () => listeners.forEach(cb => cb(paginationState));

	const isPaginatedMaterial = (
		mat: Materialized<LegacyT> | PaginatedMaterial<LegacyT> | undefined,
	): mat is PaginatedMaterial<LegacyT> => {
		return mat !== undefined && "pages" in mat && Array.isArray(mat.pages);
	};

	const convertPaginatedToMaterial = (
		paginated: PaginatedMaterial<LegacyT>,
	): Materialized<LegacyT> => {
		const allDocs = paginated.pages.flatMap(p => p.page);
		return {
			documents: allDocs,
			count: allDocs.length,
		};
	};

	return {
		async init(mat?: Materialized<LegacyT> | PaginatedMaterial<LegacyT>) {
			if (!persistence) {
				persistence = await options.persistence();
				resolvedConfig = options.config();

				if (isPaginatedMaterial(mat)) {
					material = convertPaginatedToMaterial(mat);
					paginationState = {
						status: mat.isDone ? "done" : "idle",
						count: mat.pages.reduce((sum, p) => sum + p.page.length, 0),
						cursor: mat.cursor,
					};
				} else {
					material = mat;
				}
			}
		},

		get() {
			if (!persistence || !resolvedConfig) {
				throw new Error("Call init() before get()");
			}
			if (!instance) {
				const opts = convexCollectionOptions<LegacyT, string>({
					...resolvedConfig,
					validator,
					persistence,
					material,
				});
				const baseCollection = createCollection(opts);
				instance = Object.assign(baseCollection, opts.extensions) as Instance;
			}
			return instance!;
		},

		pagination: {
			async load(): Promise<PaginatedPage<LegacyT> | null> {
				if (!resolvedConfig || paginationState.status !== "idle") {
					return null;
				}

				paginationState = { ...paginationState, status: "busy" };
				notify();

				try {
					const pageSize = options.pagination?.pageSize ?? 25;
					const result = (await resolvedConfig.convexClient.query(resolvedConfig.api.material, {
						numItems: pageSize,
						cursor: paginationState.cursor ?? undefined,
					})) as PaginatedPage<LegacyT>;

					if (instance && result.page.length > 0) {
						instance.insert(result.page as LegacyT[]);
					}

					paginationState = {
						status: result.isDone ? "done" : "idle",
						count: paginationState.count + result.page.length,
						cursor: result.continueCursor,
					};
					notify();

					return result;
				} catch (err) {
					paginationState = {
						...paginationState,
						status: "error",
						error: err instanceof Error ? err : new Error(String(err)),
					};
					notify();
					return null;
				}
			},

			get status() {
				return paginationState.status;
			},

			get canLoadMore() {
				return paginationState.status === "idle";
			},

			get count() {
				return paginationState.count;
			},

			subscribe(callback: (state: PaginationState) => void) {
				listeners.add(callback);
				callback(paginationState);
				return () => listeners.delete(callback);
			},
		},
	};
}

// Overloaded collection.create function
interface CollectionCreateFn {
	/** Create collection with versioned schema (new API) */
	<T extends object>(options: CreateVersionedCollectionOptions<T>): LazyCollection<T>;
	/** Create collection with Convex schema (legacy API) */
	<Schema extends SchemaDefinition<any, any>, TableName extends TableNamesFromSchema<Schema>>(
		schema: Schema,
		table: TableName,
		options: CreateCollectionOptions<DocFromSchema<Schema, TableName>>,
	): LazyCollection<DocFromSchema<Schema, TableName>>;
}

const createFn: CollectionCreateFn = <
	T extends object,
	Schema extends SchemaDefinition<any, any>,
	TableName extends TableNamesFromSchema<Schema>,
>(
	schemaOrOptions: Schema | CreateVersionedCollectionOptions<T>,
	table?: TableName,
	options?: CreateCollectionOptions<DocFromSchema<Schema, TableName>>,
): LazyCollection<T> | LazyCollection<DocFromSchema<Schema, TableName>> => {
	// New versioned schema API
	if (typeof schemaOrOptions === "object" && "schema" in schemaOrOptions) {
		return createCollection_versioned(schemaOrOptions as CreateVersionedCollectionOptions<T>);
	}

	// Legacy API
	return createCollection_legacy(
		schemaOrOptions as Schema,
		table as TableName,
		options as CreateCollectionOptions<DocFromSchema<Schema, TableName>>,
	);
};

export const collection = {
	create: createFn,
};
