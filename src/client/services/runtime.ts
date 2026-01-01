import {
  Effect,
  Layer,
  Runtime,
  Scope,
  Ref,
  Option,
} from "effect";
import {
  ActorManagerService,
  createActorManager,
  type ActorManager,
  type ActorManagerConfig,
} from "$/client/services/manager";
import { SeqService, createSeqLayer } from "$/client/services/seq";
import type { KeyValueStore } from "$/client/persistence/types";

export type ReplicateServices = ActorManagerService | SeqService;

export interface ReplicateRuntime {
  readonly runtime: Runtime.Runtime<ReplicateServices>;
  readonly actorManager: ActorManager;
  readonly cleanup: () => Promise<void>;
}

interface RuntimeState {
  readonly runtime: ReplicateRuntime;
  readonly refCount: number;
}

const singletonRef = Ref.unsafeMake<Option.Option<RuntimeState>>(Option.none());

export interface CreateRuntimeOptions {
  readonly kv: KeyValueStore;
  readonly config?: ActorManagerConfig;
  readonly singleton?: boolean;
}

const createRuntimeInternal = (
  options: CreateRuntimeOptions,
): Effect.Effect<ReplicateRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;

    const actorManager = yield* createActorManager(options.config).pipe(
      Effect.provideService(Scope.Scope, scope),
    );

    const seqLayer = createSeqLayer(options.kv);

    const layer = Layer.mergeAll(
      Layer.succeed(ActorManagerService, actorManager),
      seqLayer,
    );

    const runtime = yield* Layer.toRuntime(layer);

    const replicateRuntime: ReplicateRuntime = {
      runtime,
      actorManager,
      cleanup: () => Effect.runPromise(actorManager.destroy()),
    };

    return replicateRuntime;
  });

export const createRuntime = (
  options: CreateRuntimeOptions,
): Effect.Effect<ReplicateRuntime, never, Scope.Scope> => {
  if (!options.singleton) {
    return createRuntimeInternal(options);
  }

  return Effect.gen(function* () {
    const existing = yield* Ref.get(singletonRef);

    if (Option.isSome(existing)) {
      yield* Ref.update(singletonRef, Option.map(state => ({
        ...state,
        refCount: state.refCount + 1,
      })));
      return existing.value.runtime;
    }

    const runtime = yield* createRuntimeInternal(options);

    yield* Ref.set(singletonRef, Option.some({
      runtime,
      refCount: 1,
    }));

    return runtime;
  });
};

export const releaseRuntime = (
  options: { singleton?: boolean },
): Effect.Effect<void> => {
  if (!options.singleton) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const existing = yield* Ref.get(singletonRef);

    if (Option.isNone(existing)) {
      return;
    }

    const newRefCount = existing.value.refCount - 1;

    if (newRefCount <= 0) {
      yield* Effect.promise(() => existing.value.runtime.cleanup());
      yield* Ref.set(singletonRef, Option.none());
    }
    else {
      yield* Ref.update(singletonRef, Option.map(state => ({
        ...state,
        refCount: newRefCount,
      })));
    }
  });
};

export const runWithRuntime = <A, E>(
  runtime: ReplicateRuntime,
  effect: Effect.Effect<A, E, ReplicateServices>,
): Promise<A> => Runtime.runPromise(runtime.runtime)(effect);

export const runSyncWithRuntime = <A, E>(
  runtime: ReplicateRuntime,
  effect: Effect.Effect<A, E, ReplicateServices>,
): A => Runtime.runSync(runtime.runtime)(effect);
