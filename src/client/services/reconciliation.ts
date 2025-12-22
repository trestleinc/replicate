import { Effect, Context, Layer } from 'effect';
import * as Y from 'yjs';
import { yjsTransact, serializeYMap } from '$/client/merge';
import { ReconciliationError as ReconciliationErrorImport } from '$/client/errors';

/**
 * Reconciliation handles removal of phantom documents -
 * documents that exist locally but have been deleted on the server.
 */
export class Reconciliation extends Context.Tag('Reconciliation')<
  Reconciliation,
  {
    /**
     * Reconciles local Yjs state with server state by removing phantom documents.
     * Uses an existing Yjs document and map instead of creating new ones.
     *
     * @param ydoc - Existing Yjs document
     * @param ymap - Existing Yjs map within the document
     * @param collection - Collection name for logging
     * @param serverDocs - Documents from server
     * @param getKey - Function to extract key from document
     */
    readonly reconcile: <T>(
      ydoc: Y.Doc,
      ymap: Y.Map<unknown>,
      collection: string,
      serverDocs: readonly T[],
      getKey: (doc: T) => string
    ) => Effect.Effect<T[], ReconciliationErrorImport>;
  }
>() {}

export const ReconciliationLive = Layer.succeed(
  Reconciliation,
  Reconciliation.of({
    reconcile: <T>(
      ydoc: Y.Doc,
      ymap: Y.Map<unknown>,
      collection: string,
      serverDocs: readonly T[],
      getKey: (doc: T) => string
    ) =>
      Effect.gen(function* (_) {
        const serverDocIds = new Set(serverDocs.map(getKey));
        const toDelete: string[] = [];

        // Find phantom documents (exist locally but not on server)
        ymap.forEach((_, key) => {
          if (!serverDocIds.has(key)) {
            toDelete.push(key);
          }
        });

        if (toDelete.length === 0) {
          yield* _(Effect.logDebug('No phantom documents found', { collection }));
          return [];
        }

        yield* _(
          Effect.logWarning(`Found ${toDelete.length} phantom documents`, {
            collection,
            phantomDocs: toDelete.slice(0, 10), // Log first 10
          })
        );

        // Extract items before deletion for TanStack DB sync
        // Use serializeYMap for consistent ProseMirror JSON (not XML string from toJSON)
        const removedItems: T[] = [];
        for (const key of toDelete) {
          const itemYMap = ymap.get(key);
          if (itemYMap instanceof Y.Map) {
            removedItems.push(serializeYMap(itemYMap) as T);
          }
        }

        // Remove from Yjs using plain function
        yjsTransact(
          ydoc,
          () => {
            for (const key of toDelete) {
              ymap.delete(key);
            }
          },
          'reconciliation'
        );

        yield* _(
          Effect.logInfo('Reconciliation completed', {
            collection,
            deletedCount: removedItems.length,
          })
        );

        // Return removed items for TanStack DB sync
        return removedItems;
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.fail(
            new ReconciliationErrorImport({
              collection,
              reason: 'Reconciliation failed',
              cause,
            })
          )
        )
      ),
  })
);
