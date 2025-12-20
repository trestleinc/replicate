/**
 * SQLite-backed abstract-level implementation.
 *
 * Provides a LevelDB-compatible key-value store backed by SQLite,
 * enabling y-leveldb to work with SQLite databases.
 *
 * Supports both browser (sql.js WASM) and React Native (op-sqlite).
 */
import {
  AbstractLevel,
  AbstractIterator,
  AbstractKeyIterator,
  AbstractValueIterator,
} from 'abstract-level';

/**
 * Interface for SQLite database operations.
 * Abstracts over sql.js (browser) and op-sqlite (React Native).
 */
export interface SqliteAdapter {
  execute(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): void;
}

interface SqliteLevelOptions {
  /** Custom SQLite adapter (for testing or alternative backends) */
  adapter?: SqliteAdapter;
  /** Value encoding (default: 'utf8') */
  valueEncoding?: string;
  keyEncoding?: string;
}

/**
 * SQLite-backed implementation of abstract-level.
 *
 * Uses a simple key-value table with lexicographic ordering:
 * CREATE TABLE entries (key BLOB PRIMARY KEY, value BLOB)
 */
export class SqliteLevel<K = string, V = string> extends AbstractLevel<K, V> {
  private adapter: SqliteAdapter | null = null;
  private adapterFactory: (() => Promise<SqliteAdapter>) | null = null;

  constructor(_location: string, options?: SqliteLevelOptions) {
    super(
      {
        encodings: { utf8: true, buffer: true, view: true },
        seek: true,
        permanence: true,
        createIfMissing: true,
        errorIfExists: false,
        additionalMethods: {},
      },
      {
        keyEncoding: options?.keyEncoding ?? 'utf8',
        valueEncoding: options?.valueEncoding ?? 'utf8',
      }
    );

    if (options?.adapter) {
      this.adapter = options.adapter;
    }
  }

  /**
   * Set the adapter factory for deferred initialization.
   * Call this before open() to configure the SQLite backend.
   */
  setAdapterFactory(factory: () => Promise<SqliteAdapter>): void {
    this.adapterFactory = factory;
  }

  async _open(): Promise<void> {
    if (!this.adapter) {
      if (this.adapterFactory) {
        this.adapter = await this.adapterFactory();
      } else {
        throw new Error('No SQLite adapter configured. Call setAdapterFactory() before open().');
      }
    }

    // Create the entries table if it doesn't exist
    await this.adapter.execute(`
      CREATE TABLE IF NOT EXISTS entries (
        key BLOB PRIMARY KEY,
        value BLOB NOT NULL
      )
    `);

    // Create index for range queries (lexicographic ordering)
    await this.adapter.execute(`
      CREATE INDEX IF NOT EXISTS entries_key_idx ON entries (key)
    `);
  }

  async _close(): Promise<void> {
    if (this.adapter) {
      this.adapter.close();
      this.adapter = null;
    }
  }

  async _get(key: K): Promise<V | undefined> {
    if (!this.adapter) throw new Error('Database not open');

    const keyBytes = this.encodeKey(key);
    const result = await this.adapter.execute('SELECT value FROM entries WHERE key = ?', [
      keyBytes,
    ]);

    if (result.rows.length === 0) {
      return undefined;
    }

    return this.decodeValue(result.rows[0].value as Uint8Array);
  }

  async _put(key: K, value: V): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');

    const keyBytes = this.encodeKey(key);
    const valueBytes = this.encodeValue(value);

