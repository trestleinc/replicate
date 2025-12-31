import { Effect, Context, Layer, Schedule, Duration } from "effect";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { NetworkError } from "$/client/errors";

interface SyncApi {
  stream: FunctionReference<"query">;
  recovery: FunctionReference<"query">;
  compact: FunctionReference<"mutation">;
  mark: FunctionReference<"mutation">;
}

export interface SyncConfig {
  collection: string;
  convexClient: ConvexClient;
  api: SyncApi;
}

export interface CompactResult {
  success: boolean;
  removed: number;
  retained: number;
  size: number;
}

export interface RecoveryResult {
  diff?: ArrayBuffer;
  vector: ArrayBuffer;
  cursor: number;
}

export interface StreamChange {
  document: string;
  bytes: ArrayBuffer;
  seq: number;
  type: string;
}

export interface StreamResponse {
  changes: StreamChange[];
  cursor: number;
  more: boolean;
  compact?: string;
}

const retryPolicy = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.compose(Schedule.elapsed),
  Schedule.whileOutput(duration => Duration.lessThan(duration, Duration.seconds(30))),
);

export class Sync extends Context.Tag("Sync")<
  Sync,
  {
    readonly subscribe: (
      cursor: number,
      limit: number,
      onUpdate: (response: StreamResponse) => void,
    ) => Effect.Effect<() => void, NetworkError>;
    readonly recover: (vector: ArrayBuffer) => Effect.Effect<RecoveryResult, NetworkError>;
    readonly compact: (document: string) => Effect.Effect<CompactResult, NetworkError>;
    readonly mark: (
      document: string,
      client: string,
      seq: number,
    ) => Effect.Effect<void, NetworkError>;
  }
>() {}

export function createSyncLayer(config: SyncConfig) {
  const { convexClient, api } = config;

  return Layer.succeed(
    Sync,
    Sync.of({
      subscribe: (cursor, limit, onUpdate) =>
        Effect.gen(function* () {
          const unsubscribe = yield* Effect.try({
            try: () =>
              convexClient.onUpdate(
                api.stream,
                { cursor, limit },
                (response: StreamResponse) => {
                  onUpdate(response);
                },
              ),
            catch: cause => new NetworkError({ operation: "subscribe", cause, retryable: true }),
          });

          return unsubscribe;
        }),

      recover: vector =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: () => convexClient.query(api.recovery, { vector }),
            catch: cause => new NetworkError({ operation: "recovery", cause, retryable: true }),
          });

          return response as RecoveryResult;
        }).pipe(Effect.retry(retryPolicy)),

      compact: document =>
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise({
            try: () => convexClient.mutation(api.compact, { document }),
            catch: cause => new NetworkError({ operation: "compact", cause, retryable: true }),
          });

          return result as CompactResult;
        }).pipe(Effect.retry(retryPolicy)),

      mark: (document, client, seq) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => convexClient.mutation(api.mark, { document, client, seq }),
            catch: cause => new NetworkError({ operation: "mark", cause, retryable: true }),
          });
        }),
    }),
  );
}
