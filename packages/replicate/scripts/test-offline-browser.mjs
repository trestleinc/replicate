import { build } from 'vite';
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'replicate-browser-'));
const site = join(temp, 'site');
const profile = join(temp, 'profile');
let context;
let server;
let checks = 0;
async function waitForCursor(page, expected) {
	const deadline = Date.now() + 30000;
	while ((await page.evaluate(() => window.replica.cursor())) !== expected) {
		if (Date.now() > deadline) throw new Error(`Cursor did not reach ${expected}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
try {
	await build({
		configFile: false,
		root: resolve(root, 'test/browser'),
		logLevel: 'warn',
		build: { outDir: site, emptyOutDir: true },
	});
	const copyAssets = resolve(root, 'scripts/copy-sqlite-assets.mjs');
	await promisify(execFile)(process.execPath, [copyAssets, join(site, 'sqlite')]);
	const baselineAssets = process.env.REPLICATE_BASELINE_SQLITE_ASSETS;
	if (baselineAssets) {
		const baselineManifest = JSON.parse(
			await readFile(resolve(root, 'test/browser/baseline-wa-sqlite-manifest.json'), 'utf8')
		);
		for (const [file, expected] of Object.entries(baselineManifest.sha256)) {
			const source = resolve(baselineAssets, file);
			const bytes = await readFile(source);
			assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
			const target = join(site, 'sqlite-baseline', file);
			await mkdir(dirname(target), { recursive: true });
			await copyFile(source, target);
		}
		await writeFile(
			join(site, 'sqlite-baseline', 'manifest.json'),
			JSON.stringify(baselineManifest, null, 2)
		);
		await promisify(execFile)(process.execPath, [copyAssets, join(site, 'sqlite-candidate')]);
	}
	const paths = (await readdir(site, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map(
			(entry) =>
				'/' +
				join(entry.parentPath, entry.name)
					.slice(site.length + 1)
					.replaceAll('\\', '/')
		);
	await writeFile(
		join(site, 'sw.js'),
		`self.addEventListener('install', event => event.waitUntil(caches.open('replica-v1').then(cache => cache.addAll(${JSON.stringify(['/', ...paths])})).then(() => self.skipWaiting()))); self.addEventListener('activate', event => event.waitUntil(self.clients.claim())); self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))));`
	);
	let requests = 0;
	server = createServer(async (req, res) => {
		requests++;
		try {
			const name = req.url === '/' ? '/index.html' : new URL(req.url, 'http://local').pathname;
			const path = resolve(site, '.' + name);
			if (!path.startsWith(site)) throw new Error('Invalid path');
			const data = await readFile(path);
			res.setHeader(
				'Content-Type',
				{
					'.wasm': 'application/wasm',
					'.js': 'application/javascript',
					'.mjs': 'application/javascript',
					'.html': 'text/html',
				}[extname(path)] ?? 'application/octet-stream'
			);
			res.end(data);
		} catch {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${server.address().port}/`;
	const errors = [];
	async function launch(offline = false, fragment = '') {
		context = await chromium.launchPersistentContext(profile, { headless: true, offline });
		const page = await context.newPage();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(url + fragment);
		await page.waitForFunction(() => !!window.replica);
		await page.waitForFunction(() => !!navigator.serviceWorker.controller);
		return page;
	}
	async function restart(page, { closeApplication = false, fragment = '' } = {}) {
		if (closeApplication) await page.evaluate(() => window.replica.close());
		await context.close();
		return launch(true, fragment);
	}
	let page = await launch();
	assert.equal(await page.evaluate(() => window.replica.calls()), 0);
	checks++;
	await page.evaluate(async () => {
		await window.replica.connect();
		window.replica.emit('a', 1);
	});
	await waitForCursor(page, 1);
	checks++;
	page = await restart(page, { closeApplication: true });
	assert.equal(await page.evaluate(() => window.replica.get('a').title), 'persisted in browser');
	checks++;
	assert.equal(await page.evaluate(() => window.replica.calls()), 0);
	checks++;
	const requestCount = requests;
	await page.evaluate(async () => {
		await window.replica.connect();
		window.replica.emit('a', 2, false);
	});
	await page.waitForFunction(() => !window.replica.get('a'));
	page = await restart(page);
	assert.equal(await page.evaluate(() => window.replica.get('a')), undefined);
	checks++;
	await page.evaluate(async () => {
		await window.replica.connect();
		window.replica.emit('b', 3);
	});
	await page.waitForFunction(() => !!window.replica.get('b'));
	page = await restart(page);
	await page.evaluate(async () => {
		window.replica.absent();
		await window.replica.connect();
	});
	await page.waitForFunction(() => !window.replica.get('b'));
	page = await restart(page);
	assert.equal(await page.evaluate(() => window.replica.get('b')), undefined);
	checks++;
	const doc = new Y.Doc();
	doc.getMap('fields').set('title', 'base');
	const base = Y.encodeStateAsUpdateV2(doc);
	const vector = Y.encodeStateVector(doc);
	doc.getMap('fields').set('title', 'after restart');
	const delta = Y.encodeStateAsUpdateV2(doc, vector);
	doc.destroy();
	await page.evaluate(
		async (raw) => {
			await window.replica.connect();
			window.replica.emit('pending', 4, true, raw);
		},
		[...delta]
	);
	await waitForCursor(page, 4);
	page = await restart(page);
	await page.evaluate(
		async (raw) => {
			await window.replica.connect();
			window.replica.emit('pending', 5, true, raw);
		},
		[...base]
	);
	await page.waitForFunction(() => window.replica.get('pending')?.title === 'after restart');
	checks++;
	await page.evaluate(() => window.replica.reset());
	page = await restart(page);
	assert.equal(await page.evaluate(() => window.replica.get('pending')), undefined);
	checks++;
	assert.equal(requests, requestCount);
	assert.deepEqual(errors, []);
	checks++;
	if (baselineAssets) {
		await page.evaluate(() => window.replica.close());
		await context.close();
		const compatibilityRequests = requests;
		const database = 'runtime-compatibility';
		const oldFragment = `#assetBase=/sqlite-baseline&database=${database}`;
		const candidateFragment = `#assetBase=/sqlite-candidate&database=${database}`;
		page = await launch(true, oldFragment);
		await page.evaluate(async () => {
			await window.replica.connect();
			window.replica.emit('old-write', 1);
		});
		await waitForCursor(page, 1);
		page = await restart(page, { closeApplication: true, fragment: candidateFragment });
		assert.equal(
			await page.evaluate(() => window.replica.get('old-write')?.title),
			'persisted in browser'
		);
		checks++;
		await page.evaluate(async () => {
			await window.replica.connect();
			window.replica.emit('candidate-write', 2);
		});
		await waitForCursor(page, 2);
		page = await restart(page, { closeApplication: true, fragment: oldFragment });
		assert.equal(
			await page.evaluate(() => window.replica.get('old-write')?.title),
			'persisted in browser'
		);
		assert.equal(
			await page.evaluate(() => window.replica.get('candidate-write')?.title),
			'persisted in browser'
		);
		assert.equal(await page.evaluate(() => window.replica.cursor()), 2);
		assert.equal(requests, compatibilityRequests);
		assert.deepEqual(errors, []);
		checks++;
	}
	assert.deepEqual(await page.evaluate(() => window.replica.closeRace()), {
		acceptedCompleted: true,
		closeMessages: 1,
		lateRejected: true,
	});
	checks++;
	assert.deepEqual(errors, []);
	process.stdout.write(`${checks} real Chromium offline/process-restart checks passed\n`);
} finally {
	await context?.close();
	await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
	await rm(temp, { recursive: true, force: true });
}
