# Self-Hosting wa-sqlite on Cloudflare

This guide explains how to set up your own CDN for wa-sqlite to maximize performance and reliability for your users.

## Why Self-Host?

| Benefit          | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| **Performance**  | Cloudflare's edge network (300+ locations) vs jsdelivr      |
| **Reliability**  | No dependency on third-party CDN uptime                     |
| **Control**      | Pin versions, custom cache headers, monitoring              |
| **Native users** | wa-sqlite only loaded for web, not bundled for React Native |

## Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Web App                                                     │
│    └── Web Worker                                           │
│          └── Dynamic imports from CDN                       │
│                ├── wa-sqlite-async.mjs (~15KB)             │
│                ├── IDBBatchAtomicVFS.js (~12KB)            │
│                ├── sqlite-api.js (~20KB)                   │
│                └── wa-sqlite-async.wasm (~400KB)           │
└─────────────────────────────────────────────────────────────┘
```

> **Note:** We use `IDBBatchAtomicVFS` (IndexedDB-based) instead of OPFS adapters for stability.

## Setup Options

### Option A: Cloudflare R2 (Recommended)

Best for static file hosting with global edge caching.

#### 1. Create R2 Bucket

```bash
# Using Wrangler CLI
wrangler r2 bucket create wa-sqlite-cdn
```

#### 2. Upload wa-sqlite Files

```bash
# Clone wa-sqlite and upload dist + examples
git clone https://github.com/rhashimoto/wa-sqlite.git
cd wa-sqlite

# Upload to R2 - core async build
wrangler r2 object put wa-sqlite-cdn/v1.0.0/dist/wa-sqlite-async.mjs --file=dist/wa-sqlite-async.mjs
wrangler r2 object put wa-sqlite-cdn/v1.0.0/dist/wa-sqlite-async.wasm --file=dist/wa-sqlite-async.wasm
wrangler r2 object put wa-sqlite-cdn/v1.0.0/src/sqlite-api.js --file=src/sqlite-api.js

# Upload IDBBatchAtomicVFS and its dependencies
wrangler r2 object put wa-sqlite-cdn/v1.0.0/src/examples/IDBBatchAtomicVFS.js --file=src/examples/IDBBatchAtomicVFS.js
wrangler r2 object put wa-sqlite-cdn/v1.0.0/src/FacadeVFS.js --file=src/FacadeVFS.js
wrangler r2 object put wa-sqlite-cdn/v1.0.0/src/VFS.js --file=src/VFS.js
wrangler r2 object put wa-sqlite-cdn/v1.0.0/src/WebLocksMixin.js --file=src/WebLocksMixin.js
wrangler r2 object put wa-sqlite-cdn/v1.0.0/src/sqlite-constants.js --file=src/sqlite-constants.js
```

#### 3. Configure Public Access

Create a Worker to serve R2 with proper headers:

```typescript
// workers/cdn.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // Remove leading slash

    const object = await env.WA_SQLITE_BUCKET.get(key);

    if (!object) {
      return new Response("Not Found", { status: 404 });
    }

    const headers = new Headers();

    // Set content type
    if (key.endsWith(".wasm")) {
      headers.set("Content-Type", "application/wasm");
    } else if (key.endsWith(".js") || key.endsWith(".mjs")) {
      headers.set("Content-Type", "application/javascript");
    }

    // Cache headers - immutable for versioned paths
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

    return new Response(object.body, { headers });
  },
};
```

#### 4. Deploy Worker

```toml
# wrangler.toml
name = "wa-sqlite-cdn"
main = "workers/cdn.ts"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "WA_SQLITE_BUCKET"
bucket_name = "wa-sqlite-cdn"

[routes]
pattern = "cdn.yourdomain.com/*"
```

```bash
wrangler deploy
```

### Option B: Cloudflare Workers (Proxy + Cache)

For dynamic proxying with automatic updates:

```typescript
// workers/wa-sqlite-proxy.ts
const UPSTREAM = "https://cdn.jsdelivr.net/gh/rhashimoto/wa-sqlite@master";
const CACHE_TTL = 86400 * 7; // 7 days

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upstreamUrl = `${UPSTREAM}${url.pathname}`;

    // Check cache first
    const cache = caches.default;
    let response = await cache.match(request);

    if (!response) {
      response = await fetch(upstreamUrl);

      // Clone and add cache headers
      response = new Response(response.body, response);
      response.headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
      response.headers.set("Access-Control-Allow-Origin", "*");

      // Store in cache
      await cache.put(request, response.clone());
    }

    return response;
  },
};
```

## Configuring Replicate

### Default CDN (Your Hosted)

Update the worker to use your CDN:

```typescript
// src/client/persistence/sqlite/worker.ts
const CDN_BASE = "https://wa-sqlite.robelest.com/v1.0.0";
```

### User-Configurable CDN

Allow users to override:

```typescript
// src/client/persistence/sqlite/web.ts
export interface WebSqliteOptions {
  name: string;
  worker: Worker | (() => Worker | Promise<Worker>);
  cdnBase?: string; // Optional custom CDN
}

