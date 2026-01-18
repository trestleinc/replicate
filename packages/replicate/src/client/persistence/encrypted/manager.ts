import type { Persistence } from "../types.js";
import type { EncryptionPersistence, EncryptionState, WebEncryptionConfig } from "./types.js";
import { createWebEncryptionPersistence } from "./web.js";
import { isPRFSupported } from "./webauthn.js";

export type EncryptionPreference = "webauthn" | "passphrase" | "none";

export interface EncryptionManagerHooks {
	change?: (state: EncryptionManagerState) => void;
	passphrase?: () => Promise<string>;
	recovery?: (key: string) => void;
}

export interface EncryptionManagerConfig {
	storage: Persistence;
	user: string;
	preference?: EncryptionPreference;
	hooks?: EncryptionManagerHooks;
}

export interface EncryptionManagerState {
	state: EncryptionState | "disabled";
	error?: Error;
	persistence: Persistence;
}

export interface EncryptionManager {
	get(): EncryptionManagerState;
	enable(): Promise<void>;
	disable(): Promise<void>;
	unlock(): Promise<void>;
	lock(): Promise<void>;
	subscribe(callback: (state: EncryptionManagerState) => void): () => void;
	destroy(): void;
}

const ENABLED_KEY = "encryption:manager:enabled";

export async function createEncryptionManager(
	config: EncryptionManagerConfig,
): Promise<EncryptionManager> {
	const { storage, user, preference = "webauthn", hooks } = config;

	let encryptedPersistence: EncryptionPersistence | null = null;
	let currentState: EncryptionManagerState = {
		state: "disabled",
		persistence: storage,
	};

	const subscribers = new Set<(state: EncryptionManagerState) => void>();

	const notify = (): void => {
		subscribers.forEach(cb => cb(currentState));
		hooks?.change?.(currentState);
	};

	const updateState = (updates: Partial<EncryptionManagerState>): void => {
		currentState = { ...currentState, ...updates };
		notify();
	};

	const isEnabled = await storage.kv.get<boolean>(ENABLED_KEY);

	if (isEnabled && preference !== "none") {
		try {
			const encryptionConfig = await buildEncryptionConfig(storage, user, preference, hooks);
			encryptedPersistence = await createWebEncryptionPersistence(encryptionConfig);

			updateState({
				state: encryptedPersistence.state,
				persistence: encryptedPersistence,
			});
		} catch (err) {
			updateState({
				state: "disabled",
				error: err instanceof Error ? err : new Error(String(err)),
				persistence: storage,
			});
		}
	}

	return {
		get(): EncryptionManagerState {
			return currentState;
		},

		async enable(): Promise<void> {
			if (encryptedPersistence) return;

			try {
				const encryptionConfig = await buildEncryptionConfig(storage, user, preference, hooks);
				encryptedPersistence = await createWebEncryptionPersistence(encryptionConfig);

				await storage.kv.set(ENABLED_KEY, true);

				await encryptedPersistence.unlock();

				updateState({
					state: encryptedPersistence.state,
					error: undefined,
					persistence: encryptedPersistence,
				});
			} catch (err) {
				updateState({
					state: "disabled",
					error: err instanceof Error ? err : new Error(String(err)),
					persistence: storage,
				});
				throw err;
			}
		},

		async disable(): Promise<void> {
			if (encryptedPersistence) {
				await encryptedPersistence.lock();
				encryptedPersistence = null;
			}

			await storage.kv.del(ENABLED_KEY);

			updateState({
				state: "disabled",
				error: undefined,
				persistence: storage,
			});
		},

		async unlock(): Promise<void> {
			if (!encryptedPersistence) {
				throw new Error("Encryption not enabled. Call enable() first.");
			}

			await encryptedPersistence.unlock();

			updateState({
				state: encryptedPersistence.state,
				error: undefined,
				persistence: encryptedPersistence,
			});
		},

		async lock(): Promise<void> {
			if (!encryptedPersistence) return;

			await encryptedPersistence.lock();

			updateState({
				state: encryptedPersistence.state,
				persistence: encryptedPersistence,
			});
		},

		subscribe(callback: (state: EncryptionManagerState) => void): () => void {
			subscribers.add(callback);
			callback(currentState);
			return () => subscribers.delete(callback);
		},

		destroy(): void {
			subscribers.clear();
		},
	};
}

async function buildEncryptionConfig(
	storage: Persistence,
	user: string,
	preference: EncryptionPreference,
	hooks?: EncryptionManagerHooks,
): Promise<WebEncryptionConfig> {
	const webauthnSupported = preference === "webauthn" && (await isPRFSupported());

	const config: WebEncryptionConfig = {
		storage,
		user,
		mode: "local",
		unlock: {},
	};

	if (webauthnSupported) {
		config.unlock.webauthn = true;
	}

	if (hooks?.passphrase || !webauthnSupported) {
		config.unlock.passphrase = {
			get: async () => {
				if (hooks?.passphrase) {
					return hooks.passphrase();
				}
				throw new Error("Passphrase hook not configured");
			},
			setup: async (recoveryKey: string) => {
				if (hooks?.recovery) {
					hooks.recovery(recoveryKey);
				}
				if (hooks?.passphrase) {
					return hooks.passphrase();
				}
				throw new Error("Passphrase hook not configured");
			},
		};
	}

	if (hooks?.recovery) {
		config.recovery = {
			onSetup: async (key: string) => {
				hooks.recovery!(key);
			},
			onRecover: async () => {
				if (hooks?.passphrase) {
					return hooks.passphrase();
				}
				throw new Error("Recovery requires passphrase hook");
			},
		};
	}

	return config;
}
