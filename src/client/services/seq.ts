import { Effect, Context, Layer } from "effect";
import { IDBError, IDBWriteError } from "$/client/errors";
import type { KeyValueStore } from "$/client/persistence/types";

export type Seq = number;

export class SeqService extends Context.Tag("SeqService")<
  SeqService,
  {
    readonly load: (collection: string) => Effect.Effect<Seq, IDBError>;
    readonly save: (collection: string, seq: Seq) => Effect.Effect<void, IDBWriteError>;
    readonly clear: (collection: string) => Effect.Effect<void, IDBError>;
  }
>() {}

export function createSeqLayer(kv: KeyValueStore) {
  return Layer.succeed(
    SeqService,
    SeqService.of({
      load: (collection: string) =>
        Effect.gen(function* (_) {
          const key = `cursor:${collection}`;
          const stored = yield* _(
            Effect.tryPromise({
              try: () => kv.get<Seq>(key),
              catch: cause => new IDBError({ operation: "get", key, cause }),
            }),
          );

          if (stored !== undefined) {
            yield* _(
              Effect.logDebug("Loaded seq from storage", {
                collection,
                seq: stored,
              }),
            );
            return stored;
          }

          yield* _(
            Effect.logDebug("No stored seq, using default", {
              collection,
            }),
          );
          return 0;
        }),

      save: (collection: string, seq: Seq) =>
        Effect.gen(function* (_) {
          const key = `cursor:${collection}`;
          yield* _(
            Effect.tryPromise({
              try: () => kv.set(key, seq),
              catch: cause => new IDBWriteError({ key, value: seq, cause }),
            }),
          );
          yield* _(
            Effect.logDebug("Seq saved", {
              collection,
              seq,
            }),
          );
        }),

      clear: (collection: string) =>
        Effect.gen(function* (_) {
          const key = `cursor:${collection}`;
          yield* _(
            Effect.tryPromise({
              try: () => kv.del(key),
              catch: cause => new IDBError({ operation: "delete", key, cause }),
            }),
          );
          yield* _(Effect.logDebug("Seq cleared", { collection }));
        }),
    }),
  );
}
