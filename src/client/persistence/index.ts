export type { Persistence, PersistenceProvider, KeyValueStore, StorageAdapter } from "./types.js";
export type { SqlitePersistenceOptions, SqliteAdapter } from "./sqlite.js";
export type { SqlJsStatic } from "./sqlite-browser.js";

import { memoryPersistence } from "./memory.js";
import { sqlitePersistence } from "./sqlite.js";
import { createBrowserSqlitePersistence } from "./sqlite-browser.js";
import { createReactNativeSqlitePersistence } from "./sqlite-rn.js";
import { createPersistence } from "./adapter.js";

export const persistence = {
  memory: memoryPersistence,
  custom: createPersistence,
  sqlite: {
    browser: createBrowserSqlitePersistence,
    native: createReactNativeSqlitePersistence,
    create: sqlitePersistence,
  },
} as const;
