import {
  Effect,
  Context,
  Ref,
  Scope,
  HashMap,
  Option,
  Exit,
} from "effect";
import * as Y from "yjs";
import {
  createDocumentActor,
  type DocumentActor,
  type SyncFn,
  type ActorConfig,
} from "$/client/services/actor";

export interface ActorManager {
  readonly register: (
    documentId: string,
    ydoc: Y.Doc,
    syncFn: SyncFn,
    debounceMs?: number,
  ) => Effect.Effect<DocumentActor>;

  readonly get: (documentId: string) => Effect.Effect<DocumentActor | null>;

  readonly onLocalChange: (documentId: string) => Effect.Effect<void>;

  readonly onServerUpdate: (
    documentId: string,
  ) => Effect.Effect<void>;

  readonly unregister: (documentId: string) => Effect.Effect<void>;

  readonly destroy: () => Effect.Effect<void>;
}

export class ActorManagerService extends Context.Tag("ActorManager")<
  ActorManagerService,
  ActorManager
>() {}

export interface ActorManagerConfig {
  readonly debounceMs?: number;
  readonly maxRetries?: number;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_RETRIES = 3;

interface ManagedActor {
  readonly actor: DocumentActor;
  readonly scope: Scope.CloseableScope;
}

export const createActorManager = (
  config: ActorManagerConfig = {},
): Effect.Effect<ActorManager, never, Scope.Scope> =>
  Effect.gen(function* () {
    const actorConfig: ActorConfig = {
      debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    };

    const actorsRef = yield* Ref.make(HashMap.empty<string, ManagedActor>());

    const manager: ActorManager = {
      register: (documentId, ydoc, syncFn, debounceMs) =>
        Effect.gen(function* () {
          const actors = yield* Ref.get(actorsRef);
          const existing = HashMap.get(actors, documentId);

          if (Option.isSome(existing)) {
            return existing.value.actor;
          }

          const scope = yield* Scope.make();

          const config: ActorConfig = debounceMs !== undefined
            ? { ...actorConfig, debounceMs }
            : actorConfig;

          const actor = yield* createDocumentActor(
            documentId,
            ydoc,
            syncFn,
            config,
          ).pipe(Effect.provideService(Scope.Scope, scope));

          yield* Ref.update(actorsRef, HashMap.set(documentId, { actor, scope }));

          yield* Effect.log(`Actor registered for document ${documentId}`);

          return actor;
        }),

      get: documentId =>
        Ref.get(actorsRef).pipe(
          Effect.map((actors) => {
            const opt = HashMap.get(actors, documentId);
            return Option.isSome(opt) ? opt.value.actor : null;
          }),
        ),

      onLocalChange: documentId =>
        Effect.gen(function* () {
          const actor = yield* manager.get(documentId);
          if (actor) {
            yield* actor.send({ _tag: "LocalChange" });
          }
        }),

      onServerUpdate: documentId =>
        Effect.gen(function* () {
          const actor = yield* manager.get(documentId);
          if (actor) {
            yield* actor.send({ _tag: "ExternalUpdate" });
          }
        }),

      unregister: documentId =>
        Effect.gen(function* () {
          const actors = yield* Ref.get(actorsRef);
          const managed = HashMap.get(actors, documentId);

          if (Option.isNone(managed)) {
            return;
          }

          yield* managed.value.actor.shutdown;
          yield* Scope.close(managed.value.scope, Exit.void);
          yield* Ref.update(actorsRef, HashMap.remove(documentId));

          yield* Effect.log(`Actor unregistered for document ${documentId}`);
        }),

      destroy: () =>
        Effect.gen(function* () {
          const actors = yield* Ref.get(actorsRef);

          yield* Effect.all(
            Array.from(HashMap.values(actors)).map(managed =>
              Effect.gen(function* () {
                yield* managed.actor.shutdown;
                yield* Scope.close(managed.scope, Exit.void);
              }),
            ),
            { concurrency: "unbounded" },
          );

          yield* Ref.set(actorsRef, HashMap.empty());

          yield* Effect.log("ActorManager destroyed");
        }),
    };

    return manager;
  });
