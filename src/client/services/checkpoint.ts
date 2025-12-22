import { Effect, Context, Layer } from 'effect';
import { IDBError, IDBWriteError } from '$/client/errors';
import type { KeyValueStore } from '$/client/persistence/types';

export interface CheckpointData {
  lastModified: number;
}

export class Checkpoint extends Context.Tag('Checkpoint')<
  Checkpoint,
  {
    readonly loadCheckpoint: (collection: string) => Effect.Effect<CheckpointData, IDBError>;
    readonly saveCheckpoint: (
      collection: string,
      checkpoint: CheckpointData
    ) => Effect.Effect<void, IDBWriteError>;
    readonly clearCheckpoint: (collection: string) => Effect.Effect<void, IDBError>;
  }
>() {}

/**
 * Create a Checkpoint service layer using the provided KeyValueStore.
 */
export function createCheckpointLayer(kv: KeyValueStore) {
  return Layer.succeed(
    Checkpoint,
    Checkpoint.of({
      loadCheckpoint: (collection) =>
        Effect.gen(function* (_) {
          const key = `checkpoint:${collection}`;
          const stored = yield* _(
            Effect.tryPromise({
              try: () => kv.get<CheckpointData>(key),
              catch: (cause) => new IDBError({ operation: 'get', key, cause }),
            })
          );

          if (stored) {
            yield* _(
              Effect.logDebug('Loaded checkpoint from storage', {
                collection,
                checkpoint: stored,
              })
            );
            return stored;
          }

          yield* _(
            Effect.logDebug('No stored checkpoint, using default', {
              collection,
            })
          );
          return { lastModified: 0 };
        }),

      saveCheckpoint: (collection, checkpoint) =>
        Effect.gen(function* (_) {
          const key = `checkpoint:${collection}`;
          yield* _(
            Effect.tryPromise({
              try: () => kv.set(key, checkpoint),
              catch: (cause) => new IDBWriteError({ key, value: checkpoint, cause }),
            })
          );
          yield* _(
            Effect.logDebug('Checkpoint saved', {
              collection,
              checkpoint,
            })
          );
        }),

      clearCheckpoint: (collection) =>
        Effect.gen(function* (_) {
          const key = `checkpoint:${collection}`;
          yield* _(
            Effect.tryPromise({
              try: () => kv.del(key),
              catch: (cause) => new IDBError({ operation: 'delete', key, cause }),
            })
          );
          yield* _(Effect.logDebug('Checkpoint cleared', { collection }));
        }),
    })
  );
}
