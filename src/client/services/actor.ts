import {
  Effect,
  Queue,
  Ref,
  SubscriptionRef,
  Fiber,
  Deferred,
  Duration,
  Schedule,
  Scope,
  Chunk,
} from "effect";
import * as Y from "yjs";
import { SyncError } from "$/client/services/errors";

export type SyncFn = () => Promise<void>;

export type DocumentMessage
  = | { readonly _tag: "LocalChange" }
    | { readonly _tag: "ExternalUpdate" }
    | { readonly _tag: "Shutdown"; readonly done: Deferred.Deferred<void, never> };

interface ActorState {
  readonly vector: Uint8Array;
  readonly lastError: SyncError | null;
  readonly retryCount: number;
}

export interface ActorConfig {
  readonly debounceMs: number;
  readonly maxRetries: number;
}

export interface DocumentActor {
  readonly documentId: string;
  readonly send: (msg: DocumentMessage) => Effect.Effect<void>;
  readonly pending: SubscriptionRef.SubscriptionRef<boolean>;
  readonly shutdown: Effect.Effect<void>;
}

const BATCH_ACCUMULATION_MS = 2;

export const createDocumentActor = (
  documentId: string,
  ydoc: Y.Doc,
  syncFn: SyncFn,
  config: ActorConfig,
): Effect.Effect<DocumentActor, never, Scope.Scope> =>
  Effect.gen(function* () {
    const mailbox = yield* Queue.unbounded<DocumentMessage>();
    const pendingRef = yield* SubscriptionRef.make(false);

    const stateRef = yield* Ref.make<ActorState>({
      vector: Y.encodeStateVector(ydoc),
      lastError: null,
      retryCount: 0,
    });

    const debounceFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

    const retrySchedule = Schedule.exponential(Duration.millis(100)).pipe(
      Schedule.jittered,
      Schedule.intersect(Schedule.recurs(config.maxRetries)),
    );

    const performSync = Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const delta = Y.encodeStateAsUpdateV2(ydoc, state.vector);

      if (delta.length <= 2) {
        return;
      }

      yield* Effect.tryPromise({
        try: () => syncFn(),
        catch: e => new SyncError({
          documentId,
          cause: e,
          retriable: true,
        }),
      });

      const newVector = Y.encodeStateVector(ydoc);
      yield* Ref.update(stateRef, s => ({
        ...s,
        vector: newVector,
        retryCount: 0,
        lastError: null,
      }));
    });

    const scheduleSyncAfterDebounce = Effect.gen(function* () {
      const existingFiber = yield* Ref.get(debounceFiberRef);
      if (existingFiber) {
        yield* Fiber.interrupt(existingFiber);
      }

      yield* SubscriptionRef.set(pendingRef, true);

      const syncFiber = yield* Effect.fork(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(config.debounceMs));

          yield* performSync.pipe(
            Effect.retry(retrySchedule),
            Effect.catchTag("SyncError", e =>
              Effect.gen(function* () {
                yield* Ref.update(stateRef, s => ({
                  ...s,
                  lastError: e,
                  retryCount: config.maxRetries,
                }));
                yield* Effect.logError(`Sync failed for ${documentId}`, e);
              }),
            ),
            Effect.ensuring(SubscriptionRef.set(pendingRef, false)),
          );
        }),
      );

      yield* Ref.set(debounceFiberRef, syncFiber);
    });

    const handleBatch = (
      batch: Chunk.Chunk<DocumentMessage>,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        let hasLocalChanges = false;
        let shutdownDeferred: Deferred.Deferred<void, never> | null = null;

        for (const msg of batch) {
          switch (msg._tag) {
            case "LocalChange":
              hasLocalChanges = true;
              break;

            case "ExternalUpdate": {
              const newVector = Y.encodeStateVector(ydoc);
              yield* Ref.update(stateRef, s => ({ ...s, vector: newVector }));
              break;
            }

            case "Shutdown":
              shutdownDeferred = msg.done;
              break;
          }
        }

        if (shutdownDeferred) {
          const existingFiber = yield* Ref.get(debounceFiberRef);
          if (existingFiber) {
            yield* Fiber.interrupt(existingFiber);
          }
          yield* Deferred.succeed(shutdownDeferred, void 0);
          return false;
        }

        if (hasLocalChanges) {
          yield* scheduleSyncAfterDebounce;
        }

        return true;
      });

    const actorLoop = Effect.gen(function* () {
      let running = true;

      while (running) {
        const first = yield* Queue.take(mailbox);

        yield* Effect.sleep(Duration.millis(BATCH_ACCUMULATION_MS));

        const rest = yield* Queue.takeAll(mailbox);
        const batch = Chunk.prepend(rest, first);

        running = yield* handleBatch(batch);
      }
    });

    yield* Effect.forkScoped(actorLoop);

    const actor: DocumentActor = {
      documentId,

      send: msg => Queue.offer(mailbox, msg).pipe(Effect.asVoid),

      pending: pendingRef,

      shutdown: Effect.gen(function* () {
        const done = yield* Deferred.make<void, never>();
        yield* Queue.offer(mailbox, { _tag: "Shutdown", done });
        yield* Deferred.await(done);
      }),
    };

    return actor;
  });
