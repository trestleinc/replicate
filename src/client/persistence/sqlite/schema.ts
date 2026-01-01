import * as Y from "yjs";
import type { Persistence, PersistenceProvider, KeyValueStore } from "../types.js";

export interface Executor {
  execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

export async function initSchema(executor: Executor): Promise<void> {
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS snapshots (
      collection TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      state_vector BLOB,
      seq INTEGER DEFAULT 0
    )
  `);

  await executor.execute(`
    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      data BLOB NOT NULL
    )
  `);

  await executor.execute(`
    CREATE INDEX IF NOT EXISTS updates_collection_idx ON updates (collection)
  `);

  await executor.execute(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

class SqliteKeyValueStore implements KeyValueStore {
  constructor(private executor: Executor) {}

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.executor.execute(
      "SELECT value FROM kv WHERE key = ?",
      [key],
    );
    if (result.rows.length === 0) return undefined;
    return JSON.parse(result.rows[0].value as string) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.executor.execute(
      "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
      [key, JSON.stringify(value)],
    );
  }

  async del(key: string): Promise<void> {
    await this.executor.execute("DELETE FROM kv WHERE key = ?", [key]);
  }
}

class SqlitePersistenceProvider implements PersistenceProvider {
  private updateHandler: (update: Uint8Array, origin: unknown) => void;
  readonly whenSynced: Promise<void>;

  constructor(
    private executor: Executor,
    private collection: string,
    private ydoc: Y.Doc,
  ) {
    this.whenSynced = this.loadState();

    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin !== "sqlite") {
        void this.saveUpdate(update);
      }
    };
    this.ydoc.on("update", this.updateHandler);
  }

  private async loadState(): Promise<void> {
    const snapshotResult = await this.executor.execute(
      "SELECT data FROM snapshots WHERE collection = ?",
      [this.collection],
    );

    if (snapshotResult.rows.length > 0) {
      const raw = snapshotResult.rows[0].data;
      const snapshotData = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      Y.applyUpdate(this.ydoc, snapshotData, "sqlite");
    }

    const updatesResult = await this.executor.execute(
      "SELECT data FROM updates WHERE collection = ? ORDER BY id ASC",
      [this.collection],
    );

    for (const row of updatesResult.rows) {
      const raw = row.data;
      const updateData = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      Y.applyUpdate(this.ydoc, updateData, "sqlite");
    }
  }

  private async saveUpdate(update: Uint8Array): Promise<void> {
    await this.executor.execute(
      "INSERT INTO updates (collection, data) VALUES (?, ?)",
      [this.collection, update],
    );
  }

  destroy(): void {
    this.ydoc.off("update", this.updateHandler);
  }
}

export function createPersistenceFromExecutor(executor: Executor): Persistence {
  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new SqlitePersistenceProvider(executor, collection, ydoc),
    kv: new SqliteKeyValueStore(executor),
  };
}