// In worker initialization, pass cdnBase via postMessage
```

### Custom Adapter Support

For users with completely custom setups:

```typescript
// src/client/persistence/index.ts
export const persistence = {
  sqlite: {
    once: onceWebSqlitePersistence,
    create: createWebSqlitePersistence,
  },
  native: nativeSqlitePersistence,
  memory: memoryPersistence,
  custom: customPersistence, // For advanced users
};
```

## Version Management

### Pinning Strategy

```
cdn.yourdomain.com/wa-sqlite/
├── v1.0.0/          # Pinned version (immutable)
│   ├── dist/
│   └── src/
├── v1.1.0/          # New version
│   ├── dist/
│   └── src/
└── latest/          # Symlink to latest stable (for dev)
    ├── dist/
    └── src/
```

### Update Script

```bash
#!/bin/bash
# scripts/update-wa-sqlite.sh

VERSION=$1
BUCKET="wa-sqlite-cdn"

if [ -z "$VERSION" ]; then
  echo "Usage: ./update-wa-sqlite.sh <version>"
  exit 1
fi

# Clone specific tag/commit
git clone --depth 1 --branch $VERSION https://github.com/rhashimoto/wa-sqlite.git /tmp/wa-sqlite

# Upload to R2 - core async build
wrangler r2 object put $BUCKET/$VERSION/dist/wa-sqlite-async.mjs --file=/tmp/wa-sqlite/dist/wa-sqlite-async.mjs
wrangler r2 object put $BUCKET/$VERSION/dist/wa-sqlite-async.wasm --file=/tmp/wa-sqlite/dist/wa-sqlite-async.wasm
wrangler r2 object put $BUCKET/$VERSION/src/sqlite-api.js --file=/tmp/wa-sqlite/src/sqlite-api.js

# Upload IDBBatchAtomicVFS and its dependencies
wrangler r2 object put $BUCKET/$VERSION/src/examples/IDBBatchAtomicVFS.js --file=/tmp/wa-sqlite/src/examples/IDBBatchAtomicVFS.js
wrangler r2 object put $BUCKET/$VERSION/src/FacadeVFS.js --file=/tmp/wa-sqlite/src/FacadeVFS.js
wrangler r2 object put $BUCKET/$VERSION/src/VFS.js --file=/tmp/wa-sqlite/src/VFS.js
wrangler r2 object put $BUCKET/$VERSION/src/WebLocksMixin.js --file=/tmp/wa-sqlite/src/WebLocksMixin.js
wrangler r2 object put $BUCKET/$VERSION/src/sqlite-constants.js --file=/tmp/wa-sqlite/src/sqlite-constants.js

# Cleanup
rm -rf /tmp/wa-sqlite

echo "Uploaded wa-sqlite $VERSION to CDN"
```

## Performance Optimizations

### 1. Brotli Compression

Cloudflare automatically applies Brotli for supported browsers:

- `wa-sqlite-async.wasm`: 400KB → ~150KB (62% reduction)
- JS files: ~43KB → ~12KB (72% reduction)

### 2. HTTP/2 Server Push (Optional)

```typescript
// In worker, add Link headers for push
headers.set("Link", "</v1.0.0/dist/wa-sqlite-async.wasm>; rel=preload; as=fetch");
```

### 3. Edge Caching Rules

In Cloudflare Dashboard → Caching → Cache Rules:

```
Match: hostname eq "cdn.yourdomain.com" and starts_with(http.request.uri.path, "/wa-sqlite/v")
Cache TTL: 1 year (immutable versioned content)
```

## Monitoring

### R2 Analytics

View in Cloudflare Dashboard → R2 → Analytics:

- Request count by file
- Bandwidth usage
- Cache hit ratio

### Custom Logging (Optional)

```typescript
// In worker
console.log(JSON.stringify({
  timestamp: Date.now(),
  path: url.pathname,
  userAgent: request.headers.get("User-Agent"),
  country: request.cf?.country,
}));
```

View logs: `wrangler tail wa-sqlite-cdn`

## Cost Estimate

| Resource   | Free Tier    | Estimated Cost                |
| ---------- | ------------ | ----------------------------- |
| R2 Storage | 10GB         | ~$0.015/GB/month              |
| R2 Egress  | 10GB/month   | Free (no egress fees!)        |
| Workers    | 100K req/day | Free                          |
| **Total**  | -            | **~$0-5/month** for most apps |

## Checklist

- [ ] Create Cloudflare account (if needed)
- [ ] Set up R2 bucket `wa-sqlite-cdn`
- [ ] Upload wa-sqlite files with version prefix
- [ ] Deploy CDN worker with CORS + cache headers
- [ ] Configure custom domain `cdn.yourdomain.com`
- [ ] Update replicate worker.ts with new CDN_BASE
- [ ] Test in development and production
- [ ] Set up monitoring/alerts
- [ ] Document CDN URL for library users
