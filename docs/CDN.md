# Hosting the browser SQLite runtime

Replicate's browser persistence uses wa-sqlite with `IDBBatchAtomicVFS` (IndexedDB). Replicate
installs an immutable archive of the original repository at commit
`07ad48cf2f682d279f9cd69818cc1d39b2ccda86`. Its asset CLI copies the compatible
JavaScript/WASM graph, verifies fixed checksums, and retains the upstream license,
acknowledgments, and provenance note. Serve that graph from your application or an immutable CDN
path. Do not assemble files from a moving branch or substitute npm `wa-sqlite@1.0.0`, an
unofficial publication with a different VFS API.

## Copy and verify the packaged graph

Run the package CLI during the application build:

```bash
npm exec -- replicate-sqlite-assets public/replicate-sqlite
```

The command verifies every source file against `manifest.json` before copying. The destination
contains the complete required layout:

```text
replicate-sqlite/
├── dist/
│   ├── wa-sqlite-async.mjs
│   └── wa-sqlite-async.wasm
├── src/
│   ├── examples/IDBBatchAtomicVFS.js
│   ├── FacadeVFS.js
│   ├── VFS.js
│   ├── WebLocksMixin.js
│   ├── sqlite-api.js
│   └── sqlite-constants.js
├── manifest.json
├── LICENSE
└── ACKNOWLEDGMENTS.md
```

The copied directory also contains `PROVENANCE.md`. Keep the relative `dist/` and `src/` paths
intact and retain all three notice files in every hosted distribution. To verify the installed
package without copying it, run:

```bash
npm exec -- replicate-sqlite-assets --verify
```

`manifest.json` records the exact archive URL and integrity, source revision, and SHA-256 digest
of each runtime and notice file. The copy command reads the installed dependency during the
application build; browsers do not fetch GitHub or a third-party CDN at runtime when `assetBase`
points to the copied directory. The provenance details and reproducibility boundary are documented
in [`offline-replicas.md`](offline-replicas.md#browser-assets-and-offline-startup).

## Configure Replicate

Point `assetBase` at the directory containing `dist/`, `src/`, and the manifest:

```typescript
import { persistence } from '@trestleinc/replicate/client';
import SqliteWorker from '@trestleinc/replicate/worker?worker';

const sqlite = persistence.web.sqlite.once({
	name: 'myapp',
	assetBase: '/replicate-sqlite',
	worker: () => new SqliteWorker(),
});
```

`assetBase` may also be an absolute, versioned URL:

```typescript
assetBase: 'https://assets.example.com/replicate-sqlite/2.0.0-preview.0';
```

The host must serve `.wasm` as `application/wasm` and `.js`/`.mjs` as JavaScript. If the asset
origin differs from the application origin, enable CORS for the application. Versioned paths can
use long-lived immutable caching:

```http
Cache-Control: public, max-age=31536000, immutable
Access-Control-Allow-Origin: https://app.example.com
```

Avoid a CDN proxy to a moving branch such as `@master`. To upgrade, update the Replicate package,
run the copy command again, upload the complete output to a new immutable path, and then change
`assetBase`. Keeping the previous path available lets already deployed clients finish loading the
runtime version they were built against.

## Offline startup

An offline restart needs the application shell, bundled worker, and every runtime file named in
`manifest.json` to be available locally. Precache those URLs while online and activate the service
worker before relying on offline startup. The preload helpers accept the same base:

```typescript
import { injectPreloadLinks } from '@trestleinc/replicate/client';

injectPreloadLinks('/replicate-sqlite');
```

Verify the production build with the network disabled after a full browser process shutdown. A
warm module in an open tab does not prove that the JavaScript/WASM graph is available offline.

## Cloudflare R2 example

Create a versioned prefix such as `replicate-sqlite/2.0.0-preview.0/`, then upload the **entire**
copied directory, including the manifest and notice files. An R2-backed Worker can serve objects
with the content types and immutable headers above:

```typescript
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const key = url.pathname.slice(1);
		const object = await env.RUNTIME_BUCKET.get(key);
		if (!object) return new Response('Not Found', { status: 404 });

		const headers = new Headers();
		const contentType = key.endsWith('.wasm')
			? 'application/wasm'
			: key.endsWith('.json')
				? 'application/json'
				: key.endsWith('.md') || key.endsWith('/LICENSE')
					? 'text/plain; charset=utf-8'
					: 'application/javascript';
		headers.set('Content-Type', contentType);
		headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		headers.set('Access-Control-Allow-Origin', 'https://app.example.com');
		return new Response(object.body, { headers });
	},
};
```

Do not mutate objects under an existing versioned prefix.
