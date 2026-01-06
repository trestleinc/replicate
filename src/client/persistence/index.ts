export type { StorageAdapter, Persistence } from "./types.js";

import { memoryPersistence } from "./memory.js";
import { createNativeSqlitePersistence } from "./sqlite/native.js";
import { createWebSqlitePersistence, onceWebSqlitePersistence } from "./sqlite/web.js";
import { createCustomPersistence } from "./custom.js";
import { createWebEncryptedPersistence } from "./encrypted/web.js";

export type {
	WebEncryptedConfig,
	NativeEncryptedConfig,
	EncryptedPersistence,
	EncryptionState,
} from "./encrypted/types.js";

export { isPRFSupported } from "./encrypted/webauthn.js";

export const persistence = {
	web: {
		sqlite: Object.assign(createWebSqlitePersistence, {
			once: onceWebSqlitePersistence,
		}),
		encrypted: createWebEncryptedPersistence,
	},
	native: {
		sqlite: createNativeSqlitePersistence,
		encrypted: (): never => {
			throw new Error("persistence.native.encrypted() not yet implemented");
		},
	},
	memory: memoryPersistence,
	custom: createCustomPersistence,
} as const;
