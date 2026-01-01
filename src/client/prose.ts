import * as Y from "yjs";
import { z } from "zod";
import type { Collection } from "@tanstack/db";
import { Effect, SubscriptionRef, Stream, Fiber } from "effect";
import { getLogger } from "$/client/logger";
import { serializeYMapValue } from "$/client/merge";
import { getContext, hasContext } from "$/client/services/context";
import { runWithRuntime } from "$/client/services/engine";
import type { ProseValue } from "$/shared/types";

const SERVER_ORIGIN = "server";
const noop = (): void => undefined;

const logger = getLogger(["replicate", "prose"]);

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

function createSyncFn(
  document: string,
  ydoc: Y.Doc,
  ymap: Y.Map<unknown>,
  collectionRef: Collection<any>,
): () => Promise<void> {
  return async () => {
    const material = serializeYMapValue(ymap);
    const delta = Y.encodeStateAsUpdateV2(ydoc);
    const bytes = delta.buffer as ArrayBuffer;

    const result = collectionRef.update(
      document,
      { metadata: { contentSync: { bytes, material } } },
      (draft: any) => {
        draft.updatedAt = Date.now();
      },
    );
    await result.isPersisted.promise;
  };
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
    debounceMs,
  } = config;

  if (!hasContext(collection)) {
    logger.warn("Cannot observe fragment - collection not initialized", { collection, document });
    return noop;
  }

  const ctx = getContext(collection);
  const actorManager = ctx.actorManager;
  const runtime = ctx.runtime;

  if (!actorManager || !runtime) {
    logger.warn("Cannot observe fragment - actor system not initialized", { collection, document });
    return noop;
  }

  const existingCleanup = ctx.fragmentObservers.get(document);
  if (existingCleanup) {
    logger.debug("Fragment already being observed", { collection, document, field });
    return existingCleanup;
  }

  const syncFn = createSyncFn(document, ydoc, ymap, collectionRef);

  runWithRuntime(runtime, actorManager.register(document, ydoc, syncFn, debounceMs));

  const observerHandler = (_events: Y.YEvent<any>[], transaction: Y.Transaction) => {
    if (transaction.origin === SERVER_ORIGIN) {
      return;
    }

    runWithRuntime(runtime, actorManager.onLocalChange(document));
  };

  fragment.observeDeep(observerHandler);

  const cleanup = () => {
    fragment.unobserveDeep(observerHandler);
    runWithRuntime(runtime, actorManager.unregister(document));
    ctx.fragmentObservers.delete(document);
    logger.debug("Fragment observer cleaned up", { collection, document, field });
  };

  ctx.fragmentObservers.set(document, cleanup);
  logger.debug("Fragment observer registered", { collection, document, field });

  return cleanup;
}

export function isPending(collection: string, document: string): boolean {
  if (!hasContext(collection)) return false;
  const ctx = getContext(collection);
  if (!ctx.actorManager || !ctx.runtime) return false;

  let result = false;

  const effect = Effect.gen(function* () {
    const actor = yield* ctx.actorManager!.get(document);
    if (!actor) return false;
    return yield* SubscriptionRef.get(actor.pending);
  });

  try {
    result = Effect.runSync(Effect.provide(effect, ctx.runtime.runtime));
  }
  catch {
    result = false;
  }

  return result;
}

export function subscribePending(
  collection: string,
  document: string,
  callback: (pending: boolean) => void,
): () => void {
  if (!hasContext(collection)) return noop;
  const ctx = getContext(collection);
  if (!ctx.actorManager || !ctx.runtime) return noop;

  let fiber: Fiber.RuntimeFiber<void, never> | null = null;

  const setupEffect = Effect.gen(function* () {
    const actor = yield* ctx.actorManager!.get(document);
    if (!actor) return;

    const stream = actor.pending.changes;

    fiber = yield* Effect.fork(
      Stream.runForEach(stream, (pending: boolean) =>
        Effect.sync(() => callback(pending)),
      ),
    );
  });

  try {
    Effect.runSync(Effect.provide(setupEffect, ctx.runtime.runtime));
  }
  catch {
    return noop;
  }

  return () => {
    if (fiber) {
      Effect.runPromise(Fiber.interrupt(fiber));
    }
  };
}

export function cleanup(collection: string): void {
  if (!hasContext(collection)) return;
  const ctx = getContext(collection);

  for (const [, cleanupFn] of ctx.fragmentObservers) {
    cleanupFn();
  }
  ctx.fragmentObservers.clear();

  if (ctx.runtime) {
    ctx.runtime.cleanup();
  }

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
