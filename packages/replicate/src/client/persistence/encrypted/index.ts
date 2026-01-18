export type {
	WebEncryptionConfig,
	NativeEncryptionConfig,
	EncryptionPersistence,
	EncryptionState,
	PassphraseConfig,
	RecoveryConfig,
	LockConfig,
} from "./types.js";

export { createWebEncryptionPersistence } from "./web.js";
export { isPRFSupported } from "./webauthn.js";
export {
	createEncryptionManager,
	type EncryptionManager,
	type EncryptionManagerConfig,
	type EncryptionManagerState,
	type EncryptionManagerHooks,
	type EncryptionPreference,
} from "./manager.js";
