import { Effect, Context, Layer } from "effect";
import { IDBError, IDBWriteError } from "$/client/errors";
import type { KeyValueStore } from "$/client/persistence/types";

export type Cursor = number;

export class CursorService extends Context.Tag("CursorService")<
  CursorService,
  {
    readonly loadCursor: (collection: string) => Effect.Effect<Cursor, IDBError>;
    readonly saveCursor: (collection: string, cursor: Cursor) => Effect.Effect<void, IDBWriteError>;
    readonly clearCursor: (collection: string) => Effect.Effect<void, IDBError>;
    readonly loadPeerId: (collection: string) => Effect.Effect<string, IDBError | IDBWriteError>;
  }
>() {}

function generatePeerId(): string {
  return crypto.randomUUID();
}

export function createCursorLayer(kv: KeyValueStore) {
  return Layer.succeed(
    CursorService,
    CursorService.of({
      loadCursor: collection =>
        Effect.gen(function* (_) {
          const key = `cursor:${collection}`;
          const stored = yield* _(
            Effect.tryPromise({
              try: () => kv.get<Cursor>(key),
              catch: cause => new IDBError({ operation: "get", key, cause }),
            }),
          );

          if (stored !== undefined) {
            yield* _(
              Effect.logDebug("Loaded cursor from storage", {
                collection,
                cursor: stored,
              }),
            );
            return stored;
          }

          yield* _(
            Effect.logDebug("No stored cursor, using default", {
              collection,
            }),
          );
          return 0;
        }),

      saveCursor: (collection, cursor) =>
        Effect.gen(function* (_) {
          const key = `cursor:${collection}`;
          yield* _(
            Effect.tryPromise({
              try: () => kv.set(key, cursor),
              catch: cause => new IDBWriteError({ key, value: cursor, cause }),
            }),
          );
          yield* _(
            Effect.logDebug("Cursor saved", {
              collection,
              cursor,
            }),
          );
        }),

      clearCursor: collection =>
        Effect.gen(function* (_) {
          const key = `cursor:${collection}`;
          yield* _(
            Effect.tryPromise({
              try: () => kv.del(key),
              catch: cause => new IDBError({ operation: "delete", key, cause }),
            }),
          );
          yield* _(Effect.logDebug("Cursor cleared", { collection }));
        }),

      loadPeerId: collection =>
        Effect.gen(function* (_) {
          const key = `peerId:${collection}`;
          const stored = yield* _(
            Effect.tryPromise({
              try: () => kv.get<string>(key),
              catch: cause => new IDBError({ operation: "get", key, cause }),
            }),
          );

          if (stored) {
            yield* _(Effect.logDebug("Loaded peerId from storage", { collection, peerId: stored }));
            return stored;
          }

          const newPeerId = generatePeerId();
          yield* _(
            Effect.tryPromise({
              try: () => kv.set(key, newPeerId),
              catch: cause => new IDBWriteError({ key, value: newPeerId, cause }),
            }),
          );
          yield* _(Effect.logDebug("Generated new peerId", { collection, peerId: newPeerId }));
          return newPeerId;
        }),
    }),
  );
}