    await this.adapter.execute('INSERT OR REPLACE INTO entries (key, value) VALUES (?, ?)', [
      keyBytes,
      valueBytes,
    ]);
  }

  async _del(key: K): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');

    const keyBytes = this.encodeKey(key);
    await this.adapter.execute('DELETE FROM entries WHERE key = ?', [keyBytes]);
  }

  async _batch(
    operations: Array<{ type: 'put'; key: K; value: V } | { type: 'del'; key: K }>
  ): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');

    // Execute all operations in a transaction
    await this.adapter.execute('BEGIN TRANSACTION');

    try {
      for (const op of operations) {
        if (op.type === 'put') {
          const keyBytes = this.encodeKey(op.key);
          const valueBytes = this.encodeValue(op.value);
          await this.adapter.execute('INSERT OR REPLACE INTO entries (key, value) VALUES (?, ?)', [
            keyBytes,
            valueBytes,
          ]);
        } else if (op.type === 'del') {
          const keyBytes = this.encodeKey(op.key);
          await this.adapter.execute('DELETE FROM entries WHERE key = ?', [keyBytes]);
        }
      }
      await this.adapter.execute('COMMIT');
    } catch (error) {
      await this.adapter.execute('ROLLBACK');
      throw error;
    }
  }

  async _clear(): Promise<void> {
    if (!this.adapter) throw new Error('Database not open');
    await this.adapter.execute('DELETE FROM entries');
  }

  _iterator(options: Record<string, unknown>): AbstractIterator<typeof this, K, V> {
    if (!this.adapter) throw new Error('Database not open');
    return new SqliteIterator(this, this.adapter, options) as unknown as AbstractIterator<
      typeof this,
      K,
      V
    >;
  }

  _keys(options: Record<string, unknown>): AbstractKeyIterator<typeof this, K> {
    if (!this.adapter) throw new Error('Database not open');
    return new SqliteKeyIterator(this, this.adapter, options) as unknown as AbstractKeyIterator<
      typeof this,
      K
    >;
  }

  _values(options: Record<string, unknown>): AbstractValueIterator<typeof this, K, V> {
    if (!this.adapter) throw new Error('Database not open');
    return new SqliteValueIterator(this, this.adapter, options) as unknown as AbstractValueIterator<
      typeof this,
      K,
      V
    >;
  }

  // Helper methods for encoding/decoding
  private encodeKey(key: K): Uint8Array {
    if (key instanceof Uint8Array) {
      return key;
    }
    if (typeof key === 'string') {
      return new TextEncoder().encode(key);
    }
    return new TextEncoder().encode(String(key));
  }

  private encodeValue(value: V): Uint8Array {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (typeof value === 'string') {
      return new TextEncoder().encode(value);
    }
    return new TextEncoder().encode(JSON.stringify(value));
  }

  private decodeValue(bytes: Uint8Array): V {
    return new TextDecoder().decode(bytes) as V;
  }
}

/**
 * Iterator for key-value pairs.
 */
class SqliteIterator<K, V> extends AbstractIterator<SqliteLevel<K, V>, K, V> {
  private adapter: SqliteAdapter;
  private options: Record<string, unknown>;
  private rows: Array<{ key: Uint8Array; value: Uint8Array }> | null = null;
  private index = 0;

  constructor(db: SqliteLevel<K, V>, adapter: SqliteAdapter, options: Record<string, unknown>) {
    super(db, options);
    this.adapter = adapter;
    this.options = options;
  }

  async _next(): Promise<[K, V] | undefined> {
    if (this.rows === null) {
      await this.loadRows();
    }

    if (this.rows && this.index < this.rows.length) {
      const row = this.rows[this.index++];
      const key = new TextDecoder().decode(row.key) as K;
      const value = new TextDecoder().decode(row.value) as V;
      return [key, value];
    }

    return undefined;
  }

  async _nextv(size: number): Promise<Array<[K, V]>> {
    if (this.rows === null) {
      await this.loadRows();
    }

    const result: Array<[K, V]> = [];
    while (this.rows && this.index < this.rows.length && result.length < size) {
      const row = this.rows[this.index++];
      const key = new TextDecoder().decode(row.key) as K;
      const value = new TextDecoder().decode(row.value) as V;
      result.push([key, value]);
    }
    return result;
  }

