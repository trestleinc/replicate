import { browser } from "$app/environment";
import { persistence, type Persistence } from "@trestleinc/replicate/client";

// Browser-only: create the actual sqlite persistence with worker
const createBrowserSqlite = () =>
	persistence.web.sqlite.once({
		name: "replicate",
		worker: async () => {
			const { default: SqliteWorker } = await import("@trestleinc/replicate/worker?worker");
			return new SqliteWorker();
		},
	});

// SSR-safe: only initialize in browser
export const sqlite = browser
	? createBrowserSqlite()
	: () => Promise.reject(new Error("SQLite persistence is browser-only"));

let encryptedPersistenceRef: Persistence | null = null;

export function setEncryptedPersistence(p: Persistence | null): void {
	encryptedPersistenceRef = p;
}

export async function createPersistence(): Promise<Persistence> {
	if (!browser) {
		throw new Error("createPersistence() can only be called in the browser");
	}
	if (encryptedPersistenceRef) {
		return encryptedPersistenceRef;
	}
	return sqlite();
}
