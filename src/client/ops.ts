/**
 * Replicate Helpers - Collection-bound functions for TanStack DB optimistic updates
 *
 * Each collection gets its own set of bound functions that operate on that
 * collection's TanStack DB instance. No global state - fully concurrent-safe.
 */

export interface ReplicateParams {
  readonly begin: () => void;
  readonly write: (message: { type: "insert" | "update" | "delete"; value: unknown }) => void;
  readonly commit: () => void;
  readonly truncate: () => void;
}

/**
 * Bound replicate operations for a specific collection.
 * These functions are already tied to the collection's TanStack DB params.
 */
export interface BoundReplicateOps<T> {
  readonly insert: (items: T[]) => void;
  readonly delete: (items: T[]) => void;
  readonly upsert: (items: T[]) => void;
  readonly replace: (items: T[]) => void;
}

/**
 * Create bound replicate operations for a collection.
 * Returns functions that are already tied to the collection's params.
 * This is the proper way to handle multiple concurrent collections.
 *
 * @example
 * ```typescript
 * const ops = createReplicateOps<Task>(params);
 * ops.replace(items);  // Always targets THIS collection's TanStack DB
 * ops.upsert([item]);
 * ops.delete([item]);
 * ```
 */
export function createReplicateOps<T>(params: ReplicateParams): BoundReplicateOps<T> {
  return {
    insert(items: T[]): void {
      params.begin();
      for (const item of items) {
        params.write({ type: "insert", value: item });
      }
      params.commit();
    },

    delete(items: T[]): void {
      params.begin();
      for (const item of items) {
        params.write({ type: "delete", value: item });
      }
      params.commit();
    },

    upsert(items: T[]): void {
      params.begin();
      for (const item of items) {
        params.write({ type: "update", value: item });
      }
      params.commit();
    },

    replace(items: T[]): void {
      params.begin();
      params.truncate();
      for (const item of items) {
        params.write({ type: "insert", value: item });
      }
      params.commit();
    },
  };
}

// Internal - for test cleanup only
export function _resetReplicateParams(): void {
  // No-op now - nothing to reset since we don't use global state
}
