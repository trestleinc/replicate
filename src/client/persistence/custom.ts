import * as Y from "yjs";
import type { StorageAdapter, Persistence, PersistenceProvider, KeyValueStore } from "./types.js";

const SNAPSHOT_PREFIX = "snapshot:";
const UPDATE_PREFIX = "update:";
const META_PREFIX = "meta:";

class AdapterKeyValueStore implements KeyValueStore {
	constructor(private adapter: StorageAdapter) {}

	async get<T>(key: string): Promise<T | undefined> {
		const data = await this.adapter.get(`${META_PREFIX}${key}`);
		if (!data) return undefined;
		return JSON.parse(new TextDecoder().decode(data)) as T;
	}

	async set<T>(key: string, value: T): Promise<void> {
		await this.adapter.set(`${META_PREFIX}${key}`, new TextEncoder().encode(JSON.stringify(value)));
	}

	async del(key: string): Promise<void> {
		await this.adapter.delete(`${META_PREFIX}${key}`);
	}
}

class AdapterPersistenceProvider implements PersistenceProvider {
	private updateHandler: (update: Uint8Array, origin: unknown) => void;
	private updateCounter = 0;
	readonly whenSynced: Promise<void>;

	constructor(
		private adapter: StorageAdapter,
		private collection: string,
		private ydoc: Y.Doc,
	) {
		this.whenSynced = this.loadState();

		this.updateHandler = (update: Uint8Array, origin: unknown) => {
			if (origin !== "custom") {
				void this.saveUpdate(update);
			}
		};
		this.ydoc.on("update", this.updateHandler);
	}

	private async loadState(): Promise<void> {
		const snapshotData = await this.adapter.get(`${SNAPSHOT_PREFIX}${this.collection}`);
		if (snapshotData) {
			Y.applyUpdate(this.ydoc, snapshotData, "custom");
		}

		const updateKeys = await this.adapter.keys(`${UPDATE_PREFIX}${this.collection}:`);
		const sortedKeys = updateKeys.sort();

		for (const key of sortedKeys) {
			const updateData = await this.adapter.get(key);
			if (updateData) {
				Y.applyUpdate(this.ydoc, updateData, "custom");
				const seq = parseInt(key.split(":").pop() || "0", 10);
				if (seq > this.updateCounter) {
					this.updateCounter = seq;
				}
			}
		}
	}

	private async saveUpdate(update: Uint8Array): Promise<void> {
		this.updateCounter++;
		const paddedCounter = String(this.updateCounter).padStart(10, "0");
		await this.adapter.set(`${UPDATE_PREFIX}${this.collection}:${paddedCounter}`, update);
	}

	destroy(): void {
		this.ydoc.off("update", this.updateHandler);
	}
}

export function createCustomPersistence(adapter: StorageAdapter): Persistence {
	return {
		createDocPersistence: (collection: string, ydoc: Y.Doc) =>
			new AdapterPersistenceProvider(adapter, collection, ydoc),
		async listDocuments(prefix: string): Promise<string[]> {
			const snapshotKeys = await adapter.keys(`${SNAPSHOT_PREFIX}${prefix}:`);
			const updateKeys = await adapter.keys(`${UPDATE_PREFIX}${prefix}:`);

			const docIds = new Set<string>();

			for (const key of snapshotKeys) {
				const withoutPrefix = key.slice(SNAPSHOT_PREFIX.length);
				const parts = withoutPrefix.split(":");
				docIds.add(parts.slice(1).join(":"));
			}

			for (const key of updateKeys) {
				const withoutPrefix = key.slice(UPDATE_PREFIX.length);
				const parts = withoutPrefix.split(":");
				docIds.add(parts.slice(1, -1).join(":"));
			}

			return Array.from(docIds);
		},
		kv: new AdapterKeyValueStore(adapter),
	};
}
