import { cleanupSyncManager } from './bindings/sync-registry';
import { createConnection, type ConnectionOptions } from './services/connection';
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
import { findCrdtFields } from '$/client/validators';
import { ProseError, NonRetriableError } from '$/client/errors';
import { initializeCrdtField, getDefaultForCrdtType } from '$/client/crdt-handlers';
import { createCounterBinding, createRegisterBinding, createSetBinding } from '$/client/bindings';
import type { CounterBinding, RegisterBinding, SetBinding } from '$/client/bindings';
import type { CrdtFieldInfo } from '$/shared/crdt';
import { createSeqService, type Seq } from '$/client/services/seq';
import { getClientId } from '$/client/services/session';
import { createReplicateOps, type BoundReplicateOps } from '$/client/ops';
import {
	createDocumentManager,
	serializeDocument,
	extractAllDocuments,
	isDocumentDeleted,
} from '$/client/documents';
import { createDeleteDelta, applyDeleteMarkerToDoc } from '$/client/deltas';
import * as prose from '$/client/prose';
import { detectYjsType, isYjsAbstractType } from '$/client/merge';
import { getLogger } from '$/shared/logger';
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

// ============================================================================
// Helper Functions
// ============================================================================

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

export interface ConvexCollectionConfig<T extends object = object>
	extends Omit<BaseCollectionConfig<T, string, never>, 'schema'>, ConnectionOptions {
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
	counter(
		document: string,
		field: string,
		options?: { debounceMs?: number }
	): Promise<CounterBinding>;
	register<U>(
		document: string,
		field: string,
		options?: { resolve?: (conflict: unknown) => U }
	): Promise<RegisterBinding<U>>;
	set<U>(
		document: string,
		field: string,
		options: {
			serialize: (item: U) => string;
			deserialize: (key: string) => U;
			debounceMs?: number;
		}
	): Promise<SetBinding<U>>;
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
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	reset(): Promise<void>;
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
		convexClient: rawClient,
		api,
		persistence,
		user: userGetter,
		anonymousPresence,
	} = config;

	const connection = createConnection(rawClient, config);
	const convexClient = connection.client;
	const ensureGeneration = (token: number) => {
		if (stopped || token !== connection.generation)
			throw new Error('Operation belongs to a disconnected generation');
	};
	const bindings = new Set<{ destroy(): void }>();
	const trackBinding = <T extends { destroy(): void }>(binding: T): T => {
		const token = connection.generation;
		let destroyed = false;
		const wrapped = new Proxy(binding, {
			get(target, property) {
				if (property === 'destroy')
					return () => {
						if (destroyed) return;
						destroyed = true;
						target.destroy();
						bindings.delete(wrapped);
					};
				const value = Reflect.get(target, property);
				if (typeof value !== 'function') return value;
				return (...args: unknown[]) => {
					ensureGeneration(token);
					if (destroyed) throw new Error('Binding has been destroyed');
					return value.apply(target, args);
				};
			},
		});
		bindings.add(wrapped);
		return wrapped;
	};
	const assertWritable = () => {
		if (config.readOnly) throw new Error('Collection is read-only');
	};
	let startNetwork: (() => Promise<void>) | undefined;
	let work: Promise<void> = Promise.resolve();
	let stopped = false;
	let desiredConnection = config.networkMode !== 'manual';
	let disconnecting: Promise<void> = Promise.resolve();
	const revisions = new Map<string, number>();
	const durableVectors = new Map<string, ArrayBuffer>();
	const pendingCreates = new Set<string>();
	const fullSyncRequired = new Map<string, number>();
	let fullSyncEpoch = 0;
	const pendingCreateKey = (id: string) => `pending-create:${collection}:${id}`;
	const fullSyncKey = (id: string) => `full-sync-required:${collection}:${id}`;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let localReady: Promise<void> = Promise.resolve();
	const serialize = (operation: () => Promise<void>) => {
		const next = work.then(operation);
		work = next.catch(() => {});
		return next;
	};
	const acknowledgeCreate = (id: string, token: number) =>
		serialize(async () => {
			ensureGeneration(token);
			await persistence.kv.del(pendingCreateKey(id));
			ensureGeneration(token);
			pendingCreates.delete(id);
		});
	const acknowledgeFullSync = (id: string, epoch: number, token: number, revision: number) =>
		serialize(async () => {
			ensureGeneration(token);
			if (fullSyncRequired.get(id) !== epoch || revisions.get(id) !== revision) return;
			await persistence.kv.del(fullSyncKey(id));
			ensureGeneration(token);
			if (fullSyncRequired.get(id) === epoch && revisions.get(id) === revision)
				fullSyncRequired.delete(id);
		});
	const functionPath = getFunctionName(api.delta);
	const collection = functionPath.split(':')[0];
	if (!collection) {
		throw new Error('Could not extract collection name from api.delta function reference');
	}

	// Find all CRDT fields (including prose) using the unified system
	const crdtFieldsList: CrdtFieldInfo[] = validator ? findCrdtFields(validator) : [];
	const crdtFields = new Map<string, CrdtFieldInfo>(
		crdtFieldsList.map((info) => [info.field, info])
	);

	// Derive prose fields from CRDT fields
	const proseFieldSet = new Set<string>(
		crdtFieldsList.filter((info) => info.type === 'prose').map((info) => info.field)
	);

	// DataType is 'any' in implementation - type safety comes from overload signatures
	type DataType = any;

	const utils: ConvexCollectionUtils<DataType> = {
		async prose(
			document: string,
			field: ProseFields<DataType>,
			options?: ProseOptions
		): Promise<EditorBinding> {
			assertWritable();
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
					durableVector: () => durableVectors.get(document),
					user: options?.user ?? ctx.userGetter,
					throttleMs: options?.throttleMs,
					anonymousPresence: ctx.anonymousPresence,
				});
			}

			if (presenceProvider) {
				const providers = editorPresenceProviders.get(document) ?? new Set<PresenceProvider>();
				providers.add(presenceProvider);
				editorPresenceProviders.set(document, providers);
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
					if (presenceProvider) editorPresenceProviders.get(document)?.delete(presenceProvider);
				},
			};

			return trackBinding(binding);
		},

		/**
		 * Create a counter binding for a document field.
		 */
		async counter(
			document: string,
			field: string,
			options?: { debounceMs?: number }
		): Promise<CounterBinding> {
			assertWritable();
			const fieldStr = String(field);
			const crdtInfo = crdtFields.get(fieldStr);

			if (crdtInfo?.type !== 'counter') {
				throw new Error(
					`Field "${fieldStr}" is not a counter (type: ${crdtInfo?.type ?? 'unknown'})`
				);
			}

			const ctx = hasContext(collection) ? getContext(collection) : null;
			if (!ctx) {
				throw new Error(`Collection ${collection} not initialized`);
			}

			await ctx.synced;

			const fieldsMap = ctx.docManager.getFields(document);
			if (!fieldsMap) {
				throw new Error(`Document ${document} not found`);
			}

			let array = fieldsMap.get(fieldStr) as
				| Y.Array<{ client: string; delta: number; timestamp: number }>
				| undefined;
			if (!array) {
				array = new Y.Array();
				fieldsMap.set(fieldStr, array);
			}

			const subdoc = ctx.docManager.getOrCreate(document);
			const collectionRef = ctx.ref;

			if (!collectionRef) {
				throw new Error(`Collection reference not available`);
			}

			if (!ctx.clientId) {
				throw new Error(`Client ID not available`);
			}

			return trackBinding(
				createCounterBinding({
					collection,
					document,
					field: fieldStr,
					array,
					ydoc: subdoc,
					ymap: fieldsMap,
					collectionRef,
					clientId: ctx.clientId,
					debounceMs: options?.debounceMs,
					getMaterial: () => serializeDocument(ctx.docManager, document),
				})
			);
		},

		/**
		 * Create a register binding for a document field.
		 */
		async register<T>(
			document: string,
			field: string,
			options?: { resolve?: (conflict: unknown) => T }
		): Promise<RegisterBinding<T>> {
			assertWritable();
			const fieldStr = String(field);
			const crdtInfo = crdtFields.get(fieldStr);

			if (crdtInfo?.type !== 'register') {
				throw new Error(
					`Field "${fieldStr}" is not a register (type: ${crdtInfo?.type ?? 'unknown'})`
				);
			}

			const ctx = hasContext(collection) ? getContext(collection) : null;
			if (!ctx) {
				throw new Error(`Collection ${collection} not initialized`);
			}

			await ctx.synced;

			const fieldsMap = ctx.docManager.getFields(document);
			if (!fieldsMap) {
				throw new Error(`Document ${document} not found`);
			}

			let map = fieldsMap.get(fieldStr) as Y.Map<{ value: T; timestamp: number }> | undefined;
			if (!map) {
				map = new Y.Map();
				fieldsMap.set(fieldStr, map);
			}

			if (!ctx.clientId) {
				throw new Error(`Client ID not available`);
			}

			// Use provided resolve, or stored resolver, or default to latest()
			const resolve =
				options?.resolve ??
				(ctx.crdtResolvers?.get(fieldStr) as ((conflict: unknown) => T) | undefined) ??
				((c: { latest: () => T }) => c.latest());

			return trackBinding(
				createRegisterBinding({
					ymap: map,
					clientId: ctx.clientId,
					resolve,
				})
			);
		},

		/**
		 * Create a set binding for a document field.
		 */
		async set<T>(
			document: string,
			field: string,
			options: {
				serialize: (item: T) => string;
				deserialize: (key: string) => T;
				debounceMs?: number;
			}
		): Promise<SetBinding<T>> {
			assertWritable();
			const fieldStr = String(field);
			const crdtInfo = crdtFields.get(fieldStr);

			if (crdtInfo?.type !== 'set') {
				throw new Error(`Field "${fieldStr}" is not a set (type: ${crdtInfo?.type ?? 'unknown'})`);
			}

			const ctx = hasContext(collection) ? getContext(collection) : null;
			if (!ctx) {
				throw new Error(`Collection ${collection} not initialized`);
			}

			await ctx.synced;

			const fieldsMap = ctx.docManager.getFields(document);
			if (!fieldsMap) {
				throw new Error(`Document ${document} not found`);
			}

			let map = fieldsMap.get(fieldStr) as Y.Map<{ addedBy: string; addedAt: number }> | undefined;
			if (!map) {
				map = new Y.Map();
				fieldsMap.set(fieldStr, map);
			}

			const subdoc = ctx.docManager.getOrCreate(document);
			const collectionRef = ctx.ref;

			if (!collectionRef) {
				throw new Error(`Collection reference not available`);
			}

			if (!ctx.clientId) {
				throw new Error(`Client ID not available`);
			}

			return trackBinding(
				createSetBinding({
					collection,
					document,
					field: fieldStr,
					ymap: map,
					ydoc: subdoc,
					fieldsMap,
					collectionRef,
					clientId: ctx.clientId,
					serialize: options.serialize,
					deserialize: options.deserialize,
					debounceMs: options.debounceMs,
					getMaterial: () => serializeDocument(ctx.docManager, document),
				})
			);
		},
	};

	const documentHandles = new Map<string, DocumentHandle<DataType>>();
	const presenceProviders = new Map<string, PresenceProvider>();
	const editorPresenceProviders = new Map<string, Set<PresenceProvider>>();
	const removeDocument = async (id: string) => {
		await docManager.remove(id);
		await persistence.kv.del(fullSyncKey(id));
		fullSyncRequired.delete(id);
		presenceProviders.get(id)?.destroy();
		presenceProviders.delete(id);
		for (const provider of editorPresenceProviders.get(id) ?? []) provider.destroy();
		editorPresenceProviders.delete(id);
		documentHandles.delete(id);
		durableVectors.delete(id);
	};

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
					durableVector: () => durableVectors.get(documentId),
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
		if (sessionUnsubscribe || !connection.active) return;

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
		async connect() {
			const requestedGeneration = connection.generation;
			desiredConnection = true;
			await disconnecting;
			await localReady;
			if (stopped) throw new Error('Collection has been cleaned up');
			if (!desiredConnection || requestedGeneration !== connection.generation) return;
			if (connection.active) return;
			connection.connect();
			await startNetwork?.();
		},
		async disconnect() {
			desiredConnection = false;
			for (const binding of bindings) binding.destroy();
			prose.cleanup(collection);
			cleanupSyncManager(collection);
			clearTimeout(retryTimer);
			connection.disconnect();
			sessionUnsubscribe?.();
			sessionUnsubscribe = null;
			sessionCache = [];
			for (const provider of presenceProviders.values()) provider.destroy();
			presenceProviders.clear();
			for (const providers of editorPresenceProviders.values())
				for (const provider of providers) provider.destroy();
			editorPresenceProviders.clear();
			documentHandles.clear();
			disconnecting = (async () => {
				await localReady;
				await work;
				await docManager.flush();
			})();
			await disconnecting;
		},
		async reset() {
			const drained = extensions.disconnect();
			disconnecting = drained.then(() =>
				serialize(async () => {
					for (const id of await persistence.listDocuments(collection)) docManager.getOrCreate(id);
					for (const id of docManager.documents()) {
						await removeDocument(id);
						await persistence.kv.del(pendingCreateKey(id));
					}
					for (const id of pendingCreates) await persistence.kv.del(pendingCreateKey(id));
					pendingCreates.clear();
					fullSyncRequired.clear();
					revisions.clear();
					await seqService.clear(collection);
					ops.replace([]);
				})
			);
			await disconnecting;
		},
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
		crdtFields,
		fields: proseFieldSet,
		userGetter,
		anonymousPresence,
	});

	// Bound replicate operations - set during sync initialization
	// Used by onDelete and other handlers that need to sync with TanStack DB
	let ops: BoundReplicateOps<DataType> = null as any;
	const publishDocuments = (ids: Iterable<string>) => {
		const upserts: DataType[] = [];
		const removals: DataType[] = [];
		for (const id of ids) {
			const item = isDocumentDeleted(docManager, id)
				? null
				: serializeDocument(docManager, id, crdtFields);
			if (item) upserts.push(item as DataType);
			else removals.push({ id } as DataType);
		}
		if (removals.length) ops.delete(removals);
		if (upserts.length) ops.upsert(upserts);
	};

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
		const token = connection.generation;
		const docIds = docManager.documents();
		await Promise.all(
			docIds.map(async (docId) => {
				try {
					const original = docManager.get(docId);
					const revision = revisions.get(docId);
					const vector = docManager.encodeStateVector(docId);
					const result = await convexClient.query(api.delta, {
						document: docId,
						vector: vector.buffer as ArrayBuffer,
					});
					let validRecovery = false;
					await serialize(async () => {
						if (
							!connection.active ||
							token !== connection.generation ||
							docManager.get(docId) !== original ||
							revisions.get(docId) !== revision
						)
							return;
						if (result.mode !== 'recovery') return;
						validRecovery = true;
						if (result.exists === false) {
							if (!config.readOnly && (pendingCreates.has(docId) || result.known === false)) return;
							await removeDocument(docId);
						} else if (result.diff) {
							await docManager.applyRemote(docId, new Uint8Array(result.diff));
						} else return;
						publishDocuments([docId]);
					});
					if (
						validRecovery &&
						revisions.get(docId) === revision &&
						(pushLocal || pendingCreates.has(docId)) &&
						!config.readOnly &&
						connection.active &&
						token === connection.generation
					) {
						const ydoc = docManager.get(docId);
						const material = serializeDocument(docManager, docId);
						if (ydoc && material)
							await convexClient.mutation(api.replicate, {
								document: docId,
								bytes: Y.encodeStateAsUpdateV2(ydoc).buffer as ArrayBuffer,
								material,
								type: result.exists === false ? 'insert' : 'update',
							});
						await acknowledgeCreate(docId, token);
					}
				} catch (error) {
					logger.warn('Recovery failed', { collection, document: docId, error });
				}
			})
		);
	};

	const applyYjsInsert = (mutations: CollectionMutation<DataType>[]): Uint8Array[] => {
		const deltas: Uint8Array[] = [];

		for (const mut of mutations) {
			const document = String(mut.key);
			revisions.set(document, (revisions.get(document) ?? 0) + 1);
			const delta = docManager.transactWithDelta(
				document,
				(fieldsMap) => {
					const modified = mut.modified as Record<string, unknown>;
					const ctx = hasContext(collection) ? getContext(collection) : null;
					const effectiveClientId = ctx?.clientId ?? 'init';

					// Initialize ALL CRDT fields from schema (not just provided ones)
					// This ensures fields like viewCount get proper Yjs structures
					// even when not included in the insert mutation
					for (const [fieldName, crdtInfo] of crdtFields) {
						// Use provided value or get default for type
						const value = modified[fieldName] ?? getDefaultForCrdtType(crdtInfo.type);
						initializeCrdtField(crdtInfo.type, {
							value,
							clientId: effectiveClientId,
							fieldsMap,
							fieldName,
						});
					}

					// Set non-CRDT fields
					Object.entries(modified).forEach(([k, v]) => {
						if (!crdtFields.has(k)) {
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
			revisions.set(document, (revisions.get(document) ?? 0) + 1);
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
					const ctx = hasContext(collection) ? getContext(collection) : null;
					const effectiveClientId = ctx?.clientId ?? 'local';
					const modifiedKeys = new Set(
						Object.entries(modifiedFields)
							.filter(([key, value]) => crdtFields.has(key) || value !== undefined)
							.map(([key]) => key)
					);
					fields.forEach((_, key) => {
						if (!crdtFields.has(key) && !modifiedKeys.has(key)) fields.delete(key);
					});

					Object.entries(modifiedFields).forEach(([k, v]) => {
						const crdtInfo = crdtFields.get(k);
						if (!crdtInfo && v === undefined) {
							fields.delete(k);
							return;
						}

						// Handle register updates specially - set value with client ID
						if (crdtInfo?.type === 'register') {
							let registerMap = fields.get(k);
							if (detectYjsType(registerMap) !== 'map') {
								registerMap = new Y.Map();
								fields.set(k, registerMap);
							}
							(registerMap as Y.Map<unknown>).set(effectiveClientId, {
								value: v,
								timestamp: Date.now(),
							});
							return;
						}

						// Skip other CRDT types - they have dedicated bindings
						if (crdtInfo) {
							return;
						}

						// Never overwrite existing Yjs CRDT values
						const existingValue = fields.get(k);
						if (isYjsAbstractType(existingValue)) {
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

	interface DeleteRollbackAttempt {
		documentId: string;
		document: Y.Doc;
		generation: number;
		deletedAt: unknown;
		accepted: boolean;
	}

	const rollbackDeleteAttempt = async (attempt: DeleteRollbackAttempt): Promise<void> => {
		if (stopped || attempt.generation !== connection.generation) return;
		if (docManager.get(attempt.documentId) !== attempt.document) return;
		const meta = attempt.document.getMap('_meta');
		const previousRepairEpoch = fullSyncRequired.get(attempt.documentId);
		const repairEpoch = ++fullSyncEpoch;
		fullSyncRequired.set(attempt.documentId, repairEpoch);
		try {
			await persistence.kv.set(fullSyncKey(attempt.documentId), repairEpoch);
		} catch (error) {
			if (fullSyncRequired.get(attempt.documentId) === repairEpoch) {
				if (previousRepairEpoch === undefined) fullSyncRequired.delete(attempt.documentId);
				else fullSyncRequired.set(attempt.documentId, previousRepairEpoch);
			}
			throw error;
		}
		ensureGeneration(attempt.generation);
		if (
			docManager.get(attempt.documentId) !== attempt.document ||
			meta.get('_deleted') !== true ||
			meta.get('_deletedAt') !== attempt.deletedAt
		)
			return;
		let restored = false;
		attempt.document.transact(() => {
			if (meta.get('_deleted') !== true || meta.get('_deletedAt') !== attempt.deletedAt) return;
			meta.delete('_deleted');
			meta.delete('_deletedAt');
			restored = true;
		}, YjsOrigin.Local);
		if (!restored) return;
		revisions.set(attempt.documentId, (revisions.get(attempt.documentId) ?? 0) + 1);
		await docManager.flush([attempt.documentId]);
		ensureGeneration(attempt.generation);
		if (
			docManager.get(attempt.documentId) !== attempt.document ||
			isDocumentDeleted(docManager, attempt.documentId)
		)
			return;
		const restoredItem = serializeDocument(docManager, attempt.documentId, crdtFields);
		if (!restoredItem) {
			throw new Error(`Cannot serialize document ${attempt.documentId} for rollback`);
		}
		ops.upsert([restoredItem as DataType]);
		logger.debug('Rolled back delete', { documentId: attempt.documentId });
	};

	return {
		id: collection,
		getKey,
		utils,
		extensions,

		onInsert: async ({ transaction }: CollectionTransaction<DataType>) => {
			assertWritable();
			const mutationGeneration = connection.generation;
			await persistenceReadyPromise;
			ensureGeneration(mutationGeneration);
			await serialize(async () => {
				ensureGeneration(mutationGeneration);
				for (const mutation of transaction.mutations) {
					const id = String(mutation.key);
					pendingCreates.add(id);
					await persistence.kv.set(pendingCreateKey(id), true);
				}
			});
			ensureGeneration(mutationGeneration);
			const deltas = applyYjsInsert(transaction.mutations);

			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
				ensureGeneration(mutationGeneration);
				await docManager.flush(transaction.mutations.map((mutation) => String(mutation.key)));
				ensureGeneration(mutationGeneration);

				// Process mutations in parallel for better performance
				await Promise.all(
					transaction.mutations.map(async (mut, i) => {
						const delta = deltas[i];
						if (!delta || delta.length === 0) return;

						const document = String(mut.key);
						revisions.set(document, (revisions.get(document) ?? 0) + 1);
						const materializedDoc = serializeDocument(docManager, document);
						if (!materializedDoc) {
							throw new Error(`Cannot serialize document ${document} for insert`);
						}

						ensureGeneration(mutationGeneration);
						await convexClient.mutation(api.replicate, {
							document: document,
							bytes: delta.buffer,
							material: materializedDoc,
							type: 'insert',
						});
						ensureGeneration(mutationGeneration);
						await acknowledgeCreate(document, mutationGeneration);
					})
				);
			} catch (error) {
				handleMutationError(error);
			}
		},

		onUpdate: async ({ transaction }: CollectionTransaction<DataType>) => {
			assertWritable();
			const mutationGeneration = connection.generation;
			const mutation = transaction.mutations[0];
			const documentKey = String(mutation.key);

			const metadata = mutation.metadata as { contentSync?: ContentSyncMetadata } | undefined;
			const isContentSync = !!metadata?.contentSync;

			const deltas = isContentSync ? null : applyYjsUpdate(transaction.mutations);
			if (isContentSync)
				revisions.set(documentKey, (revisions.get(documentKey) ?? 0) + 1);

			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
				ensureGeneration(mutationGeneration);
				await docManager.flush(transaction.mutations.map((mutation) => String(mutation.key)));
				ensureGeneration(mutationGeneration);

				if (isContentSync && metadata?.contentSync) {
					const { bytes, material } = metadata.contentSync;
					const repairEpoch = fullSyncRequired.get(documentKey);
					const revision = revisions.get(documentKey) ?? 0;
					const document = docManager.get(documentKey);
					let repairBytes = bytes;
					let repairMaterial = material;
					if (repairEpoch !== undefined && document) {
						const fullDoc = serializeDocument(docManager, documentKey);
						if (!fullDoc) {
							throw new Error(`Cannot serialize document ${documentKey} for update`);
						}
						repairBytes = Y.encodeStateAsUpdateV2(document).buffer as ArrayBuffer;
						repairMaterial = fullDoc;
					}
					ensureGeneration(mutationGeneration);
					await convexClient.mutation(api.replicate, {
						document: documentKey,
						bytes: repairBytes,
						material: repairMaterial,
						type: 'update',
					});
					ensureGeneration(mutationGeneration);
					if (repairEpoch !== undefined)
						await acknowledgeFullSync(
							documentKey,
							repairEpoch,
							mutationGeneration,
							revision
						);
					return;
				}

				if (deltas) {
					// Process mutations in parallel for better performance
					await Promise.all(
						transaction.mutations.map(async (mut, i) => {
							const delta = deltas[i];
							if (!delta || delta.length === 0) return;

							const docId = String(mut.key);
							const repairEpoch = fullSyncRequired.get(docId);
							const revision = revisions.get(docId) ?? 0;
							const document = docManager.get(docId);
							const fullDoc = serializeDocument(docManager, docId);
							if (!fullDoc) {
								throw new Error(`Cannot serialize document ${docId} for update`);
							}

							ensureGeneration(mutationGeneration);
							await convexClient.mutation(api.replicate, {
								document: docId,
								bytes:
									repairEpoch !== undefined && document
										? (Y.encodeStateAsUpdateV2(document).buffer as ArrayBuffer)
										: delta.buffer,
								material: fullDoc,
								type: 'update',
							});
							ensureGeneration(mutationGeneration);
							if (repairEpoch !== undefined)
								await acknowledgeFullSync(
									docId,
									repairEpoch,
									mutationGeneration,
									revision
								);
						})
					);
				}
			} catch (error) {
				handleMutationError(error);
			}
		},

		onDelete: async ({ transaction }: CollectionTransaction<DataType>) => {
			assertWritable();
			const mutationGeneration = connection.generation;
			const rollbackAttempts: DeleteRollbackAttempt[] = [];
			try {
				await Promise.all([persistenceReadyPromise, optimisticReadyPromise]);
				ensureGeneration(mutationGeneration);

				for (const mut of transaction.mutations) {
					const documentId = String(mut.key);
					const ydoc = docManager.get(documentId);
					const repairEpoch = fullSyncRequired.get(documentId);
					const delta = ydoc ? applyDeleteMarkerToDoc(ydoc) : createDeleteDelta();
					const rollbackAttempt = ydoc
						? {
								documentId,
								document: ydoc,
								generation: mutationGeneration,
								deletedAt: ydoc.getMap('_meta').get('_deletedAt'),
								accepted: false,
							}
						: undefined;
					if (rollbackAttempt) rollbackAttempts.push(rollbackAttempt);
					revisions.set(documentId, (revisions.get(documentId) ?? 0) + 1);
					const revision = revisions.get(documentId) ?? 0;
					await docManager.flush([documentId]);
					ensureGeneration(mutationGeneration);

					const original = mut.original;
					if (original && Object.keys(original).length > 0) {
						ops.delete([original as DataType]);
					}

					ensureGeneration(mutationGeneration);
					await convexClient.mutation(api.replicate, {
						document: documentId,
						bytes:
							repairEpoch !== undefined && ydoc
								? (Y.encodeStateAsUpdateV2(ydoc).buffer as ArrayBuffer)
								: delta.buffer,
						type: 'delete',
					});
					if (rollbackAttempt) rollbackAttempt.accepted = true;
					ensureGeneration(mutationGeneration);
					if (repairEpoch !== undefined)
						await acknowledgeFullSync(
							documentId,
							repairEpoch,
							mutationGeneration,
							revision
						);
				}
			} catch (error) {
				const rollbackErrors: unknown[] = [];
				for (const attempt of [...rollbackAttempts].reverse()) {
					if (attempt.accepted) continue;
					try {
						await serialize(() => rollbackDeleteAttempt(attempt));
					} catch (rollbackError) {
						rollbackErrors.push(rollbackError);
					}
				}
				if (rollbackErrors.length > 0) {
					const cause = error instanceof Error ? error.message : String(error);
					throw new AggregateError(
						[error, ...rollbackErrors],
						`Delete failed and local rollback could not be persisted: ${cause}`
					);
				}
				handleMutationError(error);
			}
		},

		sync: {
			rowUpdateMode: 'full',
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
				const docs: DataType[] = ssrDocuments ? [...ssrDocuments] : [];

				localReady = (async () => {
					try {
						const existingDocIds = await persistence.listDocuments(collection);
						if (stopped) return;
						for (const docId of existingDocIds) {
							if (await persistence.kv.get(pendingCreateKey(docId))) pendingCreates.add(docId);
							const repairEpoch = await persistence.kv.get(fullSyncKey(docId));
							if (typeof repairEpoch === 'number' && Number.isFinite(repairEpoch)) {
								fullSyncRequired.set(docId, repairEpoch);
								fullSyncEpoch = Math.max(fullSyncEpoch, repairEpoch);
							}
							if (stopped) return;
							docManager.getOrCreate(docId);
						}

						const docPromises = docManager.enablePersistence((document, ydoc) => {
							return persistence.createDocPersistence(`${collection}:${document}`, ydoc);
						});
						await Promise.all(docPromises);
						if (stopped) return;

						resolvePersistenceReady?.();

						const clientId = await getClientId(persistence.kv);
						if (stopped) return;
						updateContext(collection, { clientId });

						ops = createReplicateOps<DataType>(params);

						resolveOptimisticReady?.();

						if (ssrCrdt) {
							for (const [docId, state] of Object.entries(ssrCrdt)) {
								const update = new Uint8Array(state.bytes);
								await docManager.applyRemote(docId, update);
							}
						}

						const docIds = docManager.documents();
						if (docIds.length > 0) {
							const items = extractAllDocuments(docManager, crdtFields) as DataType[];
							ops.replace(items);
						} else {
							ops.replace([]);
						}

						markReady();
						getContext(collection).resolve?.();

						getContext(collection).resolveActorReady?.();
						startNetwork = async () => {
							const token = connection.generation;
							let cursor = await seqService.load(collection);
							if (stopped || !connection.active || token !== connection.generation) return;
							// Recovery never delays publishing persisted local rows or starting discovery.
							void recover();
							const subscribe = () => {
								if (!connection.active || token !== connection.generation) return;
								subscription?.();
								subscription = convexClient.onUpdate(
									api.delta,
									{ seq: cursor, limit: 1000 },
									(response: any) => {
										void serialize(async () => {
											if (!connection.active || token !== connection.generation) return;
											if (!response || !Array.isArray(response.changes) || response.seq <= cursor)
												return;
											const documents = new Set<string>();
											for (const change of response.changes) {
												if (change.seq <= cursor) continue;
												if (!change.document)
													throw new Error('Stream change is missing its document');
												documents.add(change.document);
												revisions.set(change.document, (revisions.get(change.document) ?? 0) + 1);
												if (change.exists === false) {
													await removeDocument(change.document);
												} else {
													if (!change.bytes) throw new Error('Stream change is missing its update');
													await docManager.applyRemote(
														change.document,
														new Uint8Array(change.bytes)
													);
												}
											}
											const acknowledgements = [...documents].map((document) => ({
												document,
												vector: docManager.encodeStateVector(document),
											}));
											await docManager.flush(documents);
											// Disconnect drains this accepted local work. Publish its durable
											// rows even if it cancels the subsequent checkpoint/acknowledgement.
											publishDocuments(documents);
											if (!connection.active || token !== connection.generation) return;
											await seqService.save(collection, response.seq);
											if (!connection.active || token !== connection.generation) return;
											cursor = response.seq;
											for (const { document, vector } of acknowledgements) {
												durableVectors.set(document, vector.buffer as ArrayBuffer);
												syncQueue.enqueue(`presence:${document}`, async () => {
													if (!connection.active || token !== connection.generation) return;
													await convexClient.mutation(api.presence, {
														document,
														client: clientId,
														action: 'mark',
														seq: response.seq,
														vector: vector.buffer as ArrayBuffer,
													});
												});
											}
											subscribe();
										}).catch((error) => {
											logger.error('Stream persistence failed; retrying from durable cursor', {
												collection,
												error,
											});
											if (connection.active && token === connection.generation) {
												clearTimeout(retryTimer);
												retryTimer = setTimeout(subscribe, 1000);
											}
										});
									}
								);
							};
							subscribe();
							if (sessionSubscribers.size) initSessionSubscription();
						};
						if (desiredConnection && !stopped) {
							connection.connect();
							void startNetwork();
						}

						// Reconnection handling: when browser comes back online, resync local state
						if (typeof globalThis.window !== 'undefined') {
							let wasOffline = false;
							const handleOffline = () => {
								wasOffline = true;
								logger.debug('Network offline detected', { collection });
							};
							const handleOnline = () => {
								if (wasOffline && connection.active) {
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
						stopped = true;
						clearTimeout(retryTimer);
						connection.disconnect();
						// Clean up reconnection listeners if stored in context
						if (hasContext(collection)) {
							const ctx = getContext(collection);
							(ctx as any).cleanupReconnection?.();
						}
						subscription?.();
						syncQueue.destroy();
						prose.cleanup(collection);
						// Clean up presence providers to prevent memory leaks
						for (const provider of presenceProviders.values()) {
							provider.destroy();
						}
						presenceProviders.clear();
						for (const providers of editorPresenceProviders.values())
							for (const provider of providers) provider.destroy();
						editorPresenceProviders.clear();
						documentHandles.clear();
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
export interface CreateCollectionOptions<T extends object> extends ConnectionOptions {
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
					networkMode: options.networkMode,
					readOnly: options.readOnly,
					requestArgs: options.requestArgs,
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
