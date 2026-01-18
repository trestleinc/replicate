const IV_LENGTH = 12;
const SALT_LENGTH = 16;

export async function deriveKeyFromPassphrase(
	passphrase: string,
	salt: Uint8Array,
): Promise<CryptoKey> {
	const encoder = new TextEncoder();
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		encoder.encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"],
	);

	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: salt.buffer as ArrayBuffer,
			iterations: 100000,
			hash: "SHA-256",
		},
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		data.buffer as ArrayBuffer,
	);

	const result = new Uint8Array(IV_LENGTH + encrypted.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(encrypted), IV_LENGTH);
	return result;
}

export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
	const iv = data.slice(0, IV_LENGTH);
	const encrypted = data.slice(IV_LENGTH);

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		encrypted.buffer as ArrayBuffer,
	);
	return new Uint8Array(decrypted);
}

export function generateSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

export function generateRecoveryKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	let result = "";
	for (let i = 0; i < bytes.length; i++) {
		if (i > 0 && i % 4 === 0) result += "-";
		result += chars[bytes[i] % chars.length];
	}
	return result;
}

export async function hashRecoveryKey(recoveryKey: string): Promise<Uint8Array> {
	const normalized = recoveryKey.replace(/-/g, "").toUpperCase();
	const encoded = new TextEncoder().encode(normalized);
	const hash = await crypto.subtle.digest("SHA-256", encoded);
	return new Uint8Array(hash);
}
