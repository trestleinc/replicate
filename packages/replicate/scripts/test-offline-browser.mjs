import { build } from 'vite';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
	await cp(resolve(root, 'assets/wa-sqlite'), join(site, 'sqlite'), { recursive: true });
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
	async function launch(offline = false) {
		context = await chromium.launchPersistentContext(profile, { headless: true, offline });
		const page = await context.newPage();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(url);
		await page.waitForFunction(() => !!window.replica);
		await page.waitForFunction(() => !!navigator.serviceWorker.controller);
		return page;
	}
	async function restart(page, { closeApplication = false } = {}) {
		if (closeApplication) await page.evaluate(() => window.replica.close());
		await context.close();
		return launch(true);
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
	await page.evaluate(() => window.replica.close());
	process.stdout.write(`${checks} real Chromium offline/process-restart checks passed\n`);
} finally {
	await context?.close();
	await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
	await rm(temp, { recursive: true, force: true });
}
