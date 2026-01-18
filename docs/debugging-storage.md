# OPFS & IndexedDB Debugging Guide for Local-First Development

## Overview

This guide provides tools, techniques, and workflows for debugging OPFS (Origin Private File System) and IndexedDB persistence in local-first CRDT sync applications using wa-sqlite.

---

## 1. Browser DevTools for OPFS

### Chrome DevTools (2025+)

**Current Status:** Chrome DevTools does NOT have native OPFS inspection UI yet.

**What's Available:**

- Storage API quota inspection: `Application > Storage > Storage Usage`
- Console API access to OPFS programmatically
- No visual file browser for OPFS (unlike IndexedDB)

**Workaround:**
Use the programmatic debugging snippets below in the Console.

### Firefox DevTools

**Current Status:** Similar to Chrome - no native OPFS UI inspector.

**What's Available:**

- Storage quota in `Storage Inspector`
- Console API access
- No visual OPFS browser

### Safari/WebKit

**Current Status:** Limited OPFS support and debugging tools.

**Recommendation:** Use Chrome or Firefox for OPFS development.

---

## 2. Browser DevTools for IndexedDB

### Chrome DevTools

**Location:** `Application > Storage > IndexedDB`

**Features:**

- ✅ View all databases and object stores
- ✅ Inspect individual records
- ✅ Delete databases/stores
- ✅ Refresh to see live updates
- ✅ Clear all storage for origin

**Limitations:**

- Cannot edit records directly
- No query interface
- Large binary data (like SQLite files) shows as `Blob` without inspection

### Firefox DevTools

**Location:** `Storage > IndexedDB`

**Features:**

- ✅ Similar to Chrome
- ✅ View databases and object stores
- ✅ Delete databases
- ✅ Inspect records

### Edge DevTools

Same as Chrome (Chromium-based).

---

## 3. Browser Extensions for Storage Debugging

### Recommended Extensions (2025)

#### 1. **IndexedDB Explorer** (Chrome/Edge)

- View/edit IndexedDB records
- Export to JSON
- Clear storage easily
- **Install:** Chrome Web Store

#### 2. **Storage Area Explorer** (Chrome/Edge)

- Multi-storage inspector (IndexedDB, localStorage, OPFS quota)
- Export/import capabilities
- **Install:** Chrome Web Store

#### 3. **Clear Cache** (Chrome/Firefox/Edge)

- Quick storage clearing
- Selective clearing (IndexedDB only, OPFS only, etc.)
- **Install:** Available on all major browsers

#### 4. **Web Developer** (Chrome/Firefox)

- Disable cache
- Clear storage
- View storage info
- **Install:** Chrome Web Store / Firefox Add-ons

### Note on OPFS Extensions

**No dedicated OPFS browser extensions exist yet** (as of 2025). Use programmatic debugging instead.

---

## 4. Programmatic OPFS Debugging

### Copy these snippets to your DevTools Console:

