import { writable, get, derived, type Readable } from "svelte/store";
import {
	persistence,
	type EncryptionPersistence,
	type Persistence,
} from "@trestleinc/replicate/client";
import { sqlite, setEncryptedPersistence } from "./sqlite";
import { getAuthClient } from "./auth-client";

export type EncryptionState =
	| "checking"
	| "setup"
	| "locked"
	| "unlocked"
	| "unsupported"
	| "disabled";

export type PendingAction =
	| { type: "none" }
	| {
			type: "passphrase-setup";
			recoveryKey: string;
			resolve: (passphrase: string) => void;
			reject: (err: Error) => void;
	  }
	| {
			type: "passphrase-get";
			resolve: (passphrase: string) => void;
			reject: (err: Error) => void;
	  }
	| { type: "recovery-show"; recoveryKey: string; resolve: () => void }
	| {
			type: "recovery-get";
			resolve: (key: string) => void;
			reject: (err: Error) => void;
	  };

interface EncryptionStoreValue {
	state: EncryptionState;
	error: string | null;
	pendingAction: PendingAction;
	webauthnSupported: boolean;
}

const store = writable<EncryptionStoreValue>({
	state: "checking",
	error: null,
	pendingAction: { type: "none" },
	webauthnSupported: false,
});

let encryptedPersistence: EncryptionPersistence | null = null;
let plainPersistence: Persistence | null = null;
let initPromise: Promise<Persistence | null> | null = null;

function createPendingPromise<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export const encryptionStore = {
	subscribe: store.subscribe,

	get state(): Readable<EncryptionState> {
		return derived(store, $s => $s.state);
	},

	get pendingAction(): Readable<PendingAction> {
		return derived(store, $s => $s.pendingAction);
	},

	get webauthnSupported(): Readable<boolean> {
		return derived(store, $s => $s.webauthnSupported);
	},

	get error(): Readable<string | null> {
		return derived(store, $s => $s.error);
	},

	async initialize(enableEncryption = true): Promise<Persistence | null> {
		if (initPromise) return initPromise;

		initPromise = (async () => {
			const authClient = getAuthClient();
			const session = authClient.useSession();
			const sessionData = get(session);

			if (!sessionData.data?.user) {
				return null;
			}

			const userId = sessionData.data.user.id;
			const storage = await sqlite();

			if (!enableEncryption) {
				plainPersistence = storage;
				store.update(s => ({ ...s, state: "disabled", error: null }));
				return storage;
			}

			try {
				encryptedPersistence = await persistence.web.encryption({
					storage,
					user: userId,
					mode: "local",
					unlock: {
						webauthn: true,
						passphrase: {
							get: async () => {
								const { promise, resolve, reject } = createPendingPromise<string>();
								store.update(s => ({
									...s,
									pendingAction: { type: "passphrase-get", resolve, reject },
								}));
								try {
									return await promise;
								} finally {
									store.update(s => ({ ...s, pendingAction: { type: "none" } }));
								}
							},
							setup: async recoveryKey => {
								const showPromise = createPendingPromise<void>();
								store.update(s => ({
									...s,
									pendingAction: {
										type: "recovery-show",
										recoveryKey,
										resolve: showPromise.resolve,
									},
								}));
								await showPromise.promise;
								store.update(s => ({ ...s, pendingAction: { type: "none" } }));

								// Then get passphrase
								const { promise, resolve, reject } = createPendingPromise<string>();
								store.update(s => ({
									...s,
									pendingAction: { type: "passphrase-setup", recoveryKey, resolve, reject },
								}));
								try {
									return await promise;
								} finally {
									store.update(s => ({ ...s, pendingAction: { type: "none" } }));
								}
							},
						},
					},
					recovery: {
						onSetup: async key => {
							const { promise, resolve } = createPendingPromise<void>();
							store.update(s => ({
								...s,
								pendingAction: { type: "recovery-show", recoveryKey: key, resolve },
							}));
							await promise;
							store.update(s => ({ ...s, pendingAction: { type: "none" } }));
						},
						onRecover: async () => {
							const { promise, resolve, reject } = createPendingPromise<string>();
							store.update(s => ({
								...s,
								pendingAction: { type: "recovery-get", resolve, reject },
							}));
							try {
								return await promise;
							} finally {
								store.update(s => ({ ...s, pendingAction: { type: "none" } }));
							}
						},
					},
					lock: { idle: 15 },
					onLock: () => store.update(s => ({ ...s, state: "locked" })),
					onUnlock: () => store.update(s => ({ ...s, state: "unlocked" })),
				});

				const supported = await encryptedPersistence.isSupported();
				store.update(s => ({ ...s, webauthnSupported: supported }));

				if (!supported) {
					store.update(s => ({ ...s, state: "unsupported", error: null }));
					plainPersistence = storage;
					return storage;
				}

				store.update(s => ({ ...s, state: encryptedPersistence!.state, error: null }));

				if (encryptedPersistence.state === "unlocked") {
					setEncryptedPersistence(encryptedPersistence);
				}

				return encryptedPersistence;
			} catch (err) {
				store.update(s => ({
					...s,
					state: "locked",
					error: err instanceof Error ? err.message : "Unknown error",
				}));
				return null;
			}
		})();

		return initPromise;
	},

	async unlock(): Promise<boolean> {
		if (!encryptedPersistence) return false;
		try {
			await encryptedPersistence.unlock();
			setEncryptedPersistence(encryptedPersistence);
			store.update(s => ({ ...s, state: "unlocked", error: null }));
			return true;
		} catch (err) {
			store.update(s => ({
				...s,
				error: err instanceof Error ? err.message : "Unlock failed",
			}));
			return false;
		}
	},

	async lock(): Promise<void> {
		if (!encryptedPersistence) return;
		await encryptedPersistence.lock();
		setEncryptedPersistence(null);
		store.update(s => ({ ...s, state: "locked" }));
	},

	submitPassphrase(passphrase: string): void {
		const current = get(store);
		const { type } = current.pendingAction;
		if (type === "passphrase-get" || type === "passphrase-setup") {
			current.pendingAction.resolve(passphrase);
		}
	},

	cancelPassphrase(): void {
		const current = get(store);
		const { type } = current.pendingAction;
		if (type === "passphrase-get" || type === "passphrase-setup") {
			current.pendingAction.reject(new Error("Cancelled"));
		}
	},

	acknowledgeRecoveryKey(): void {
		const current = get(store);
		if (current.pendingAction.type === "recovery-show") {
			current.pendingAction.resolve();
		}
	},

	submitRecoveryKey(key: string): void {
		const current = get(store);
		if (current.pendingAction.type === "recovery-get") {
			current.pendingAction.resolve(key);
		}
	},

	cancelRecovery(): void {
		const current = get(store);
		if (current.pendingAction.type === "recovery-get") {
			current.pendingAction.reject(new Error("Cancelled"));
		}
	},

	getPersistence(): Persistence | null {
		return encryptedPersistence ?? plainPersistence;
	},

	reset(): void {
		encryptedPersistence = null;
		plainPersistence = null;
		initPromise = null;
		setEncryptedPersistence(null);
		store.set({
			state: "checking",
			error: null,
			pendingAction: { type: "none" },
			webauthnSupported: false,
		});
	},
};
