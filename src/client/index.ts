export { setReplicate, getProtocolInfo, type SetOptions } from '$/client/set.js';

export {
  convexCollectionOptions,
  getOrInitializeCollection,
  YjsOrigin,
  type ConvexCollection,
  type ConvexCollectionOptionsConfig,
  type ConvexCollectionUtils,
  type Materialized,
  type EditorBinding,
} from '$/client/collection.js';

export {
  NetworkError,
  IDBError,
  IDBWriteError,
  ReconciliationError,
  ProseFieldNotFoundError,
  CollectionNotReadyError,
} from '$/client/errors.js';

// NOTE: Do NOT re-export Yjs here to avoid duplicate module issues with bundlers.
// Apps should import 'yjs' directly and use Vite's resolve.dedupe to ensure a single instance.
export { IndexeddbPersistence } from 'y-indexeddb';

// NOTE: OperationType is now exported from top-level @trestleinc/replicate
// Consumers should import it from there, not from /client

export { fragmentToText } from '$/client/merge.js';

export { NonRetriableError } from '@tanstack/offline-transactions';
