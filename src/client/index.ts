export {
  convexCollectionOptions,
  getOrInitializeCollection,
  type ConvexCollection,
  type EditorBinding,
} from '$/client/collection.js';

export {
  NetworkError,
  IDBError,
  IDBWriteError,
  ReconciliationError,
  ProseError,
  CollectionNotReadyError,
} from '$/client/errors.js';

export { extract } from '$/client/merge.js';

// Persistence exports
export {
  indexeddbPersistence,
  memoryPersistence,
  sqlitePersistence,
  type Persistence,
  type PersistenceProvider,
  type KeyValueStore,
} from '$/client/persistence/index.js';
