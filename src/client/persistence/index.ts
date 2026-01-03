export type { StorageAdapter, Persistence } from "./types.js";

import { memoryPersistence } from "./memory.js";
import { createNativeSqlitePersistence } from "./sqlite/native.js";
import { createCustomPersistence } from "./custom.js";
import { createPGlitePersistence, oncePGlitePersistence } from "./pglite.js";

export const persistence = {
	pglite: Object.assign(createPGlitePersistence, {
		once: oncePGlitePersistence,
	}),
	sqlite: createNativeSqlitePersistence,
	memory: memoryPersistence,
	custom: createCustomPersistence,
} as const;
