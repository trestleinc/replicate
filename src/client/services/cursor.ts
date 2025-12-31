import { Effect, Context, Layer } from "effect";
import { IDBError, IDBWriteError } from "$/client/errors";
import type { KeyValueStore } from "$/client/persistence/types";

/** Sync sequence number for cursor-based replication */
export type Seq = number;

export class Cursor extends Context.Tag("Cursor")<
  Cursor,
  {
    readonly loadSeq: (collection: string) => Effect.Effect<Seq, IDBError>;
    readonly saveSeq: (collection: string, seq: Seq) => Effect.Effect<void, IDBWriteError>;
    readonly clearSeq: (collection: string) => Effect.Effect<void, IDBError>;
    readonly loadPeerId: (collection: string) => Effect.Effect<string, IDBError | IDBWriteError>;
  }
>() {}

function generatePeerId(): string {
  return crypto.randomUUID();
}

export function createCursorLayer(kv: KeyValueStore) {
  return Layer.succeed(
    Cursor,
    Cursor.of({
      loadSeq: (collection: string) =>
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

      saveSeq: (collection: string, seq: Seq) =>
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

      clearSeq: (collection: string) =>
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

      loadPeerId: (collection: string) =>
        Effect.gen(function* (_) {
          const sessionKey = `replicate:peerId:${collection}`;

          if (typeof sessionStorage !== "undefined") {
            const sessionStored = sessionStorage.getItem(sessionKey);
            if (sessionStored) {
              yield* _(Effect.logDebug("Loaded peerId from sessionStorage", {
                collection,
                peerId: sessionStored,
              }));
              return sessionStored;
            }
          }

          const key = `peerId:${collection}`;
          const stored = yield* _(
            Effect.tryPromise({
              try: () => kv.get<string>(key),
              catch: cause => new IDBError({ operation: "get", key, cause }),
            }),
          );

          const peerId = stored ?? generatePeerId();

          if (typeof sessionStorage !== "undefined") {
            sessionStorage.setItem(sessionKey, peerId);
          }

          if (!stored) {
            yield* _(
              Effect.tryPromise({
                try: () => kv.set(key, peerId),
                catch: cause => new IDBWriteError({ key, value: peerId, cause }),
              }),
            );
            yield* _(Effect.logDebug("Generated new peerId", { collection, peerId }));
          }
          else {
            yield* _(Effect.logDebug("Loaded peerId from storage", { collection, peerId }));
          }

          return peerId;
        }),
    }),
  );
}
