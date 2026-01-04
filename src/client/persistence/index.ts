export type { StorageAdapter, Persistence } from "./types.js";

import { memoryPersistence } from "./memory.js";
import { createNativeSqlitePersistence } from "./sqlite/native.js";
import { createWebSqlitePersistence, onceWebSqlitePersistence } from "./sqlite/web.js";
import { createCustomPersistence } from "./custom.js";

export const persistence = {
	sqlite: Object.assign(createWebSqlitePersistence, {
		once: onceWebSqlitePersistence,
	}),
	native: createNativeSqlitePersistence,
	memory: memoryPersistence,
	custom: createCustomPersistence,
} as const;
