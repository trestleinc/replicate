export type { StorageAdapter } from "./types.js";

import { memoryPersistence } from "./memory.js";
import { createBrowserSqlitePersistence } from "./sqlite-browser.js";
import { createReactNativeSqlitePersistence } from "./sqlite-rn.js";
import { createPersistence } from "./adapter.js";

export const persistence = {
  memory: memoryPersistence,
  custom: createPersistence,
  sqlite: {
    browser: createBrowserSqlitePersistence,
    native: createReactNativeSqlitePersistence,
  },
} as const;
