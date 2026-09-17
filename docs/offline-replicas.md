# Durable offline replicas

Initialize persistence and await `collection.preload()` to read local records. Local readiness does not wait for recovery, subscriptions, or credentials. Synchronization errors do not prevent offline reads.

```ts
const records = collection.create({
	schema: recordSchema,
	persistence: sqlite,
	networkMode: 'manual',
	readOnly: true,
	requestArgs: () => ({ guestToken: currentGuestToken }),
	config: () => ({ convexClient, api: api.records, getKey: (record) => record.id }),
});
await records.init();
const local = records.get();
await local.preload(); // locally persisted rows are available, even offline
// Once the application has credentials:
await local.connect();
```

`networkMode` defaults to `'auto'`. `connect()` starts background recovery and streaming; it does not wait for server synchronization. Manual mode makes no queries, subscriptions, document mutations, or presence calls before connecting. Explicit document edits in disconnected manual mode remain local and their transaction rejects; pending creations are retained for retry after connection. Existing automatic writable behavior remains the default.

`readOnly` rejects insert/update/delete transactions and mutable prose/counter/register/set bindings. It still receives server changes and sends durable progress/presence messages. It is a client behavior option, not an authorization boundary: applications must enforce their own server write permissions.

`requestArgs` is evaluated and cloned at each connection. Its values accompany all collection transport queries, subscriptions, mutations, recovery, and presence operations. Protocol arguments (including document, vector, seq, pagination, presence, and write fields) are reserved and rejected. The application endpoints must declare and validate these additional arguments, for example through the application's existing custom-function wrapper. Stock endpoint validators do not automatically accept extra credentials. Replicate does not interpret credentials or define an authorization policy.

## Disconnect, account changes, and shutdown

```ts
await local.disconnect(); // invalidates callbacks, stops subscriptions/bindings, drains local writes
await local.reset(); // disconnects, deletes this collection's durable documents and cursor
currentGuestToken = nextCredential;
await local.connect();
// Final shutdown; a shared SQLite instance closes after all its collections:
await local.disconnect();
await local.cleanup();
await database.close();
```

Disconnect does not await unresolved backend requests. Their eventual results cannot affect a later connection. It retains documents; account switching should reset or use a separate database. Reset waits for earlier local persistence work, remains disconnected, and a concurrent connect waits for reset. Recreate document handles and editing bindings after reconnect. Do not retain/mutate raw Yjs fragments across reset. The database must have a single collection owner for each collection name; concurrent independent instances sharing the same persisted collection are not supported.

Incoming raw Yjs updates are stored before application, including updates whose base has not arrived. The stream serializes pages, flushes changed documents, persists the cursor, and only then advances its subscription and reports a captured durable vector. Rows become readable once their data is durable; a canceled or failed checkpoint leaves that local data readable and eligible for replay. Failed writes keep the cursor and retry the subscription. Deletion drains writes and removes snapshots and deltas before progress advances. Recovery uses the server's existing material/view existence rules; explicit absence removes local state durably.

Insert retries preserve a single logical document ID without repeating `onInsert`. If the row already exists, the retry uses the normal update path (including `onUpdate`) so newer offline edits in its payload are synchronized.

Writable pending creations are marked durably before local insertion, retained across restart, and retried after connection. Legacy writable documents without a pending marker are preserved when the server has no history of that ID (`known: false`); this avoids discarding unsent pre-upgrade creations. Read-only replicas treat that absence as authoritative. A server tombstone/history with absent material remains authoritative for writable clients too. This is not a general persistent transaction outbox or a change to the existing writable retry/conflict model.

## Existing component upgrade

This change targets the current v2 preview component schema (`deltas`, `snapshots`, `sequences`). Migration from the different npm 1.1.2 component is outside this patch; the archived migration documents describe earlier schemas and are not a verified stable-to-preview upgrade procedure.

Existing snapshots can share numeric sequence positions, so simply indexing them would lose records at page boundaries. New compaction assigns a unique collection sequence to every snapshot publication, in the same Convex transaction as replacement and delta removal. Stream pages merge bounded snapshot/delta ranges and advance only through emitted entries. Presence retention still uses Yjs state vectors.

After updating the component, run its `migrateSnapshots` mutation for **each existing collection**, in batches until `done` is true. Invoke it through an application **internal** administrative mutation, rather than exposing a public migration endpoint:

```ts
const result = await ctx.runMutation(components.replicate.mutations.migrateSnapshots, {
	collection: 'records',
	limit: 50,
});
// Repeat this internal operation until result.done === true.
```

Each batch atomically republishes at most 100 legacy snapshots above the highest existing snapshot, delta, or counter position. Completed rows have a marker; an interrupted operation resumes with the remaining rows and can safely be repeated. Writes and scheduled compaction may continue during migration. Streaming reports `Snapshot migration required` while any legacy snapshots remain; plan a synchronization maintenance window. Local reads and per-document recovery remain available.

