import "@testing-library/jest-dom/vitest";

if (typeof globalThis.crypto === "undefined") {
	globalThis.crypto = {
		getRandomValues: (arr: Uint8Array): Uint8Array => {
			for (let i = 0; i < arr.length; i++) {
				arr[i] = Math.floor(Math.random() * 256);
			}
			return arr;
		},
		randomUUID: (): string => {
			return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
				const r = (Math.random() * 16) | 0;
				const v = c === "x" ? r : (r & 0x3) | 0x8;
				return v.toString(16);
			});
		},
	};
}

if (typeof globalThis.navigator?.storage === "undefined") {
	Object.defineProperty(navigator, "storage", {
		value: {
			estimate: async () => ({ usage: 0, quota: 100_000_000 }),
		},
		writable: false,
	});
}
