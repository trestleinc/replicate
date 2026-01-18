export const mockPersistence = {
	kv: {
		async get(key: string): Promise<Uint8Array | undefined> {
			throw new Error(`MockPersistence.get called: ${key}`);
		},
		async set(_key: string, _value: Uint8Array): Promise<void> {},
	},
	saveUpdate: {
		async saveUpdate(_documentId: string, _delta: Uint8Array): Promise<void> {},
	},
	loadUpdate: {
		async loadUpdate(documentId: string): Promise<Uint8Array | undefined> {
			throw new Error(`MockPersistence.loadUpdate called: ${documentId}`);
		},
	},
	close: {
		async close(): Promise<void> {},
	},
};
