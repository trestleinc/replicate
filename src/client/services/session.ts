import type { KeyValueStore } from "$/client/persistence/types";

const SESSION_CLIENT_ID_KEY = "replicate:sessionClientId";

let cachedSessionClientId: string | null = null;

function generateSessionClientId(): string {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	return String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
}

export async function getClientId(kv: KeyValueStore): Promise<string> {
	if (cachedSessionClientId) {
		return cachedSessionClientId;
	}

	const stored = await kv.get<string>(SESSION_CLIENT_ID_KEY);
	if (stored) {
		cachedSessionClientId = stored;
		return stored;
	}

	const newId = generateSessionClientId();
	cachedSessionClientId = newId;
	await kv.set(SESSION_CLIENT_ID_KEY, newId);

	return newId;
}