```javascript
// === OPFS Debugging Utilities ===

// 1. List all OPFS files
async function listOPFSFiles() {
  const root = await navigator.storage.getDirectory();
  const files = [];

  async function traverse(dir, path = '') {
    for await (const [name, handle] of dir.entries()) {
      const fullPath = path ? `${path}/${name}` : name;
      if (handle.kind === 'file') {
        const file = await handle.getFile();
        files.push({
          path: fullPath,
          size: file.size,
          modified: new Date(file.lastModified).toISOString()
        });
      } else if (handle.kind === 'directory') {
        await traverse(handle, fullPath);
      }
    }
  }

  await traverse(root);
  console.table(files);
  return files;
}

// 2. Read OPFS file contents
async function readOPFSFile(path) {
  const root = await navigator.storage.getDirectory();
  const parts = path.split('/');
  let current = root;

  for (let i = 0; i < parts.length - 1; i++) {
    current = await current.getDirectoryHandle(parts[i]);
  }

  const fileHandle = await current.getFileHandle(parts[parts.length - 1]);
  const file = await fileHandle.getFile();
  return await file.arrayBuffer();
}

// 3. Clear all OPFS data
async function clearOPFS() {
  const root = await navigator.storage.getDirectory();

  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true });
  }

  console.log('✅ OPFS cleared');
}

// 4. Get OPFS storage estimate
async function getOPFSUsage() {
  const estimate = await navigator.storage.estimate();
  const info = {
    usage: `${(estimate.usage / 1024 / 1024).toFixed(2)} MB`,
    quota: `${(estimate.quota / 1024 / 1024).toFixed(2)} MB`,
    usagePercent: ((estimate.usage / estimate.quota) * 100).toFixed(2) + '%'
  };
  console.table(info);
  return info;
}

// 5. Export OPFS file to download
async function exportOPFSFile(path, filename) {
  const data = await readOPFSFile(path);
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || path.split('/').pop();
  a.click();
  URL.revokeObjectURL(url);
  console.log(`✅ Exported ${filename || path}`);
}

// 6. Watch OPFS changes (polling)
let opfsWatcher = null;
async function watchOPFS(intervalMs = 2000) {
  if (opfsWatcher) {
    clearInterval(opfsWatcher);
    console.log('⏹️ Stopped watching OPFS');
    opfsWatcher = null;
    return;
  }

  let lastSnapshot = JSON.stringify(await listOPFSFiles());
  opfsWatcher = setInterval(async () => {
    const currentSnapshot = JSON.stringify(await listOPFSFiles());
    if (currentSnapshot !== lastSnapshot) {
      console.log('🔄 OPFS changed!');
      await listOPFSFiles();
      lastSnapshot = currentSnapshot;
    }
  }, intervalMs);
  console.log(`👀 Watching OPFS (every ${intervalMs}ms). Run watchOPFS() again to stop.`);
}

// Usage:
// await listOPFSFiles()
// await getOPFSUsage()
// await exportOPFSFile('my-db.sqlite', 'backup.sqlite')
// await clearOPFS()
// await watchOPFS(1000) // Watch every 1 second
```

---

## 5. Programmatic IndexedDB Debugging

```javascript
// === IndexedDB Debugging Utilities ===

// 1. List all IndexedDB databases
async function listIDBDatabases() {
  const dbs = await indexedDB.databases();
  console.table(dbs);
  return dbs;
}

// 2. Inspect IndexedDB database
async function inspectIDB(dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const stores = Array.from(db.objectStoreNames);
      const info = {
        name: db.name,
        version: db.version,
        objectStores: stores
      };
      db.close();
      console.log(`📊 Database: ${dbName}`, info);
      resolve(info);
    };

    request.onerror = () => reject(request.error);
  });
}

// 3. Read all records from object store
async function readIDBStore(dbName, storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = () => {
        db.close();
        console.log(`📦 Store "${storeName}" (${getAllRequest.result.length} records)`);
        console.table(getAllRequest.result.slice(0, 10)); // Show first 10
        resolve(getAllRequest.result);
      };

      getAllRequest.onerror = () => {
        db.close();
        reject(getAllRequest.error);
      };
    };

    request.onerror = () => reject(request.error);
  });
}

// 4. Clear IndexedDB database
async function clearIDB(dbName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => {
      console.log(`✅ Deleted database: ${dbName}`);
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

// 5. Export IndexedDB to JSON
async function exportIDB(dbName) {
  const info = await inspectIDB(dbName);
  const data = {};

  for (const storeName of info.objectStores) {
    data[storeName] = await readIDBStore(dbName, storeName);
  }

  const json = JSON.stringify({
    database: dbName,
    version: info.version,
    exportedAt: new Date().toISOString(),
    data
  }, null, 2);

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${dbName}-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`✅ Exported ${dbName}`);
}

// 6. Clear ALL storage for origin
async function clearAllStorage() {
  // Clear IndexedDB
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    await clearIDB(db.name);
  }

  // Clear OPFS
  await clearOPFS();

  // Clear other storage
  localStorage.clear();
  sessionStorage.clear();

  console.log('✅ All storage cleared');
}

// Usage:
// await listIDBDatabases()
// await inspectIDB('my-database')
// await readIDBStore('my-database', 'my-store')
// await exportIDB('my-database')
// await clearIDB('my-database')
// await clearAllStorage()
```