Old v2 clients already understand snapshot entries and numeric cursors, so they can consume the upgraded component after migration. They retain their original local durability defects until upgraded. Mixed old/new **clients** are supported; rolling back the component schema/code while retaining publication metadata is not a supported migration path. Do not run legacy compaction code against the upgraded component.

Previously corrupt cursors above all retained server sequence evidence cannot be reconstructed. Use `reset()` for affected read-only caches after migration. Preserve/export unsent writable changes before resetting. A cursor must never be restored independently of the matching local data.

## Custom persistence

`persistence.custom.create(adapter)` implements the durable contract automatically. Direct third-party `PersistenceProvider` implementations must add:

- `flush()`: await all captured writes and propagate failures; failed writes must remain retryable.
- `storeUpdate(bytes)`: durably store a raw **Yjs V2** update, even if its dependencies are missing. The collection applies it with origin `'replicate-persisted'` afterward; do not write it twice from that event.
- `clear()`: detach observers, drain initialization/writes, and delete all durable state for the document before resolving.

The methods are optional in the TypeScript interface for source compatibility, but durable synchronization fails explicitly if a required capability is missing. The built-in SQLite, memory, custom, and encrypted providers implement them. Encrypted persistence now maintains an ID index; pre-existing encrypted documents must already be discoverable through the underlying adapter's `listDocuments()` to be recovered/indexed.

## Browser assets and offline startup

The browser worker uses **IDBBatchAtomicVFS (IndexedDB)**, not OPFS. Copy the versioned runtime included with the package into your application's public assets during its build:

```sh
replicate-sqlite-assets public/replicate-sqlite
```

Repeated builds refresh the runtime files in that directory and preserve unrelated files.

```ts
const sqlite = persistence.web.sqlite.once({
	name: 'records',
	assetBase: '/replicate-sqlite',
	worker: async () => {
		const { default: Worker } = await import('@trestleinc/replicate/worker?worker');
		return new Worker();
	},
});
```

Precache the app shell, bundled worker, and **all runtime files** listed by `assets/wa-sqlite/manifest.json` under that base. Preserve the relative `src/` and `dist/` paths and license/acknowledgment files. Serve `.wasm` as `application/wasm` and JS/MJS as JavaScript. Install/activate the service worker online before the first offline restart. `preloadLinks(assetBase)` and `injectPreloadLinks(assetBase)` accept the same base. Failed WASM compilation is evicted from the cache so retry can succeed. Without `assetBase`, the existing CDN remains the default.

The worker uses `synchronous=FULL` and awaits SQLite/VFS close before terminating. Durability is subject to browser storage eviction, device/storage guarantees, and application cache lifecycle; offline assets are application-owned.

### Runtime provenance

The vendored graph is byte-identical to official wa-sqlite GitHub commit `55bf0b6646ac1bb81b00b9c25636b59a87e4a918` (tag `v1.0.0`), including its prebuilt async JS/WASM. Those compiler artifacts originate at commit `44cc640c65f29de9bfbc2004974c9f6c2c690c2b`; its Makefile specifies SQLite 3.46.0. Per-file SHA-256 values are recorded in `manifest.json`.

This is reproducible distribution of pinned official artifacts, not a claim to reproduce the original compiler environment. `node scripts/verify-sqlite-provenance.mjs` compares every file with that immutable upstream revision; `node scripts/copy-sqlite-assets.mjs --verify` checks the installed copy without network access. Keep upstream `LICENSE` and `ACKNOWLEDGMENTS.md`, including the sqlite-wasm notice.

**Do not substitute npm `wa-sqlite@1.0.0`.** It has different source/build contents and an incompatible VFS constructor API. The pinned GitHub graph and the historical CDN use `IDBBatchAtomicVFS.create(name, module)`.

## Verification

Use Node 24 for disk tests (`node:sqlite`) and the repository's pinned Bun version to install dependencies:

```sh
bun install --frozen-lockfile
bun run build:packages
cd packages/replicate
bun run test
bun run test:assets
bunx playwright install chromium
bun run test:browser
node scripts/test-native-bundle.cjs
```

Client tests use real SQLite files and actual collections/adapters with controlled transport. Component/server tests use convex-test, including seeded histories checked against independent source documents; they are not cloud deployment tests. The browser harness bundles package exports, precaches the actual SQLite/WASM graph, explicitly polls durable checkpoints, shuts down Chromium both with and without application cleanup, reopens the same profile offline, and verifies rows, removals, pending updates, and reset with no HTTP requests during offline phases.

The native harness bundles the **full built client entry** through Expo Metro for Android, not only the SQLite adapter. With the locked lib0 0.2.117, the stock React Native conditional export requires unavailable `isomorphic-webcrypto`. Use a targeted Metro resolver mapping `lib0/webcrypto` to lib0's `webcrypto.js`, as in the repository Expo example; retain the application's native secure `crypto.getRandomValues`/`crypto.randomUUID` setup before importing Replicate. The mapping supplies no randomness and no WebCrypto implementation. Encrypted APIs additionally require a compatible secure WebCrypto implementation. No insecure fallback or obsolete isomorphic-webcrypto dependency is added. This verifies bundling, **not native-device execution**.
