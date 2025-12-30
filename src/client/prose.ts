/**
 * Prose Field Helpers - Document-level state management for rich text sync
 *
 * Manages Y.XmlFragment observation, debounced sync, and pending state.
 * Uses CollectionContext for state storage.
 */

import * as Y from "yjs";
import { z } from "zod";
import type { Collection } from "@tanstack/db";
import { getLogger } from "$/client/logger";
import { serializeYMapValue } from "$/client/merge";
import { getContext, hasContext, type ProseState } from "$/client/services/context";
import type { ProseValue } from "$/shared/types";

const SERVER_ORIGIN = "server";
const noop = (): void => undefined;

const logger = getLogger(["replicate", "prose"]);

const DEFAULT_DEBOUNCE_MS = 1000;

function getProseState(collection: string): ProseState | null {
  if (!hasContext(collection)) return null;
  return getContext(collection).proseState;
}

export function isApplyingFromServer(collection: string, document: string): boolean {
  const state = getProseState(collection);
  if (!state) return false;
  return state.applyingFromServer.get(document) ?? false;
}

export function setApplyingFromServer(
  collection: string,
  document: string,
  value: boolean,
): void {
  const state = getProseState(collection);
  if (!state) return;
  if (value) {
    state.applyingFromServer.set(document, true);
  }
  else {
    state.applyingFromServer.delete(document);
  }
}

function setPendingInternal(collection: string, document: string, value: boolean): void {
  const state = getProseState(collection);
  if (!state) return;

  const current = state.pendingState.get(document) ?? false;
  if (current !== value) {
    state.pendingState.set(document, value);
    const listeners = state.pendingListeners.get(document);
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb(value);
        }
        catch (err) {
          logger.error("Pending listener error", { collection, document, error: String(err) });
        }
      }
    }
  }
}

export function isPending(collection: string, document: string): boolean {
  const state = getProseState(collection);
  if (!state) return false;
  return state.pendingState.get(document) ?? false;
}

export function subscribePending(
  collection: string,
  document: string,
  callback: (pending: boolean) => void,
): () => void {
  const state = getProseState(collection);
  if (!state) return noop;

  let listeners = state.pendingListeners.get(document);
  if (!listeners) {
    listeners = new Set();
    state.pendingListeners.set(document, listeners);
  }

  listeners.add(callback);
  return () => {
    listeners?.delete(callback);
    if (listeners?.size === 0) {
      state.pendingListeners.delete(document);
    }
  };
}

export function cancelPending(collection: string, document: string): void {
  const state = getProseState(collection);
  if (!state) return;

  const timer = state.debounceTimers.get(document);
  if (timer) {
    clearTimeout(timer);
    state.debounceTimers.delete(document);
    setPendingInternal(collection, document, false);
    logger.debug("Cancelled pending sync due to remote update", { collection, document });
  }
}