---

## 6. wa-sqlite Specific Debugging

### Inspect SQLite Database in Browser

```javascript
// === wa-sqlite Debugging ===

// 1. Dump SQLite schema
async function dumpSQLiteSchema(db, sqlite3) {
  const schema = [];
  await sqlite3.exec(db, `
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql NOT NULL
    ORDER BY type, name
  `, (row) => {
    schema.push(row);
  });
  console.table(schema);
  return schema;
}

// 2. List all tables
async function listSQLiteTables(db, sqlite3) {
  const tables = [];
  await sqlite3.exec(db, `
    SELECT name FROM sqlite_master
    WHERE type='table'
    ORDER BY name
  `, (row) => {
    tables.push(row[0]);
  });
  console.log('📋 Tables:', tables);
  return tables;
}

// 3. Count rows in all tables
async function countAllRows(db, sqlite3) {
  const tables = await listSQLiteTables(db, sqlite3);
  const counts = [];

  for (const table of tables) {
    await sqlite3.exec(db, `SELECT COUNT(*) as count FROM "${table}"`, (row) => {
      counts.push({ table, count: row[0] });
    });
  }

  console.table(counts);
  return counts;
}

// 4. Export SQLite to SQL dump
async function exportSQLiteDump(db, sqlite3, filename = 'dump.sql') {
  let dump = '';

  // Get schema
  await sqlite3.exec(db, `
    SELECT sql || ';' as stmt
    FROM sqlite_master
    WHERE sql NOT NULL
    ORDER BY type DESC, name
  `, (row) => {
    dump += row[0] + '\n\n';
  });

  // Get data
  const tables = await listSQLiteTables(db, sqlite3);
  for (const table of tables) {
    await sqlite3.exec(db, `SELECT * FROM "${table}"`, (row, columns) => {
      const values = row.map(v =>
        typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : v
      ).join(', ');
      dump += `INSERT INTO "${table}" VALUES (${values});\n`;
    });
    dump += '\n';
  }

  const blob = new Blob([dump], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`✅ Exported SQL dump: ${filename}`);
}

// 5. Check VFS in use
function checkVFS(sqlite3) {
  // This requires access to the VFS registration
  // Typically you'd check which VFS was registered
  console.log('VFS check requires access to your VFS instance');
  console.log('Check your initialization code for VFS type');
}

// Usage (assuming you have db and sqlite3 instances):
// await dumpSQLiteSchema(db, sqlite3)
// await listSQLiteTables(db, sqlite3)
// await countAllRows(db, sqlite3)
// await exportSQLiteDump(db, sqlite3, 'my-backup.sql')
```

---

## 7. Development Workflow Recommendations

### Setup: Add Debug Panel to Your App

```typescript
// Add this to your app during development
function DebugPanel() {
  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      right: 0,
      background: '#1a1a1a',
      color: '#fff',
      padding: '1rem',
      borderRadius: '8px 0 0 0',
      zIndex: 9999
    }}>
      <h3>🔧 Debug Tools</h3>
      <button onClick={() => listOPFSFiles()}>List OPFS</button>
      <button onClick={() => getOPFSUsage()}>OPFS Usage</button>
      <button onClick={() => clearOPFS()}>Clear OPFS</button>
      <button onClick={() => listIDBDatabases()}>List IDB</button>
      <button onClick={() => clearAllStorage()}>Clear All</button>
    </div>
  );
}
```

### Workflow: Debugging Persistence Issues

1. **Check storage quota:**

   ```javascript
   await getOPFSUsage()
   ```

2. **List what's stored:**

   ```javascript
   await listOPFSFiles()
   await listIDBDatabases()
   ```

3. **Export for inspection:**

   ```javascript
   await exportOPFSFile('my-db.sqlite', 'debug.sqlite')
   // Open with SQLite browser on desktop
   ```

4. **Clear and retry:**
   ```javascript
   await clearAllStorage()
   // Reload page
   ```

### Workflow: Debugging Race Conditions

