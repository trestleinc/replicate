export type {
	WebEncryptedConfig,
	NativeEncryptedConfig,
	EncryptedPersistence,
	EncryptionState,
	PassphraseConfig,
	RecoveryConfig,
	LockConfig,
} from "./types.js";

export { createWebEncryptedPersistence } from "./web.js";
export { isPRFSupported } from "./webauthn.js";
