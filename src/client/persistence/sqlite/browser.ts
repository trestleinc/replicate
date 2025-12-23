import { initSchema, createPersistenceFromExecutor, type Executor } from "./schema.js";
import type { Persistence } from "../types.js";

interface SqlJsDatabase {
  run(sql: string, params?: unknown): unknown;
  prepare(sql: string): {
    bind(params?: unknown): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase;
}

function hasOPFS(): boolean {
  return typeof navigator !== "undefined"
    && "storage" in navigator
    && "getDirectory" in navigator.storage;
}

async function loadFromOPFS(dbName: string): Promise<Uint8Array | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(`${dbName}.sqlite`);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }
  catch {
    return null;
  }
}

async function saveToOPFS(dbName: string, data: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(`${dbName}.sqlite`, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Uint8Array(data));
  await writable.close();
}

const IDB_STORE = "sqlite-db";

function openIDB(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`replicate-sqlite-${dbName}`, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(IDB_STORE);
    };
  });
}

async function loadFromIDB(dbName: string): Promise<Uint8Array | null> {
  try {
    const db = await openIDB(dbName);
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const request = tx.objectStore(IDB_STORE).get("data");
      request.onsuccess = () => {
        db.close();
        resolve(request.result ?? null);
      };
      request.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  }
  catch {
    return null;
  }
}

async function saveToIDB(dbName: string, data: Uint8Array): Promise<void> {
  const db = await openIDB(dbName);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const request = tx.objectStore(IDB_STORE).put(data, "data");
    request.onsuccess = () => {
      db.close();
      resolve();
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

interface StorageBackend {
  load(): Promise<Uint8Array | null>;
  save(data: Uint8Array): Promise<void>;
}

function createStorageBackend(dbName: string): StorageBackend {
  if (hasOPFS()) {
    return {
      load: () => loadFromOPFS(dbName),
      save: (data) => saveToOPFS(dbName, data),
    };
  }
  return {
    load: () => loadFromIDB(dbName),
    save: (data) => saveToIDB(dbName, data),
  };
}

class SqlJsExecutor implements Executor {
  constructor(
    private db: SqlJsDatabase,
    private storage: StorageBackend,
  ) {}

  async execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    const rows: Record<string, unknown>[] = [];
    const trimmed = sql.trim().toUpperCase();

    const isWrite = trimmed.startsWith("CREATE")
      || trimmed.startsWith("INSERT")
      || trimmed.startsWith("UPDATE")
      || trimmed.startsWith("DELETE")
      || trimmed.startsWith("BEGIN")
      || trimmed.startsWith("COMMIT")
      || trimmed.startsWith("ROLLBACK");

    if (isWrite) {
      this.db.run(sql, params);
      await this.storage.save(this.db.export());
      return { rows };
    }

    const stmt = this.db.prepare(sql);
    if (params?.length) {
      stmt.bind(params);
    }

    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();

    return { rows };
  }

  close(): void {
    this.db.close();
  }
}

export async function createBrowserSqlitePersistence(
  SQL: SqlJsStatic,
  dbName: string,
): Promise<Persistence> {
  const storage = createStorageBackend(dbName);
  const existingData = await storage.load();
  const db = existingData ? new SQL.Database(existingData) : new SQL.Database();
  const executor = new SqlJsExecutor(db, storage);

  await initSchema(executor);

  return createPersistenceFromExecutor(executor);
}
