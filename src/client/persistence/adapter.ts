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
    const text = new TextDecoder().decode(data);
    return JSON.parse(text) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const text = JSON.stringify(value);
    const data = new TextEncoder().encode(text);
    await this.adapter.set(`${META_PREFIX}${key}`, data);
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
      if (origin !== "adapter") {
        void this.saveUpdate(update);
      }
    };
    this.ydoc.on("update", this.updateHandler);
  }

  private async loadState(): Promise<void> {
    const snapshotData = await this.adapter.get(`${SNAPSHOT_PREFIX}${this.collection}`);
    if (snapshotData) {
      Y.applyUpdate(this.ydoc, snapshotData, "adapter");
    }

    const updateKeys = await this.adapter.keys(`${UPDATE_PREFIX}${this.collection}:`);
    const sortedKeys = updateKeys.sort();

    for (const key of sortedKeys) {
      const updateData = await this.adapter.get(key);
      if (updateData) {
        Y.applyUpdate(this.ydoc, updateData, "adapter");
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
    const key = `${UPDATE_PREFIX}${this.collection}:${paddedCounter}`;
    await this.adapter.set(key, update);
  }

  async compact(): Promise<void> {
    const snapshot = Y.encodeStateAsUpdate(this.ydoc);
    await this.adapter.set(`${SNAPSHOT_PREFIX}${this.collection}`, snapshot);

    const updateKeys = await this.adapter.keys(`${UPDATE_PREFIX}${this.collection}:`);
    for (const key of updateKeys) {
      await this.adapter.delete(key);
    }
    this.updateCounter = 0;
  }

  getStateVector(): Uint8Array {
    return Y.encodeStateVector(this.ydoc);
  }

  getFullState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  destroy(): void {
    this.ydoc.off("update", this.updateHandler);
  }
}

export function createPersistence(adapter: StorageAdapter): Persistence {
  const kv = new AdapterKeyValueStore(adapter);

  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new AdapterPersistenceProvider(adapter, collection, ydoc),
    kv,
  };
}
