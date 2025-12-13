import { Effect, Context, Layer, Data } from 'effect';
import * as Y from 'yjs';
import { yjsTransact, applyUpdate, serializeYMap } from '$/client/merge.js';
import { Checkpoint, type CheckpointData } from '$/client/services/checkpoint.js';
import type { NetworkError } from '$/client/errors.js';

export interface SnapshotResponse {
  crdtBytes: Uint8Array;
  checkpoint: CheckpointData;
  documentCount: number;
}

export class SnapshotMissingError extends Data.TaggedError('SnapshotMissingError')<{
  collection: string;
  message: string;
}> {}

export class SnapshotRecoveryError extends Data.TaggedError('SnapshotRecoveryError')<{
  collection: string;
  cause: unknown;
}> {}

/**
 * Snapshot handles crash recovery by replacing local state
 * with a server snapshot when difference/divergence is detected.
 */
export class Snapshot extends Context.Tag('Snapshot')<
  Snapshot,
  {
    /**
     * Recovers from a server snapshot by clearing local state and applying snapshot.
     * Uses an existing Yjs document and map instead of creating new ones.
     *
     * @param ydoc - Existing Yjs document
     * @param ymap - Existing Yjs map within the document
     * @param collection - Collection name for logging
     * @param fetchSnapshot - Function to fetch snapshot from server
     */
    readonly recoverFromSnapshot: <T>(
      ydoc: Y.Doc,
      ymap: Y.Map<unknown>,
      collection: string,
      fetchSnapshot: () => Effect.Effect<SnapshotResponse | null, NetworkError>
    ) => Effect.Effect<T[], SnapshotMissingError | SnapshotRecoveryError>;
  }
>() {}

export const SnapshotLive = Layer.effect(
  Snapshot,
  Effect.gen(function* (_) {
    const checkpointSvc = yield* _(Checkpoint);

    return Snapshot.of({
      recoverFromSnapshot: (ydoc, ymap, collection, fetchSnapshot) =>
        Effect.gen(function* () {
          yield* Effect.logWarning('Difference detected, recovering from snapshot', {
            collection,
          });

          const snapshot = yield* fetchSnapshot();

          if (!snapshot) {
            return yield* Effect.fail(
              new SnapshotMissingError({
                collection,
                message: 'Difference detected but no snapshot available - data loss scenario',
              })
            );
          }

          // Clear existing Yjs state using plain function
          yjsTransact(
            ydoc,
            () => {
              const keys = Array.from(ymap.keys());
              for (const key of keys) {
                ymap.delete(key);
              }
            },
            'snapshot-clear'
          );

          // Apply snapshot update using plain function
          applyUpdate(ydoc, snapshot.crdtBytes, 'snapshot');

          // Save new checkpoint
          yield* checkpointSvc.saveCheckpoint(collection, snapshot.checkpoint);

          // Extract all items from Yjs for TanStack DB sync
          // Use serializeYMap for consistent ProseMirror JSON (not XML string from toJSON)
          const items: any[] = [];
          ymap.forEach((itemYMap) => {
            if (itemYMap instanceof Y.Map) {
              items.push(serializeYMap(itemYMap));
            }
          });

          yield* Effect.logInfo('Snapshot recovery completed', {
            collection,
            checkpoint: snapshot.checkpoint,
            documentCount: items.length,
          });

          // Return items for TanStack DB sync
          return items;
        }).pipe(
          Effect.catchAll(
            (cause): Effect.Effect<never, SnapshotMissingError | SnapshotRecoveryError> => {
              if (cause instanceof SnapshotMissingError) {
                return Effect.fail(cause);
              }
              return Effect.fail(
                new SnapshotRecoveryError({
                  collection,
                  cause,
                })
              );
            }
          )
        ),
    });
  })
);
