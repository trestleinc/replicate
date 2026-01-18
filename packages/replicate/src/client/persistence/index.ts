export type { StorageAdapter, Persistence } from "./types.js";

import { memoryPersistence } from "./memory.js";
import { createNativeSqlitePersistence } from "./sqlite/native.js";
import { createWebSqlitePersistence, onceWebSqlitePersistence } from "./sqlite/web.js";
import { createCustomPersistence } from "./custom.js";
import { createWebEncryptionPersistence } from "./encrypted/web.js";
import { isPRFSupported } from "./encrypted/webauthn.js";
import { createEncryptionManager } from "./encrypted/manager.js";

export type {
	WebEncryptionConfig,
	NativeEncryptionConfig,
	EncryptionPersistence,
	EncryptionState,
} from "./encrypted/types.js";

export type {
	EncryptionManager,
	EncryptionManagerConfig,
	EncryptionManagerState,
	EncryptionManagerHooks,
	EncryptionPreference,
} from "./encrypted/manager.js";

export const persistence = {
	web: {
		sqlite: {
			create: createWebSqlitePersistence,
			once: onceWebSqlitePersistence,
		},
		encryption: {
			create: createWebEncryptionPersistence,
			manager: createEncryptionManager,
			webauthn: {
				supported: isPRFSupported,
			},
		},
	},
	native: {
		sqlite: {
			create: createNativeSqlitePersistence,
		},
		encryption: {
			create: (): never => {
				throw new Error("persistence.native.encryption.create() not yet implemented");
			},
			biometric: {
				supported: (): Promise<boolean> => Promise.resolve(false),
			},
		},
	},
	memory: {
		create: memoryPersistence,
	},
	custom: {
		create: createCustomPersistence,
	},
} as const;
