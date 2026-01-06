export interface PRFCredential {
	id: string;
	rawId: Uint8Array;
	salt: Uint8Array;
}

export interface PRFResult {
	credential: PRFCredential;
	key: Uint8Array;
}

const REPLICATE_RP_NAME = "Replicate Encryption";

function getRpId(): string {
	if (typeof window === "undefined") return "localhost";
	return window.location.hostname;
}

function generateSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

function generateUserId(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32));
}

export async function isPRFSupported(): Promise<boolean> {
	if (typeof window === "undefined") return false;
	if (typeof PublicKeyCredential === "undefined") return false;

	if (typeof PublicKeyCredential.getClientCapabilities === "function") {
		try {
			const caps = await PublicKeyCredential.getClientCapabilities();
			return caps["extension:prf"] === true;
		} catch {
			return false;
		}
	}

	return true;
}

export async function createPRFCredential(userName: string): Promise<PRFCredential> {
	const supported = await isPRFSupported();
	if (!supported) {
		throw new Error("WebAuthn PRF not supported");
	}

	let credential: PublicKeyCredential | null;

	try {
		credential = (await navigator.credentials.create({
			publicKey: {
				rp: {
					name: REPLICATE_RP_NAME,
					id: getRpId(),
				},
				user: {
					id: generateUserId().buffer as ArrayBuffer,
					name: userName,
					displayName: userName,
				},
				challenge: crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
				pubKeyCredParams: [
					{ alg: -7, type: "public-key" },
					{ alg: -257, type: "public-key" },
				],
				authenticatorSelection: {
					residentKey: "required",
					userVerification: "required",
				},
				extensions: { prf: {} },
			},
		})) as PublicKeyCredential | null;
	} catch (err) {
		if (err instanceof DOMException) {
			switch (err.name) {
				case "NotAllowedError":
					throw new Error("Setup cancelled or denied");
				case "SecurityError":
					throw new Error("Security error: ensure you're using HTTPS");
				case "AbortError":
					throw new Error("Setup timed out");
				case "InvalidStateError":
					throw new Error("Credential already exists for this account");
				default:
					throw new Error(`WebAuthn error: ${err.message}`);
			}
		}
		throw err;
	}

	if (!credential) {
		throw new Error("Credential creation cancelled");
	}

	const prfEnabled = (credential.getClientExtensionResults() as { prf?: { enabled?: boolean } }).prf
		?.enabled;
	if (!prfEnabled) {
		throw new Error("PRF extension not enabled - authenticator may not support PRF");
	}

	return {
		id: credential.id,
		rawId: new Uint8Array(credential.rawId),
		salt: generateSalt(),
	};
}

export async function getPRFKey(credential: PRFCredential): Promise<Uint8Array> {
	let assertion: PublicKeyCredential | null;

	try {
		assertion = (await navigator.credentials.get({
			publicKey: {
				challenge: crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer,
				allowCredentials: [
					{
						id: credential.rawId.buffer as ArrayBuffer,
						type: "public-key",
					},
				],
				extensions: {
					prf: {
						eval: { first: credential.salt.buffer as ArrayBuffer },
					},
				},
				userVerification: "required",
			},
		})) as PublicKeyCredential | null;
	} catch (err) {
		if (err instanceof DOMException) {
			switch (err.name) {
				case "NotAllowedError":
					throw new Error("Authentication cancelled or denied");
				case "SecurityError":
					throw new Error("Security error: ensure you're using HTTPS");
				case "AbortError":
					throw new Error("Authentication timed out");
				case "InvalidStateError":
					throw new Error("Authenticator not available");
				default:
					throw new Error(`WebAuthn error: ${err.message}`);
			}
		}
		throw err;
	}

	if (!assertion) {
		throw new Error("Authentication cancelled");
	}

	const prfResults = (
		assertion.getClientExtensionResults() as {
			prf?: { results?: { first?: ArrayBuffer } };
		}
	).prf?.results?.first;

	if (!prfResults) {
		throw new Error("PRF output not available - authenticator may not support PRF");
	}

	return new Uint8Array(prfResults);
}

export async function deriveEncryptionKey(prfOutput: Uint8Array, info: string): Promise<CryptoKey> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		prfOutput.buffer as ArrayBuffer,
		"HKDF",
		false,
		["deriveKey"],
	);

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(32),
			info: new TextEncoder().encode(info),
		},
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}