export function cancelAllPending(collection: string): void {
  const state = getProseState(collection);
  if (!state) return;

  for (const [doc, timer] of state.debounceTimers) {
    clearTimeout(timer);
    state.debounceTimers.delete(doc);
    setPendingInternal(collection, doc, false);
  }
  logger.debug("Cancelled all pending syncs", { collection });
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

export function observeFragment(config: ProseObserverConfig): () => void {
  const {
    collection,
    document,
    field,
    fragment,
    ydoc,
    ymap,
    collectionRef,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = config;

  const state = getProseState(collection);
  if (!state) {
    logger.warn("Cannot observe fragment - collection not initialized", { collection, document });
    return noop;
  }

  const existingCleanup = state.fragmentObservers.get(document);
  if (existingCleanup) {
    logger.debug("Fragment already being observed", { collection, document, field });
    return existingCleanup;
  }

  const observerHandler = (_events: Y.YEvent<any>[], transaction: Y.Transaction) => {
    if (transaction.origin === SERVER_ORIGIN) {
      return;
    }

    const existing = state.debounceTimers.get(document);
    if (existing) clearTimeout(existing);

    setPendingInternal(collection, document, true);

    const timer = setTimeout(async () => {
      state.debounceTimers.delete(document);

      try {
        const lastVector = state.lastSyncedVectors.get(document);
        const delta = lastVector
          ? Y.encodeStateAsUpdateV2(ydoc, lastVector)
          : Y.encodeStateAsUpdateV2(ydoc);

        if (delta.length <= 2) {
          logger.debug("No changes to sync", { collection, document });
          setPendingInternal(collection, document, false);
          return;
        }

        const bytes = delta.buffer as ArrayBuffer;
        const currentVector = Y.encodeStateVector(ydoc);

        logger.debug("Syncing prose delta", {
          collection,
          document,
          deltaSize: delta.byteLength,
        });

        const material = serializeYMapValue(ymap);

        const result = collectionRef.update(
          document,
          { metadata: { contentSync: { bytes, material } } },
          (draft: any) => {
            draft.updatedAt = Date.now();
          },
        );
        await result.isPersisted.promise;

        state.lastSyncedVectors.set(document, currentVector);
        state.failedSyncQueue.delete(document);
        setPendingInternal(collection, document, false);
        logger.debug("Prose sync completed", { collection, document });
      }
      catch (err) {
        logger.error("Prose sync failed, queued for retry", {
          collection,
          document,
          error: String(err),
        });
        state.failedSyncQueue.set(document, true);
      }
    }, debounceMs);

    state.debounceTimers.set(document, timer);

    if (state.failedSyncQueue.has(document)) {
      state.failedSyncQueue.delete(document);
      logger.debug("Retrying failed sync", { collection, document });
    }
  };

  fragment.observeDeep(observerHandler);

  const cleanup = () => {
    fragment.unobserveDeep(observerHandler);
    cancelPending(collection, document);
    state.fragmentObservers.delete(document);
    state.lastSyncedVectors.delete(document);
    logger.debug("Fragment observer cleaned up", { collection, document, field });
  };

  state.fragmentObservers.set(document, cleanup);
  logger.debug("Fragment observer registered", { collection, document, field });

  return cleanup;
}

export function cleanup(collection: string): void {
  const state = getProseState(collection);
  if (!state) return;

  for (const [, timer] of state.debounceTimers) {
    clearTimeout(timer);
  }
  state.debounceTimers.clear();
  state.pendingState.clear();
  state.pendingListeners.clear();
  state.applyingFromServer.clear();
  state.lastSyncedVectors.clear();

  for (const [, cleanupFn] of state.fragmentObservers) {
    cleanupFn();
  }
  state.fragmentObservers.clear();
  state.failedSyncQueue.clear();

  logger.debug("Prose cleanup complete", { collection });
}

const PROSE_MARKER = Symbol.for("replicate:prose");

function createProseSchema(): z.ZodType<ProseValue> {
  const schema = z.custom<ProseValue>(
    (val) => {
      if (val == null) return true;
      if (typeof val !== "object") return false;
      return (val as { type?: string }).type === "doc";
    },
    { message: "Expected prose document with type \"doc\"" },
  );

  Object.defineProperty(schema, PROSE_MARKER, { value: true, writable: false });

  return schema;
}

function emptyProse(): ProseValue {
  return { type: "doc", content: [] } as unknown as ProseValue;
}

export function prose(): z.ZodType<ProseValue> {
  return createProseSchema();
}

prose.empty = emptyProse;

export function isProseSchema(schema: unknown): boolean {
  return (
    schema != null
    && typeof schema === "object"
    && PROSE_MARKER in schema
    && (schema as Record<symbol, unknown>)[PROSE_MARKER] === true
  );
}

export function extractProseFields(schema: z.ZodObject<z.ZodRawShape>): string[] {
  const fields: string[] = [];

  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    let unwrapped = fieldSchema;
    while (unwrapped instanceof z.ZodOptional || unwrapped instanceof z.ZodNullable) {
      unwrapped = unwrapped.unwrap();
    }

    if (isProseSchema(unwrapped)) {
      fields.push(key);
    }
  }

  return fields;
}
