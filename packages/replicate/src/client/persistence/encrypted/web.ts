import * as Y from "yjs";
import type { Persistence, PersistenceProvider, KeyValueStore } from "../types.js";
import type { WebEncryptionConfig, EncryptionPersistence, EncryptionState } from "./types.js";
import {
	isPRFSupported,
	createPRFCredential,
	getPRFKey,
	deriveEncryptionKey,
	type PRFCredential,
} from "./webauthn.js";
import {
	encrypt,
	decrypt,
	generateSalt,
	generateRecoveryKey,
	deriveKeyFromPassphrase,
} from "./crypto.js";

const CREDENTIAL_KEY = "webauthn:credential";
const SALT_KEY = "encryption:salt";
const SETUP_KEY = "encryption:setup";
const DOC_PREFIX = "enc:doc:";

interface StoredCredential {
	id: string;
	rawId: number[];
	salt: number[];
}

function serializeCredential(cred: PRFCredential): StoredCredential {
	return {
		id: cred.id,
		rawId: Array.from(cred.rawId),
		salt: Array.from(cred.salt),
	};
}

function deserializeCredential(stored: StoredCredential): PRFCredential {
	return {
		id: stored.id,
		rawId: new Uint8Array(stored.rawId),
		salt: new Uint8Array(stored.salt),
	};
}

class EncryptedKeyValueStore implements KeyValueStore {
	constructor(
		private inner: KeyValueStore,
		private getKey: () => CryptoKey | null,
	) {}

	async get<T>(key: string): Promise<T | undefined> {
		const encryptionKey = this.getKey();
		if (!encryptionKey) return undefined;

		const encrypted = await this.inner.get<number[]>(key);
		if (!encrypted) return undefined;

		try {
			const decrypted = await decrypt(encryptionKey, new Uint8Array(encrypted));
			return JSON.parse(new TextDecoder().decode(decrypted)) as T;
		} catch {
			return undefined;
		}
	}

	async set<T>(key: string, value: T): Promise<void> {
		const encryptionKey = this.getKey();
		if (!encryptionKey) throw new Error("Encryption locked");

		const data = new TextEncoder().encode(JSON.stringify(value));
		const encrypted = await encrypt(encryptionKey, data);
		await this.inner.set(key, Array.from(encrypted));
	}

	async del(key: string): Promise<void> {
		await this.inner.del(key);
	}
}

class EncryptedPersistenceProvider implements PersistenceProvider {
	private updateHandler: (update: Uint8Array, origin: unknown) => void;
	private pendingWrites: Promise<void>[] = [];
	readonly whenSynced: Promise<void>;

	constructor(
		private innerStorage: Persistence,
		private collection: string,
		private ydoc: Y.Doc,
		private encryptionKey: CryptoKey,
	) {
		this.whenSynced = this.loadState();

		this.updateHandler = (update: Uint8Array, origin: unknown) => {
			if (origin !== "encrypted-load") {
				const writePromise = this.saveUpdate(update).catch((err: Error) => {
					console.error("[EncryptedPersistence] Save failed:", err);
				});
				this.pendingWrites.push(writePromise);
				writePromise.finally(() => {
					this.pendingWrites = this.pendingWrites.filter(p => p !== writePromise);
				});
			}
		};
		this.ydoc.on("update", this.updateHandler);
	}

	private async loadState(): Promise<void> {
		const snapshotKey = `${DOC_PREFIX}${this.collection}:snapshot`;
		const deltasKey = `${DOC_PREFIX}${this.collection}:deltas`;

		const encryptedSnapshot = await this.innerStorage.kv.get<number[]>(snapshotKey);
		if (encryptedSnapshot) {
			const decrypted = await decrypt(this.encryptionKey, new Uint8Array(encryptedSnapshot));
			Y.applyUpdate(this.ydoc, decrypted, "encrypted-load");
		}

		const encryptedDeltas = await this.innerStorage.kv.get<number[][]>(deltasKey);
		if (encryptedDeltas) {
			for (const encDelta of encryptedDeltas) {
				const decrypted = await decrypt(this.encryptionKey, new Uint8Array(encDelta));
				Y.applyUpdate(this.ydoc, decrypted, "encrypted-load");
			}
		}
	}

	private async saveUpdate(update: Uint8Array): Promise<void> {
		const deltasKey = `${DOC_PREFIX}${this.collection}:deltas`;

		const encrypted = await encrypt(this.encryptionKey, update);
		const existingDeltas = (await this.innerStorage.kv.get<number[][]>(deltasKey)) ?? [];
		existingDeltas.push(Array.from(encrypted));
		await this.innerStorage.kv.set(deltasKey, existingDeltas);

		if (existingDeltas.length >= 50) {
			await this.compact();
		}
	}