  private async loadRows(): Promise<void> {
    const { reverse, limit, gt, gte, lt, lte } = this.options as {
      reverse?: boolean;
      limit?: number;
      gt?: K;
      gte?: K;
      lt?: K;
      lte?: K;
    };

    let sql = 'SELECT key, value FROM entries';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (gt !== undefined) {
      conditions.push('key > ?');
      params.push(this.encodeKey(gt));
    }
    if (gte !== undefined) {
      conditions.push('key >= ?');
      params.push(this.encodeKey(gte));
    }
    if (lt !== undefined) {
      conditions.push('key < ?');
      params.push(this.encodeKey(lt));
    }
    if (lte !== undefined) {
      conditions.push('key <= ?');
      params.push(this.encodeKey(lte));
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY key ${reverse ? 'DESC' : 'ASC'}`;

    if (limit !== undefined && limit >= 0) {
      sql += ` LIMIT ${limit}`;
    }

    const result = await this.adapter.execute(sql, params);
    this.rows = result.rows as Array<{ key: Uint8Array; value: Uint8Array }>;
  }

  private encodeKey(key: K): Uint8Array {
    if (key instanceof Uint8Array) {
      return key;
    }
    if (typeof key === 'string') {
      return new TextEncoder().encode(key);
    }
    return new TextEncoder().encode(String(key));
  }
}

/**
 * Iterator for keys only.
 */
class SqliteKeyIterator<K, V> extends AbstractKeyIterator<SqliteLevel<K, V>, K> {
  private adapter: SqliteAdapter;
  private options: Record<string, unknown>;
  private rows: Array<{ key: Uint8Array }> | null = null;
  private index = 0;

  constructor(db: SqliteLevel<K, V>, adapter: SqliteAdapter, options: Record<string, unknown>) {
    super(db, options);
    this.adapter = adapter;
    this.options = options;
  }

  async _next(): Promise<K | undefined> {
    if (this.rows === null) {
      await this.loadRows();
    }

    if (this.rows && this.index < this.rows.length) {
      const row = this.rows[this.index++];
      return new TextDecoder().decode(row.key) as K;
    }

    return undefined;
  }

  private async loadRows(): Promise<void> {
    const { reverse, limit } = this.options as { reverse?: boolean; limit?: number };

    let sql = 'SELECT key FROM entries';
    sql += ` ORDER BY key ${reverse ? 'DESC' : 'ASC'}`;

    if (limit !== undefined && limit >= 0) {
      sql += ` LIMIT ${limit}`;
    }

    const result = await this.adapter.execute(sql);
    this.rows = result.rows as Array<{ key: Uint8Array }>;
  }
}

/**
 * Iterator for values only.
 */
class SqliteValueIterator<K, V> extends AbstractValueIterator<SqliteLevel<K, V>, K, V> {
  private adapter: SqliteAdapter;
  private options: Record<string, unknown>;
  private rows: Array<{ value: Uint8Array }> | null = null;
  private index = 0;

  constructor(db: SqliteLevel<K, V>, adapter: SqliteAdapter, options: Record<string, unknown>) {
    super(db, options);
    this.adapter = adapter;
    this.options = options;
  }

  async _next(): Promise<V | undefined> {
    if (this.rows === null) {
      await this.loadRows();
    }

    if (this.rows && this.index < this.rows.length) {
      const row = this.rows[this.index++];
      return new TextDecoder().decode(row.value) as V;
    }

    return undefined;
  }

  private async loadRows(): Promise<void> {
    const { reverse, limit } = this.options as { reverse?: boolean; limit?: number };

    let sql = 'SELECT value FROM entries';
    sql += ` ORDER BY key ${reverse ? 'DESC' : 'ASC'}`;

    if (limit !== undefined && limit >= 0) {
      sql += ` LIMIT ${limit}`;
    }

    const result = await this.adapter.execute(sql);
    this.rows = result.rows as Array<{ value: Uint8Array }>;
  }
}
