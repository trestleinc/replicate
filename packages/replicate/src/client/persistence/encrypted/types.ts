import type { Persistence } from "../types.js";

export interface PassphraseConfig {
	get: () => Promise<string>;
	setup: (recoveryKey: string) => Promise<string>;
}

export interface RecoveryConfig {
	onSetup: (key: string) => Promise<void>;
	onRecover: () => Promise<string>;
}

export interface LockConfig {
	idle: number;
}

export interface WebUnlockConfig {
	webauthn?: true;
	passphrase?: PassphraseConfig;
}

export interface NativeUnlockConfig {
	biometric?: true;
	passphrase?: PassphraseConfig;
}

export interface WebEncryptionConfig {
	storage: Persistence;
	user: string;
	mode?: "local" | "e2e";
	unlock: WebUnlockConfig;
	recovery?: RecoveryConfig;
	lock?: LockConfig;
	onLock?: () => void;
	onUnlock?: () => void;
}

export interface NativeEncryptionConfig {
	storage: Persistence;
	user: string;
	mode?: "local" | "e2e";
	unlock: NativeUnlockConfig;
	recovery?: RecoveryConfig;
	lock?: LockConfig;
	onLock?: () => void;
	onUnlock?: () => void;
}

export type EncryptionState = "locked" | "unlocked" | "setup";

export interface EncryptionPersistence extends Persistence {
	readonly state: EncryptionState;
	lock(): Promise<void>;
	unlock(): Promise<void>;
	isSupported(): Promise<boolean>;
}