1. **Add logging to VFS operations:**

   ```javascript
   // In your VFS implementation
   console.log('[VFS] xOpen:', filename);
   console.log('[VFS] xWrite:', offset, length);
   console.log('[VFS] xSync:', flags);
   ```

2. **Use Chrome DevTools Performance tab:**
   - Record while reproducing issue
   - Look for overlapping async operations
   - Check for lock contention

3. **Enable wa-sqlite debug mode:**
   ```javascript
   // Check wa-sqlite docs for debug builds
   // Use asyncify build for better stack traces
   ```

### Workflow: Comparing VFS Performance

1. **Use wa-sqlite benchmarks:**
   - Visit: https://rhashimoto.github.io/wa-sqlite/demo/benchmarks/
   - Compare OPFSCoopSyncVFS vs IDBBatchAtomicVFS
   - Test on your target browsers

2. **Add custom timing:**
   ```javascript
   console.time('sync-operation');
   await collection.insert({ ... });
   console.timeEnd('sync-operation');
   ```

---

## 8. Browser-Specific Issues

### Chrome

- **OPFS:** Best support, use OPFSCoopSyncVFS
- **Issue:** File locking can be strict
- **Fix:** Ensure proper cleanup with `close()`

### Firefox

- **OPFS:** Good support but slower than Chrome
- **Issue:** Different locking behavior
- **Fix:** Test thoroughly on Firefox

### Safari

- **OPFS:** Limited support (as of 2025)
- **Recommendation:** Use IndexedDB (IDBBatchAtomicVFS) for Safari

---

## 9. Common Issues & Solutions

### Issue: "QuotaExceededError"

**Solution:**

```javascript
// Request persistent storage
await navigator.storage.persist();

// Check quota
await getOPFSUsage();
```

### Issue: "Can't see OPFS files in DevTools"

**Solution:** This is expected. Use programmatic debugging snippets.

### Issue: "Database locked" errors

**Solution:**

- Ensure only one VFS instance per database
- Close connections properly
- Use OPFSCoopSyncVFS for better concurrency

### Issue: "Data lost after browser restart"

**Solution:**

```javascript
// Check if storage is persistent
const isPersisted = await navigator.storage.persisted();
if (!isPersisted) {
  await navigator.storage.persist();
}
```

---

## 10. Recommended Tools Stack

### For Development:

1. **Chrome DevTools** - Primary debugging
2. **OPFS/IDB snippets** - Copy to Console (see above)
3. **wa-sqlite demo** - Test VFS configurations
4. **SQLite browser** (desktop) - Inspect exported databases

### For Production Monitoring:

1. **Sentry/LogRocket** - Error tracking
2. **Custom telemetry** - Track storage usage
3. **Feature flags** - Switch VFS implementations

---

## 11. Resources

### Official Documentation:

- MDN OPFS: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- wa-sqlite: https://github.com/rhashimoto/wa-sqlite
- wa-sqlite VFS comparison: https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison

### Community:

- wa-sqlite discussions: https://github.com/rhashimoto/wa-sqlite/discussions
- wa-sqlite FAQ: https://github.com/rhashimoto/wa-sqlite/issues?q=is%3Aissue+label%3Afaq

### Tools:

- SQLite Browser (desktop): https://sqlitebrowser.org/
- Chrome DevTools docs: https://developer.chrome.com/docs/devtools/

---

## Quick Reference Card

```javascript
// === Copy this to your browser console ===

// OPFS
await listOPFSFiles()           // List all files
await getOPFSUsage()            // Check quota
await exportOPFSFile('db.sqlite', 'backup.sqlite')  // Export
await clearOPFS()               // Clear all

// IndexedDB
await listIDBDatabases()        // List databases
await inspectIDB('my-db')       // Inspect database
await exportIDB('my-db')        // Export to JSON
await clearIDB('my-db')         // Delete database

// Nuclear option
await clearAllStorage()         // Clear everything
```

---

**Last Updated:** January 2026
**Browser Compatibility:** Chrome 102+, Firefox 111+, Safari 15.2+ (limited OPFS)
