import * as Y from "yjs";
import { createMutex } from "lib0/mutex";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { Collection } from "@tanstack/db";
import type { Persistence } from "$/client/persistence/types";
import type { SubdocManager } from "$/client/subdocs";

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

interface UndoConfig {
  captureTimeout: number;
  trackedOrigins: Set<unknown>;
}

export interface ProseState {
  applyingFromServer: Map<string, boolean>;
  debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
  lastSyncedVectors: Map<string, Uint8Array>;
  pendingState: Map<string, boolean>;
  pendingListeners: Map<string, Set<(pending: boolean) => void>>;
  fragmentObservers: Map<string, () => void>;
  failedSyncQueue: Map<string, boolean>;
}

export interface CollectionContext {
  collection: string;
  subdocManager: SubdocManager;
  convexClient: ConvexClient;
  api: ConvexCollectionApi;
  persistence: Persistence;
  proseFields: Set<string>;
  mutex: ReturnType<typeof createMutex>;
  undoConfig: UndoConfig;
  debounceMs: number;
  proseState: ProseState;
  fragmentUndoManagers: Map<string, Y.UndoManager>;
  cleanup?: () => void;
  peerId?: string;
  collectionRef?: Collection<any>;
  serverStateVector?: Uint8Array;
}

const contexts = new Map<string, CollectionContext>();

export function getContext(collection: string): CollectionContext {
  const ctx = contexts.get(collection);
  if (!ctx) throw new Error(`Collection ${collection} not initialized`);
  return ctx;
}

export function hasContext(collection: string): boolean {
  return contexts.has(collection);
}

type InitContextConfig = Omit<
  CollectionContext,
  | "mutex"
  | "proseState"
  | "fragmentUndoManagers"
  | "cleanup"
  | "peerId"
  | "collectionRef"
  | "serverStateVector"
>;

function createProseState(): ProseState {
  return {
    applyingFromServer: new Map(),
    debounceTimers: new Map(),
    lastSyncedVectors: new Map(),
    pendingState: new Map(),
    pendingListeners: new Map(),
    fragmentObservers: new Map(),
    failedSyncQueue: new Map(),
  };
}

export function initContext(config: InitContextConfig): CollectionContext {
  const ctx: CollectionContext = {
    ...config,
    mutex: createMutex(),
    proseState: createProseState(),
    fragmentUndoManagers: new Map(),
  };
  contexts.set(config.collection, ctx);
  return ctx;
}

export function deleteContext(collection: string): void {
  contexts.delete(collection);
}

type UpdateableFields = "peerId" | "collectionRef" | "serverStateVector" | "cleanup";

export function updateContext(
  collection: string,
  updates: Partial<Pick<CollectionContext, UpdateableFields>>,
): CollectionContext {
  const ctx = getContext(collection);
  Object.assign(ctx, updates);
  return ctx;
}
