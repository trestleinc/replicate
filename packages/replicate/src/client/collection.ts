import * as Y from 'yjs';
import type { Persistence, PersistenceProvider } from '$/client/persistence/types';
import type { ConvexClient } from 'convex/browser';
import { getFunctionName, type FunctionReference } from 'convex/server';
import {
	createCollection,
	type CollectionConfig,
	type Collection,
	type NonSingleResult,
	type BaseCollectionConfig,
} from '@tanstack/db';
import type { GenericValidator } from 'convex/values';
import type { VersionedSchema } from '$/server/migration';
import type { MigrationErrorHandler, ClientMigrationMap } from '$/client/migration';
import { runMigrations } from '$/client/migration';
import { findProseFields } from '$/client/validators';
import { ProseError, NonRetriableError } from '$/client/errors';
import { createSeqService, type Seq } from '$/client/services/seq';
import { getClientId } from '$/client/services/session';
import { createReplicateOps, type BoundReplicateOps } from '$/client/ops';
import { isDoc, fragmentFromJSON } from '$/client/merge';
import { createDocumentManager, serializeDocument, extractAllDocuments } from '$/client/documents';
import { createDeleteDelta, applyDeleteMarkerToDoc } from '$/client/deltas';
import * as prose from '$/client/prose';
import { getLogger } from '$/shared/logger';
import {
	createTransactionCoordinator,
	type TransactionCoordinator,
	type StagedChange,
} from '$/client/services/transaction';
import { createSyncQueue, type SyncQueue } from '$/client/services/sync-queue';
import {
	initContext,
	getContext,
	hasContext,
	updateContext,
	deleteContext,
} from '$/client/services/context';
import {
	createPresence,
	type PresenceProvider,
	type Presence,
	type PresenceState,
} from '$/client/services/presence';

export type { Presence as DocumentPresence, PresenceState };
import type { AnonymousPresenceConfig, UserIdentity } from '$/client/identity';
import { Awareness } from 'y-protocols/awareness';

enum YjsOrigin {
	Local = 'local',
	Fragment = 'fragment',
	Server = 'server',
}

const logger = getLogger(['replicate', 'collection']);