	private async compact(): Promise<void> {
		const snapshotKey = `${DOC_PREFIX}${this.collection}:snapshot`;
		const deltasKey = `${DOC_PREFIX}${this.collection}:deltas`;

		const snapshot = Y.encodeStateAsUpdate(this.ydoc);
		const encrypted = await encrypt(this.encryptionKey, snapshot);

		await this.innerStorage.kv.set(snapshotKey, Array.from(encrypted));
		await this.innerStorage.kv.del(deltasKey);
	}

	async flush(): Promise<void> {
		await Promise.all(this.pendingWrites);
	}

	destroy(): void {
		this.ydoc.off("update", this.updateHandler);
	}
}

export async function createWebEncryptionPersistence(
	config: WebEncryptionConfig,
): Promise<EncryptionPersistence> {
	const { storage, user, unlock, recovery, lock: lockConfig, onLock, onUnlock } = config;

	let encryptionKey: CryptoKey | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;

	const isSetup = await storage.kv.get<boolean>(SETUP_KEY);
	let state: EncryptionState = isSetup ? "locked" : "setup";

	const resetIdleTimer = () => {
		if (!lockConfig?.idle) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(
			() => {
				void doLock();
			},
			lockConfig.idle * 60 * 1000,
		);
	};

	const doLock = async () => {
		encryptionKey = null;
		state = "locked";
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
		onLock?.();
	};

	const doUnlock = async () => {
		const isSetup = await storage.kv.get<boolean>(SETUP_KEY);

		if (!isSetup) {
			state = "setup";

			if (unlock.webauthn) {
				const supported = await isPRFSupported();
				if (supported) {
					try {
						const credential = await createPRFCredential(user);
						const prfKey = await getPRFKey(credential);
						encryptionKey = await deriveEncryptionKey(prfKey, `replicate:${user}`);

						await storage.kv.set(CREDENTIAL_KEY, serializeCredential(credential));
						await storage.kv.set(SETUP_KEY, true);

						if (recovery) {
							const recoveryKey = generateRecoveryKey();
							await recovery.onSetup(recoveryKey);
						}

						state = "unlocked";
						resetIdleTimer();
						onUnlock?.();
						return;
					} catch (err) {
						if (!unlock.passphrase) {
							throw err;
						}
					}
				}
			}

			if (unlock.passphrase) {
				const salt = generateSalt();
				const passphrase = await unlock.passphrase.setup(recovery ? generateRecoveryKey() : "");
				encryptionKey = await deriveKeyFromPassphrase(passphrase, salt);

				await storage.kv.set(SALT_KEY, Array.from(salt));
				await storage.kv.set(SETUP_KEY, true);

				state = "unlocked";
				resetIdleTimer();
				onUnlock?.();
				return;
			}

			throw new Error("No unlock method available");
		}

		if (unlock.webauthn) {
			const storedCred = await storage.kv.get<StoredCredential>(CREDENTIAL_KEY);
			if (storedCred) {
				try {
					const credential = deserializeCredential(storedCred);
					const prfKey = await getPRFKey(credential);
					encryptionKey = await deriveEncryptionKey(prfKey, `replicate:${user}`);

					state = "unlocked";
					resetIdleTimer();
					onUnlock?.();
					return;
				} catch (err) {
					if (!unlock.passphrase) {
						throw err;
					}
				}
			} else if (!unlock.passphrase) {
				throw new Error("WebAuthn credential not found. Set up encryption again.");
			}
		}

		if (unlock.passphrase) {
			const saltArray = await storage.kv.get<number[]>(SALT_KEY);
			if (!saltArray) {
				throw new Error("Encryption data not found. Set up encryption again.");
			}
			const salt = new Uint8Array(saltArray);
			const passphrase = await unlock.passphrase.get();
			encryptionKey = await deriveKeyFromPassphrase(passphrase, salt);

			state = "unlocked";
			resetIdleTimer();
			onUnlock?.();
			return;
		}

		throw new Error("No unlock method configured");
	};

	const encryptedKv = new EncryptedKeyValueStore(storage.kv, () => encryptionKey);

	return {
		get state() {
			return state;
		},

		async lock() {
			await doLock();
		},

		async unlock() {
			await doUnlock();
		},

		async isSupported() {
			if (unlock.webauthn) {
				return isPRFSupported();
			}
			return true;
		},

		createDocPersistence(collection: string, ydoc: Y.Doc): PersistenceProvider {
			if (!encryptionKey) {
				throw new Error("Encryption locked - call unlock() first");
			}
			return new EncryptedPersistenceProvider(storage, collection, ydoc, encryptionKey);
		},

		async listDocuments(prefix: string): Promise<string[]> {
			const keys = await storage.listDocuments(prefix);
			return keys;
		},

		kv: encryptedKv,
	};
}
