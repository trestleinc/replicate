import * as Y from "yjs";
import type { Persistence, PersistenceProvider, KeyValueStore } from "./types.js";

export interface PGliteInterface {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

async function initSchema(pg: PGliteInterface): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      collection TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      state_vector BYTEA,
      seq INTEGER DEFAULT 0
    )
  `);

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS updates (
      id SERIAL PRIMARY KEY,
      collection TEXT NOT NULL,
      data BYTEA NOT NULL
    )
  `);

  await pg.exec(`
    CREATE INDEX IF NOT EXISTS updates_collection_idx ON updates (collection)
  `);

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

class PGliteKeyValueStore implements KeyValueStore {
  constructor(private pg: PGliteInterface) {}

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.pg.query<{ value: string }>(
      "SELECT value FROM kv WHERE key = $1",
      [key],
    );
    if (result.rows.length === 0) return undefined;
    return JSON.parse(result.rows[0].value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.pg.query(
      `INSERT INTO kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, JSON.stringify(value)],
    );
  }

  async del(key: string): Promise<void> {
    await this.pg.query("DELETE FROM kv WHERE key = $1", [key]);
  }
}

class PGlitePersistenceProvider implements PersistenceProvider {
  private updateHandler: (update: Uint8Array, origin: unknown) => void;
  readonly whenSynced: Promise<void>;

  constructor(
    private pg: PGliteInterface,
    private collection: string,
    private ydoc: Y.Doc,
  ) {
    this.whenSynced = this.loadState();

    this.updateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin !== "pglite") {
        void this.saveUpdate(update);
      }
    };
    this.ydoc.on("update", this.updateHandler);
  }

  private async loadState(): Promise<void> {
    const snapshotResult = await this.pg.query<{ data: Uint8Array }>(
      "SELECT data FROM snapshots WHERE collection = $1",
      [this.collection],
    );

    if (snapshotResult.rows.length > 0) {
      const raw = snapshotResult.rows[0].data;
      const snapshotData = raw instanceof Uint8Array
        ? raw
        : new Uint8Array(raw as ArrayBuffer);
      Y.applyUpdate(this.ydoc, snapshotData, "pglite");
    }

    const updatesResult = await this.pg.query<{ data: Uint8Array }>(
      "SELECT data FROM updates WHERE collection = $1 ORDER BY id ASC",
      [this.collection],
    );

    for (const row of updatesResult.rows) {
      const raw = row.data;
      const updateData = raw instanceof Uint8Array
        ? raw
        : new Uint8Array(raw as ArrayBuffer);
      Y.applyUpdate(this.ydoc, updateData, "pglite");
    }
  }

  private async saveUpdate(update: Uint8Array): Promise<void> {
    await this.pg.query(
      "INSERT INTO updates (collection, data) VALUES ($1, $2)",
      [this.collection, update],
    );
  }

  destroy(): void {
    this.ydoc.off("update", this.updateHandler);
  }
}

export async function createPGlitePersistence(
  pg: PGliteInterface,
): Promise<Persistence> {
  await initSchema(pg);
  return {
    createDocPersistence: (collection: string, ydoc: Y.Doc) =>
      new PGlitePersistenceProvider(pg, collection, ydoc),
    kv: new PGliteKeyValueStore(pg),
  };
}

/**
 * Creates a singleton PGlite persistence factory.
 * Use this to ensure the PGlite WASM module is only loaded once,
 * even when shared across multiple collections.
 *
 * @example
 * ```typescript
 * // src/lib/pglite.ts
 * import { persistence } from "@trestleinc/replicate/client";
 *
 * export const pglite = persistence.pglite.once(async () => {
 *   const { PGlite } = await import("@electric-sql/pglite");
 *   const { live } = await import("@electric-sql/pglite/live");
 *   return PGlite.create({ dataDir: "idb://app", extensions: { live } });
 * });
 *
 * // src/collections/useIntervals.ts
 * import { pglite } from "$lib/pglite";
 *
 * export const intervals = collection.create({
 *   persistence: pglite,
 *   config: () => ({ ... }),
 * });
 * ```
 */
export function oncePGlitePersistence(
  factory: () => Promise<PGliteInterface>,
): () => Promise<Persistence> {
  let instance: Promise<Persistence> | null = null;
  return () => (instance ??= factory().then(createPGlitePersistence));
}
