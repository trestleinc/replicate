const KEY_PARAMS: EcKeyGenParams = {
	name: "ECDH",
	namedCurve: "P-256",
};

export interface DeviceKeyPair {
	publicKey: CryptoKey;
	privateKey: CryptoKey;
	publicKeyRaw: ArrayBuffer;
}

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
	const keyPair = await crypto.subtle.generateKey(KEY_PARAMS, true, ["deriveBits"]);

	const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);

	return {
		publicKey: keyPair.publicKey,
		privateKey: keyPair.privateKey,
		publicKeyRaw,
	};
}

export async function importPublicKey(raw: ArrayBuffer): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", raw, KEY_PARAMS, true, []);
}

export async function deriveSharedKey(
	privateKey: CryptoKey,
	publicKey: CryptoKey,
): Promise<CryptoKey> {
	const sharedBits = await crypto.subtle.deriveBits(
		{ name: "ECDH", public: publicKey },
		privateKey,
		256,
	);

	return crypto.subtle.importKey("raw", sharedBits, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

export function generateUmk(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

export function generateDocKey(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

export async function wrapKey(key: Uint8Array, wrappingKey: CryptoKey): Promise<ArrayBuffer> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		wrappingKey,
		key.buffer as ArrayBuffer,
	);

	const result = new Uint8Array(12 + encrypted.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(encrypted), 12);
	return result.buffer as ArrayBuffer;
}

export async function unwrapKey(wrapped: ArrayBuffer, wrappingKey: CryptoKey): Promise<Uint8Array> {
	const data = new Uint8Array(wrapped);
	const iv = data.slice(0, 12);
	const encrypted = data.slice(12);

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		wrappingKey,
		encrypted.buffer as ArrayBuffer,
	);

	return new Uint8Array(decrypted);
}

export async function umkToCryptoKey(umk: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", umk.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
		"encrypt",
		"decrypt",
	]);
}

export async function encryptWithKey(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		data.buffer as ArrayBuffer,
	);

	const result = new Uint8Array(12 + encrypted.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(encrypted), 12);
	return result;
}

export async function decryptWithKey(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
	const iv = data.slice(0, 12);
	const encrypted = data.slice(12);

	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv },
		key,
		encrypted.buffer as ArrayBuffer,
	);

	return new Uint8Array(decrypted);
}

export function generateDeviceId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes)
		.map(b => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function exportPrivateKey(key: CryptoKey): Promise<ArrayBuffer> {
	return crypto.subtle.exportKey("pkcs8", key);
}

export async function importPrivateKey(data: ArrayBuffer): Promise<CryptoKey> {
	return crypto.subtle.importKey("pkcs8", data, KEY_PARAMS, true, ["deriveBits"]);
}