import type { ProseFields } from '$/shared';

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
		throw new NonRetriableError('Authentication failed');
	}
	if (httpError?.status === 422) {
		throw new NonRetriableError('Validation error');
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

export type PaginationStatus = 'idle' | 'busy' | 'done' | 'error';

export interface PaginationState {
	status: PaginationStatus;
	count: number;
	cursor: string | null;
	error?: Error;
}

interface ConvexCollectionApi {
	material: FunctionReference<'query'>;
	delta: FunctionReference<'query'>;
	replicate: FunctionReference<'mutation'>;
	presence: FunctionReference<'mutation'>;
	session: FunctionReference<'query'>;
}

export interface ConvexCollectionConfig<T extends object = object> extends Omit<
	BaseCollectionConfig<T, string, never>,
	'schema'
> {
	validator?: GenericValidator;
	convexClient: ConvexClient;
	api: ConvexCollectionApi;
	persistence: Persistence;
	material?: Materialized<T>;
	user?: () => UserIdentity | undefined;
	/**
	 * Configuration for anonymous presence names and colors.
	 * Allows customizing the adjectives, nouns, and colors used
	 * when generating anonymous user identities for presence.
	 */
	anonymousPresence?: AnonymousPresenceConfig;
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
	/** User identity getter for collaborative presence */
	user?: () => UserIdentity | undefined;
	/**
	 * Debounce delay in milliseconds before syncing changes to server.
	 * Local changes are batched during this window for efficiency.
	 * @default 50
	 */
	debounceMs?: number;
	/**
	 * Throttle delay in milliseconds for presence/cursor position updates.
	 * Lower values mean faster cursor sync but more network traffic.
	 * @default 50
	 */
	throttleMs?: number;
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

export interface DocumentHandle<T extends object> {
	readonly id: string;
	readonly presence: Presence;
	readonly awareness: Awareness;
	prose(field: ProseFields<T>, options?: ProseOptions): Promise<EditorBinding>;
}

interface ConvexCollectionExtensions<T extends object> {
	doc(id: string): DocumentHandle<T>;
	readonly session: SessionAPI;
}

export function convexCollectionOptions<T extends object = object>(
	config: ConvexCollectionConfig<T>
): CollectionConfig<T, string, never, ConvexCollectionUtils<T>> & {
	id: string;
	utils: ConvexCollectionUtils<T>;
	extensions: ConvexCollectionExtensions<T>;
} {
	const {
		validator,
		getKey,
		material,
		convexClient,
		api,
		persistence,
		user: userGetter,
		anonymousPresence,
	} = config;

	const functionPath = getFunctionName(api.delta);
	const collection = functionPath.split(':')[0];
	if (!collection) {
		throw new Error('Could not extract collection name from api.delta function reference');
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
			options?: ProseOptions
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
								})
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

			let presenceProvider: PresenceProvider | null = null;
			const hasPresenceApi = storedApi?.session && storedApi?.presence;
			if (storedConvexClient && hasPresenceApi && storedClientId) {
				presenceProvider = createPresence({
					convexClient: storedConvexClient,
					api: {
						presence: storedApi.presence!,
						session: storedApi.session!,
					},
					document,
					client: storedClientId,
					ydoc: subdoc,
					syncReady: ctx.synced,
					user: options?.user ?? ctx.userGetter,
					throttleMs: options?.throttleMs,
					anonymousPresence: ctx.anonymousPresence,
				});
			}

			const binding: EditorBinding = {
				fragment,
				provider: presenceProvider
					? { awareness: presenceProvider.awareness, document: subdoc }
					: { awareness: new Awareness(subdoc), document: subdoc },

				get pending() {
					return prose.isPending(collection, document);
				},

				onPendingChange(callback: (pending: boolean) => void) {
					return prose.subscribePending(collection, document, callback);
				},

				destroy() {
					presenceProvider?.destroy();
				},
			};

			return binding;
		},
	};

	const documentHandles = new Map<string, DocumentHandle<DataType>>();
	const presenceProviders = new Map<string, PresenceProvider>();

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
				presenceProvider = createPresence({
					convexClient: ctx.client,
					api: {
						presence: ctx.api.presence!,
						session: ctx.api.session!,
					},
					document: documentId,
					client: ctx.clientId,
					ydoc: subdoc,
					syncReady: ctx.synced,
					user: ctx.userGetter,
					anonymousPresence: ctx.anonymousPresence,
				});
				presenceProviders.set(documentId, presenceProvider);
			}
		}

		const presence: Presence = presenceProvider ?? {
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
				sessionSubscribers.forEach((cb) => cb(sessions));
			}
		);
	};

	const sessionApi: SessionAPI = {
		get(docId?: string): SessionInfo[] {
			if (docId) {
				return sessionCache.filter((s) => s.document === docId);
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
		anonymousPresence,
	});

	// Bound replicate operations - set during sync initialization
	// Used by onDelete and other handlers that need to sync with TanStack DB
	let ops: BoundReplicateOps<DataType> = null as any;

	// Transaction coordinator for atomic client-side mutations with rollback
	// Ensures delete operations are atomic: if server call fails, local state is rolled back
	let txCoordinator: TransactionCoordinator | null = null;

	// Background sync queue for non-blocking server mutations
	const syncQueue: SyncQueue = createSyncQueue({
		maxRetries: 3,
		baseDelayMs: 1000,
		maxDelayMs: 30000,
	});

	// Create seq service with the persistence KV store
	const seqService = createSeqService(persistence.kv);

	let resolvePersistenceReady: (() => void) | undefined;
	const persistenceReadyPromise = new Promise<void>((resolve) => {
		resolvePersistenceReady = resolve;
	});

	let resolveOptimisticReady: (() => void) | undefined;
	const optimisticReadyPromise = new Promise<void>((resolve) => {
		resolveOptimisticReady = resolve;
	});

	const recover = async (pushLocal = false): Promise<void> => {
		const docIds = docManager.documents();
		if (docIds.length === 0) return;

		logger.debug('Starting recovery for documents', { collection, count: docIds.length });

		const recoveryPromises = docIds.map(async (docId) => {
			try {
				const vector = docManager.encodeStateVector(docId);
				const result = await convexClient.query(api.delta, {
					document: docId,
					vector: vector.buffer as ArrayBuffer,
				});

				if (result.mode === 'recovery' && result.diff) {
					const update = new Uint8Array(result.diff);
					docManager.applyUpdate(docId, update, YjsOrigin.Server);
					logger.debug('Applied server diff during recovery', { document: docId, collection });
				}

				// Only push local state when explicitly requested (reconnection scenario)
				// On init, we only pull server diff - pushing would flood the mutation queue
				if (pushLocal) {
					const ydoc = docManager.get(docId);
					if (ydoc) {
						const localState = Y.encodeStateAsUpdateV2(ydoc);
						const material = serializeDocument(docManager, docId);

						if (material && localState.length > 0) {
							await convexClient.mutation(api.replicate, {
								document: docId,
								bytes: localState.buffer as ArrayBuffer,
								material,
								type: 'update',
							});
							logger.debug('Pushed local changes during recovery', { document: docId, collection });
						}
					}
				}
			} catch (error) {
				logger.warn('Recovery failed for document', {
					document: docId,
					collection,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});

		await Promise.all(recoveryPromises);
		logger.debug('Recovery completed', { collection, count: docIds.length });
	};

	const applyYjsInsert = (mutations: CollectionMutation<DataType>[]): Uint8Array[] => {
		const deltas: Uint8Array[] = [];

		for (const mut of mutations) {
			const document = String(mut.key);
			const delta = docManager.transactWithDelta(
				document,
				(fieldsMap) => {
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
				YjsOrigin.Local
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
				(fields) => {
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
				YjsOrigin.Local
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

				// Process mutations in parallel for better performance
				await Promise.all(
					transaction.mutations.map(async (mut, i) => {
						const delta = deltas[i];
						if (!delta || delta.length === 0) return;

						const document = String(mut.key);
						const materializedDoc = serializeDocument(docManager, document) ?? mut.modified;

						await convexClient.mutation(api.replicate, {
							document: document,
							bytes: delta.buffer,
							material: materializedDoc,
							type: 'insert',
						});
					})
				);
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
						type: 'update',
					});
					return;
				}

				if (deltas) {
					// Process mutations in parallel for better performance
					await Promise.all(
						transaction.mutations.map(async (mut, i) => {
							const delta = deltas[i];
							if (!delta || delta.length === 0) return;

							const docId = String(mut.key);
							const fullDoc = serializeDocument(docManager, docId) ?? mut.modified;

							await convexClient.mutation(api.replicate, {
								document: docId,
								bytes: delta.buffer,
								material: fullDoc,
								type: 'update',
							});
						})
					);
				}
			} catch (error) {
				handleMutationError(error);
			}
		},

		onDelete: async ({ transaction }: CollectionTransaction<DataType>) => {
			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);

				if (!txCoordinator) {
					// Fallback to non-transactional delete if coordinator not ready
					logger.warn('Transaction coordinator not initialized, using fallback delete');
					const deltas = applyYjsDelete(transaction.mutations);
					const itemsToDelete = transaction.mutations
						.map((mut) => mut.original)
						.filter((item): item is DataType => item !== undefined && Object.keys(item).length > 0);
					ops.delete(itemsToDelete);

					await Promise.all(
						transaction.mutations.map(async (mut, i) => {
							const delta = deltas[i];
							if (!delta || delta.length === 0) return;

							await convexClient.mutation(api.replicate, {
								document: String(mut.key),
								bytes: delta.buffer,
								type: 'delete',
							});
						})
					);
					return;
				}

				// Use transaction coordinator for atomic delete with rollback support
				await txCoordinator.transaction(async (tx) => {
					// Process each deletion in the transaction
					for (const mut of transaction.mutations) {
						const documentId = String(mut.key);
						const ydoc = docManager.get(documentId);

						// Capture state for potential rollback
						let previousState: Uint8Array | undefined;
						if (ydoc) {
							previousState = Y.encodeStateAsUpdateV2(ydoc);
						}

						// Stage the delete in the transaction
						tx.stageDelete(documentId);

						// Create delete delta
						const delta = ydoc ? applyDeleteMarkerToDoc(ydoc) : createDeleteDelta();

						// Store previous state for rollback
						if (previousState) {
							// The transaction's onRevert callback will use this to restore
							const changes = tx.getStagedChanges();
							const lastChange = changes[changes.length - 1];
							if (lastChange) {
								(lastChange as { previousState?: Uint8Array }).previousState = previousState;
							}
						}

						// Optimistically remove from TanStack DB
						const original = mut.original;
						if (original && Object.keys(original).length > 0) {
							ops.delete([original as DataType]);
						}

						// Call server mutation - if this fails, transaction will rollback
						await convexClient.mutation(api.replicate, {
							document: documentId,
							bytes: delta.buffer,
							type: 'delete',
						});
					}
				});
			} catch (error) {
				// Transaction already rolled back if error occurred
				handleMutationError(error);
			}
		},

		sync: {
			rowUpdateMode: 'partial',
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

						// Initialize transaction coordinator with document-level apply/revert callbacks
						txCoordinator = createTransactionCoordinator({
							async onApply(change: StagedChange) {
								// Changes are already applied optimistically before server call
								// This callback is for any post-commit bookkeeping
								logger.debug('Transaction change applied', {
									type: change.type,
									documentId: change.documentId,
								});
							},
							async onRevert(change: StagedChange) {
								// Rollback: restore previous state or re-add deleted document
								if (change.type === 'delete' && change.previousState) {
									// Restore the document that was deleted
									const update = new Uint8Array(change.previousState);
									docManager.applyUpdate(change.documentId, update, YjsOrigin.Local);
									const restoredItem = serializeDocument(docManager, change.documentId);
									if (restoredItem) {
										ops.insert([restoredItem as DataType]);
									}
									logger.debug('Rolled back delete', { documentId: change.documentId });
								} else if (change.type === 'update' && change.previousState) {
									// Restore previous state for updates
									const update = new Uint8Array(change.previousState);
									docManager.applyUpdate(change.documentId, update, YjsOrigin.Local);
									const restoredItem = serializeDocument(docManager, change.documentId);
									if (restoredItem) {
										ops.upsert([restoredItem as DataType]);
									}
									logger.debug('Rolled back update', { documentId: change.documentId });
								}
								// Insert rollback: nothing to do, document wasn't created
							},
						});

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

						// Returns { item, isNew, isDelete } for batching, null if no action needed
						type ChangeResult = {
							item: DataType;
							isNew: boolean;
							isDelete: boolean;
						} | null;

						const handleSnapshotChange = (
							bytes: ArrayBuffer,
							document: string,
							exists: boolean
						): ChangeResult => {
							const hadLocally = docManager.has(document);

							if (!exists && hadLocally) {
								const itemBefore = serializeDocument(docManager, document);
								docManager.delete(document);
								if (itemBefore) {
									return { item: itemBefore as DataType, isNew: false, isDelete: true };
								}
								return null;
							}

							if (!exists && !hadLocally) {
								return null;
							}

							// Apply update - use hadLocally for existence check (avoid double serialization)
							const update = new Uint8Array(bytes);
							docManager.applyUpdate(document, update, YjsOrigin.Server);
							const itemAfter = serializeDocument(docManager, document);

							if (itemAfter) {
								return { item: itemAfter as DataType, isNew: !hadLocally, isDelete: false };
							} else if (hadLocally) {
								// Serialization failed - log warning but don't return item
								logger.warn('Document serialization returned null after snapshot update', {
									document,
									collection,
									hadFieldsAfter: !!docManager.getFields(document),
								});
							}
							return null;
						};

						const handleDeltaChange = (
							bytes: ArrayBuffer,
							document: string | undefined,
							exists: boolean
						): ChangeResult => {
							if (!document) {
								return null;
							}

							const hadLocally = docManager.has(document);

							if (!exists && hadLocally) {
								const itemBefore = serializeDocument(docManager, document);
								docManager.delete(document);
								if (itemBefore) {
									return { item: itemBefore as DataType, isNew: false, isDelete: true };
								}
								return null;
							}

							if (!exists && !hadLocally) {
								return null;
							}

							// Apply update - use hadLocally for existence check (avoid double serialization)
							const update = new Uint8Array(bytes);
							docManager.applyUpdate(document, update, YjsOrigin.Server);
							const itemAfter = serializeDocument(docManager, document);

							if (itemAfter) {
								return { item: itemAfter as DataType, isNew: !hadLocally, isDelete: false };
							} else if (hadLocally) {
								// Serialization failed - log warning but don't return item
								logger.warn('Document serialization returned null after delta update', {
									document,
									collection,
									hadFieldsAfter: !!docManager.getFields(document),
								});
							}
							return null;
						};

						let lastProcessedSeq = cursor;

						const handleSubscriptionUpdate = async (response: any) => {
							if (!response || !Array.isArray(response.changes)) {
								return;
							}

							const { changes, seq: newSeq } = response;

							// Skip if we've already processed up to this seq — prevents
							// re-enqueuing presence marks on subscription re-fires (e.g. reconnect)
							if (newSeq !== undefined && newSeq <= lastProcessedSeq) {
								return;
							}

							const syncedDocuments = new Set<string>();

							// Process all changes and collect results for batching
							const toInsert: DataType[] = [];
							const toUpsert: DataType[] = [];
							const toDelete: DataType[] = [];

							for (const change of changes) {
								const { type, bytes, document, exists } = change;
								if (!bytes || !document) {
									continue;
								}

								syncedDocuments.add(document);

								const result =
									type === 'snapshot'
										? handleSnapshotChange(bytes, document, exists ?? true)
										: handleDeltaChange(bytes, document, exists ?? true);

								if (result) {
									if (result.isDelete) {
										toDelete.push(result.item);
									} else if (result.isNew) {
										toInsert.push(result.item);
									} else {
										toUpsert.push(result.item);
									}
								}
							}

							// Batch ops calls - single transaction instead of N separate calls
							if (toDelete.length > 0) ops.delete(toDelete);
							if (toInsert.length > 0) ops.insert(toInsert);
							if (toUpsert.length > 0) ops.upsert(toUpsert);

							if (newSeq !== undefined) {
								lastProcessedSeq = newSeq;
								persistence.kv.set(`cursor:${collection}`, newSeq);

								// Mark presence for synced documents using background sync queue
								// The queue provides retry with exponential backoff on transient failures
								for (const document of syncedDocuments) {
									syncQueue.enqueue(`presence:${document}`, async () => {
										const vector = docManager.encodeStateVector(document);
										await convexClient.mutation(api.presence, {
											document,
											client: clientId,
											action: 'mark',
											seq: newSeq,
											vector: vector.buffer as ArrayBuffer,
										});
									});
								}

								// Resubscribe with the advanced cursor so the reactive query
								// only returns genuinely new deltas, not ones we've already processed.
								// Without this, reconnection or any table change causes the query
								// to re-fire with ALL deltas since the original cursor.
								subscription?.();
								subscription = convexClient.onUpdate(
									api.delta,
									{ seq: newSeq, limit: 1000 },
									(response: any) => {
										handleSubscriptionUpdate(response);
									}
								);
							}
						};

						// Subscribe to the delta stream. Convex handles reactivity —
						// when new deltas are written to the server, the query re-evaluates
						// and the callback fires with the updated result automatically.
						subscription = convexClient.onUpdate(
							api.delta,
							{ seq: cursor, limit: 1000 },
							(response: any) => {
								handleSubscriptionUpdate(response);
							}
						);

						// Reconnection handling: when browser comes back online, resync local state
						if (typeof globalThis.window !== 'undefined') {
							let wasOffline = false;
							const handleOffline = () => {
								wasOffline = true;
								logger.debug('Network offline detected', { collection });
							};
							const handleOnline = () => {
								if (wasOffline) {
									logger.info('Network online restored, running recovery sync', { collection });
									wasOffline = false;
									recover(true).catch((error: Error) => {
										logger.warn('Recovery sync failed after reconnection', {
											collection,
											error: error.message,
										});
									});
								}
							};

							globalThis.window.addEventListener('offline', handleOffline);
							globalThis.window.addEventListener('online', handleOnline);

							// Store cleanup function in context for proper cleanup
							const ctx = getContext(collection);
							(ctx as any).cleanupReconnection = () => {
								globalThis.window.removeEventListener('offline', handleOffline);
								globalThis.window.removeEventListener('online', handleOnline);
							};
						}

						// Note: markReady() was already called above (local-first)
						// Subscription is background replication, not blocking
					} catch (error) {
						// Log error before marking ready to aid debugging sync failures
						logger.error('Sync initialization failed', {
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
						// Clean up reconnection listeners if stored in context
						if (hasContext(collection)) {
							const ctx = getContext(collection);
							(ctx as any).cleanupReconnection?.();
						}
						subscription?.();
						syncQueue.destroy();
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
	ConvexCollectionConfig<T>,
	'persistence' | 'material' | 'validator'
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

/** Options for collection.create() */
export interface CreateCollectionOptions<T extends object> {
	schema: VersionedSchema<GenericValidator>;
	persistence: () => Promise<Persistence>;
	config: () => {
		convexClient: ConvexClient;
		api: ConvexCollectionApi;
		getKey: (doc: T) => string;
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
	options: CreateCollectionOptions<T>
): LazyCollection<T> {
	const { schema: versionedSchema, clientMigrations, onMigrationError } = options;

	let persistence: Persistence | null = null;
	let resolvedConfig: LazyCollectionConfig<T> | null = null;
	let material: Materialized<T> | undefined;
	type Instance = LazyCollection<T>['get'] extends () => infer R ? R : never;
	let instance: Instance | null = null;
	let collectionName: string | null = null;

	let paginationState: PaginationState = {
		status: 'idle',
		count: 0,
		cursor: null,
	};
	const listeners = new Set<(state: PaginationState) => void>();

	const isPaginatedMaterial = (
		mat: Materialized<T> | PaginatedMaterial<T> | undefined
	): mat is PaginatedMaterial<T> => {
		return mat !== undefined && 'pages' in mat && Array.isArray(mat.pages);
	};

	const convertPaginatedToMaterial = (paginated: PaginatedMaterial<T>): Materialized<T> => {
		const allDocs = paginated.pages.flatMap((p) => p.page);
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
				collectionName = functionPath.split(':')[0] ?? 'unknown';

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
						status: mat.isDone ? 'done' : 'idle',
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
				throw new Error('Call init() before get()');
			}
			if (!instance) {
				const opts = convexCollectionOptions<T>({
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
					throw new Error('Call init() before pagination.load()');
				}
				if (paginationState.status === 'done') {
					return null;
				}
				// TODO: Implement pagination for versioned collections
				return null;
			},
			get status() {
				return paginationState.status;
			},
			get canLoadMore() {
				return paginationState.status !== 'done' && paginationState.status !== 'busy';
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

export type CollectionInfer<C> = C extends { $docType?: infer T } ? NonNullable<T> : never;

/**
 * Create a collection with versioned schema (new API).
 *
 * @example
 * ```typescript
 * const tasks = collection.create({
 *   schema: taskSchema,
 *   persistence: () => persistence.web.sqlite.create(),
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
export const collection = {
	create: createVersionedCollection,
};
