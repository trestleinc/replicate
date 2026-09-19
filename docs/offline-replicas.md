# Durable offline replicas

Initialize persistence and await `collection.preload()` to read local records. Local readiness does not wait for recovery, subscriptions, or credentials. Synchronization errors do not prevent offline reads.

```ts
const sqlite = await persistence.web.sqlite.create({
	name: 'records',
	assetBase: '/replicate-sqlite',
	worker: async () => {
		const { default: Worker } = await import('@trestleinc/replicate/worker?worker');
		return new Worker();
	},
});
const records = collection.create({
	schema: recordSchema,
	persistence: async () => sqlite,
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
await sqlite.close?.();
```

Disconnect does not await unresolved backend requests. Their eventual results cannot affect a later connection. It retains documents; account switching should reset or use a separate database. Reset waits for earlier local persistence work, remains disconnected, and a concurrent connect waits for reset. Recreate document handles and editing bindings after reconnect. Do not retain/mutate raw Yjs fragments across reset. The database must have a single collection owner for each collection name; concurrent independent instances sharing the same persisted collection are not supported.

Incoming raw Yjs updates are stored before application, including updates whose base has not arrived. The stream serializes pages, flushes changed documents, persists the cursor, and only then advances its subscription and reports a captured durable vector. Rows become readable once their data is durable; a canceled or failed checkpoint leaves that local data readable and eligible for replay. Failed writes keep the cursor and retry the subscription. Deletion drains writes and removes snapshots and deltas before progress advances. Recovery uses the server's existing material/view existence rules; explicit absence removes local state durably.

Insert retries preserve a single logical document ID without repeating `onInsert`. If the row already exists, the retry uses the normal update path (including `onUpdate`) so newer offline edits in its payload are synchronized.

Writable pending creations are marked durably before local insertion, retained across restart, and retried after connection. Legacy writable documents without a pending marker are preserved when the server has no history of that ID (`known: false`); this avoids discarding unsent pre-upgrade creations. Read-only replicas treat that absence as authoritative. A server tombstone/history with absent material remains authoritative for writable clients too. This is not a general persistent transaction outbox or a change to the existing writable retry/conflict model.

When the server rejects a delete, Replicate restores the row with a newer Yjs transaction that removes the deletion markers, persists the rollback before republishing the row, and records private per-document repair metadata. That metadata survives restart; the next explicit successful update or delete sends full Yjs state, then clears it. It is not an automatic retry or outbox. An awaited disconnect or reset for an account switch fences stale rollback work. A crash before the failure and rollback complete retains the existing ambiguous in-flight-write limits.

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
npm exec -- replicate-sqlite-assets public/replicate-sqlite
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

The packaged source manifest is `assets/wa-sqlite/manifest.json`; the copy command hosts it as `<assetBase>/manifest.json`. Precache the app shell, bundled worker, and **all runtime files** listed by that hosted manifest under the same base. Configure the worker's `assetBase` and the service worker's precache URLs separately; replace any hardcoded CDN URL list with the complete manifest-derived local graph. Preserve the relative `src/` and `dist/` paths and all notice files. Serve `.wasm` as `application/wasm` and JS/MJS as JavaScript. Install/activate the service worker online before the first offline restart. `preloadLinks(assetBase)` and `injectPreloadLinks(assetBase)` accept the same base. Failed WASM compilation is evicted from the cache so retry can succeed. Without `assetBase`, the existing historical CDN remains the default; copying and configuring `assetBase` is the offline self-hosted path.

The worker uses `synchronous=FULL` and awaits SQLite/VFS close before terminating. Durability is subject to browser storage eviction, device/storage guarantees, and application cache lifecycle; offline assets are application-owned.

### Runtime provenance

The copied graph comes from an immutable archive of the original wa-sqlite repository at commit `07ad48cf2f682d279f9cd69818cc1d39b2ccda86`. Its package metadata reports version 1.1.2, but the dependency is the exact commit archive rather than an npm release or a similarly named Git tag. The required files are byte-identical to that commit. The shipped module reports SQLite 3.53.0, matching its Makefile. Per-file SHA-256 values are recorded in `manifest.json`.

The codeload URL contains the full commit hash, and `manifest.json` retains the archive's SHA-512 and SHA-256 digests. npm downstream locks record the archive integrity; Bun 1.3.6 retains the exact URL without a digest. The asset CLI therefore checks fixed per-file hashes before every copy. This identifies the installed source and prebuilt artifacts; it is not an independent reproduction of the compiler environment or WebAssembly build. `node scripts/verify-sqlite-provenance.mjs` checks the archive integrity and compares every upstream file with the immutable source revision; `node scripts/copy-sqlite-assets.mjs --verify` verifies the installed dependency without network access.

Keep `LICENSE`, the full source `ACKNOWLEDGMENTS.md`, and `PROVENANCE.md`. Do not substitute npm `wa-sqlite@1.0.0`: it is an unofficial publication with different contents and VFS API.

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

The normal browser command checks candidate restart and offline behavior. To also run the
old-runtime write -> candidate reopen/write -> old-runtime reopen compatibility phases, provide
the original pinned source tree. The harness verifies every required legacy file against the
committed hash manifest before it builds the offline cache. For example, in PowerShell:

```powershell
$compatRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('replicate-sqlite-' + [guid]::NewGuid())
$archive = Join-Path $compatRoot 'wa-sqlite.tar.gz'
New-Item -ItemType Directory -Path $compatRoot | Out-Null
Invoke-WebRequest `
  -Uri 'https://codeload.github.com/rhashimoto/wa-sqlite/tar.gz/55bf0b6646ac1bb81b00b9c25636b59a87e4a918' `
  -OutFile $archive
tar -xf $archive -C $compatRoot
$legacySource = Get-ChildItem -LiteralPath $compatRoot -Directory |
  Where-Object Name -Like 'wa-sqlite-*' |
  Select-Object -First 1 -ExpandProperty FullName
$env:REPLICATE_BASELINE_SQLITE_ASSETS = $legacySource
bun run --cwd packages/replicate test:browser
```

The compatibility run must report 12 check groups. It creates the database with the legacy
runtime, reopens and writes with the candidate, then reopens with the legacy runtime and verifies
both rows, cursor 2, no network requests, and no page errors. Remove the temporary directory and
environment variable after the run.

Client tests use real SQLite files and actual collections/adapters with controlled transport. Component/server tests use convex-test, including seeded histories checked against independent source documents; they are not cloud deployment tests. The browser harness bundles package exports, precaches the actual SQLite/WASM graph, explicitly polls durable checkpoints, shuts down Chromium both with and without application cleanup, reopens the same profile offline, and verifies rows, removals, pending updates, and reset with no HTTP requests during offline phases.

The native harness bundles the **full built client entry** through Expo Metro for Android, not only the SQLite adapter. With the locked lib0 0.2.117, the stock React Native conditional export requires unavailable `isomorphic-webcrypto`. Use a targeted Metro resolver mapping `lib0/webcrypto` to lib0's `webcrypto.js`, as in the repository Expo example; retain the application's native secure `crypto.getRandomValues`/`crypto.randomUUID` setup before importing Replicate. The mapping supplies no randomness and no WebCrypto implementation. Encrypted APIs additionally require a compatible secure WebCrypto implementation. No insecure fallback or obsolete isomorphic-webcrypto dependency is added. This verifies bundling, **not native-device execution**.
