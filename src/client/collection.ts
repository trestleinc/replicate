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
import type { DocFromSchema, TableNamesFromSchema } from "$/client/types";
import { findProseFields } from "$/client/validators";
import { Effect } from "effect";
import { ProseError, NonRetriableError } from "$/client/errors";
import { SeqService, createSeqLayer, type Seq } from "$/client/services/seq";
import { getClientId } from "$/client/services/session";
import { createReplicateOps, type BoundReplicateOps } from "$/client/ops";
import { isDoc, fragmentFromJSON } from "$/client/merge";
import { createDocumentManager, serializeDocument, extractAllDocuments } from "$/client/documents";
import { createDeleteDelta, applyDeleteMarkerToDoc } from "$/client/deltas";
import * as prose from "$/client/prose";
import {
	initContext,
	getContext,
	hasContext,
	updateContext,
	deleteContext,
	waitForActorReady,
} from "$/client/services/context";
import { createRuntime, runWithRuntime, type ReplicateRuntime } from "$/client/services/engine";
import {
	createAwarenessProvider,
	type ConvexAwarenessProvider,
	type UserIdentity,
} from "$/client/services/awareness";
import { Awareness } from "y-protocols/awareness";

enum YjsOrigin {
	Local = "local",
	Fragment = "fragment",
	Server = "server",
}

const noop = (): void => undefined;

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

const DEFAULT_DEBOUNCE_MS = 200;

export function convexCollectionOptions<
	T extends object = object,
	TKey extends string | number = string | number,
>(
	config: ConvexCollectionConfig<T, TKey>,
): CollectionConfig<T, TKey, never, ConvexCollectionUtils<T>> & {
	id: string;
	utils: ConvexCollectionUtils<T>;
} {
	const { validator, getKey, material, convexClient, api, persistence } = config;

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

			await waitForActorReady(collection);

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
					user: options?.user,
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

	const docManager = createDocumentManager(collection);
	const docPersistence: PersistenceProvider = null as any;

	initContext({
		collection,
		docManager,
		client: convexClient,
		api,
		persistence,
		fields: proseFieldSet,
	});

	// Bound replicate operations - set during sync initialization
	// Used by onDelete and other handlers that need to sync with TanStack DB
	let ops: BoundReplicateOps<DataType> = null as any;

	// Create services layer with the persistence KV store
	const seqLayer = createSeqLayer(persistence.kv);

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

						const persistedCursor = await Effect.runPromise(
							Effect.gen(function* () {
								const seqSvc = yield* SeqService;
								return yield* seqSvc.load(collection);
							}).pipe(Effect.provide(seqLayer)),
						);
						let cursor = ssrCursor ?? persistedCursor;

						if (cursor > 0 && docManager.documents().length === 0) {
							cursor = 0;
							persistence.kv.set(`cursor:${collection}`, 0);
						}

						const replicateRuntime: ReplicateRuntime = await Effect.runPromise(
							Effect.scoped(
								createRuntime({
									kv: persistence.kv,
									config: { debounceMs: DEFAULT_DEBOUNCE_MS },
								}),
							),
						);
						const actorManager = replicateRuntime.actorManager;
						updateContext(collection, { actorManager, runtime: replicateRuntime });
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
							}

							await runWithRuntime(replicateRuntime, actorManager.onServerUpdate(document));
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
							}

							await runWithRuntime(replicateRuntime, actorManager.onServerUpdate(document));
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
										.catch(noop);
								});
								Promise.all(markPromises);
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
					} catch {
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
	get(): Collection<T, string, ConvexCollectionUtils<T>, never, T> & NonSingleResult;
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
	NonSingleResult;

interface CreateCollectionOptions<T extends object> {
	persistence: () => Promise<Persistence>;
	config: () => Omit<LazyCollectionConfig<T>, "material">;
	pagination?: PaginationConfig;
}

export namespace collection {
	export type Infer<C> = C extends { $docType?: infer T } ? NonNullable<T> : never;
}

export const collection = {
	create<Schema extends SchemaDefinition<any, any>, TableName extends TableNamesFromSchema<Schema>>(
		schema: Schema,
		table: TableName,
		options: CreateCollectionOptions<DocFromSchema<Schema, TableName>>,
	): LazyCollection<DocFromSchema<Schema, TableName>> {
		type T = DocFromSchema<Schema, TableName>;

		const tableDefinition = (schema.tables as Record<string, { validator?: GenericValidator }>)[
			table
		];
		if (!tableDefinition) {
			throw new Error(`Table "${table}" not found in schema`);
		}
		const validator = tableDefinition.validator;

		let persistence: Persistence | null = null;
		let resolvedConfig: LazyCollectionConfig<T> | null = null;
		let material: Materialized<T> | undefined;
		type Instance = LazyCollection<T>["get"] extends () => infer R ? R : never;
		let instance: Instance | null = null;

		let paginationState: PaginationState = {
			status: "idle",
			count: 0,
			cursor: null,
		};
		const listeners = new Set<(state: PaginationState) => void>();

		const notify = () => listeners.forEach(cb => cb(paginationState));

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
					const opts = convexCollectionOptions<T, string>({
						...resolvedConfig,
						validator,
						persistence,
						material,
					});
					instance = createCollection(opts) as Instance;
				}
				return instance!;
			},

			pagination: {
				async load(): Promise<PaginatedPage<T> | null> {
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
						})) as PaginatedPage<T>;

						if (instance && result.page.length > 0) {
							instance.insert(result.page as T[]);
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
	},
};
