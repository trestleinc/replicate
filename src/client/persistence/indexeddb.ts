import * as Y from "yjs";
import type { Persistence, PersistenceProvider, KeyValueStore } from "./types.js";

const UPDATES_STORE = "updates";
const SNAPSHOTS_STORE = "snapshots";
const KV_STORE = "kv";

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`replicate-${dbName}`, 1);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(SNAPSHOTS_STORE);
      db.createObjectStore(KV_STORE);
      const updatesStore = db.createObjectStore(UPDATES_STORE, { autoIncrement: true });
      updatesStore.createIndex("by_collection", "collection", { unique: false });
    };
  });
}

class IDBKeyValueStore implements KeyValueStore {
  constructor(private db: IDBDatabase) {}

  get<T>(key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, "readonly");
      const store = tx.objectStore(KV_STORE);
      const request = store.get(key);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB get failed"));
      request.onsuccess = () => resolve(request.result as T | undefined);
    });
  }

  set<T>(key: string, value: T): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, "readwrite");
      const store = tx.objectStore(KV_STORE);
      const request = store.put(value, key);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB set failed"));
      request.onsuccess = () => resolve();
    });
  }

  del(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV_STORE, "readwrite");
      const store = tx.objectStore(KV_STORE);
      const request = store.delete(key);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
      request.onsuccess = () => resolve();
    });
  }
}

class IDBPersistenceProvider implements PersistenceProvider {
  private updateHandler: (update: Uint8Array, origin: unknown) => void;
  readonly whenSynced: Promise<void>;

  constructor(
    private db: IDBDatabase,
    private collection: string,
    private ydoc: Y.Doc,
  ) {
    this.whenSynced = this.loadState();

    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin !== "idb") {
        void this.saveUpdate(update);
      }
    };
    this.ydoc.on("update", this.updateHandler);
  }

  private loadState(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([SNAPSHOTS_STORE, UPDATES_STORE], "readonly");

      const snapshotStore = tx.objectStore(SNAPSHOTS_STORE);
      const snapshotRequest = snapshotStore.get(this.collection);

      snapshotRequest.onsuccess = () => {
        if (snapshotRequest.result) {
          Y.applyUpdate(this.ydoc, snapshotRequest.result, "idb");
        }

        const updatesStore = tx.objectStore(UPDATES_STORE);
        const index = updatesStore.index("by_collection");
        const updatesRequest = index.getAll(this.collection);

        updatesRequest.onsuccess = () => {
          const records = updatesRequest.result as { collection: string; data: Uint8Array }[];
          for (const record of records) {
            Y.applyUpdate(this.ydoc, record.data, "idb");
          }
          resolve();
        };

        updatesRequest.onerror = () =>
          reject(updatesRequest.error ?? new Error("IndexedDB updates load failed"));
      };

      snapshotRequest.onerror = () =>
        reject(snapshotRequest.error ?? new Error("IndexedDB snapshot load failed"));
    });
  }

  private saveUpdate(update: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(UPDATES_STORE, "readwrite");
      const store = tx.objectStore(UPDATES_STORE);
      const request = store.add({ collection: this.collection, data: update });
      request.onerror = () => reject(request.error ?? new Error("IndexedDB save update failed"));
      request.onsuccess = () => resolve();
    });
  }

  destroy(): void {
    this.ydoc.off("update", this.updateHandler);
  }
}

export async function createIndexedDBPersistence(dbName: string): Promise<Persistence> {
  const db = await openDatabase(dbName);
  const kv = new IDBKeyValueStore(db);

  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new IDBPersistenceProvider(db, collection, ydoc),
    kv,
  };
}
