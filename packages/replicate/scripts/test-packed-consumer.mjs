import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const tarballArgument = process.env.REPLICATE_PACKAGE_TARBALL;
if (!tarballArgument) {
	throw new Error('Set REPLICATE_PACKAGE_TARBALL to a packed @trestleinc/replicate tarball');
}
const tarball = isAbsolute(tarballArgument)
	? tarballArgument
	: resolve(process.cwd(), tarballArgument);
const directory = await mkdtemp(join(tmpdir(), 'replicate packed consumer '));
const consumer = join(directory, 'consumer with spaces');
const destination = join(consumer, 'public assets', 'sqlite');
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
await access(npmCli);
const npm = (args, options) => promisify(execFile)(process.execPath, [npmCli, ...args], options);

try {
	await mkdir(consumer, { recursive: true });
	await writeFile(
		join(consumer, 'package.json'),
		JSON.stringify({ name: 'replicate-packed-consumer', private: true }, null, 2)
	);
	await npm(
		[
			'install',
			'--ignore-scripts',
			'--omit=optional',
			'--no-audit',
			'--no-fund',
			tarball,
		],
		{ cwd: consumer }
	);

	const packageRoot = join(consumer, 'node_modules', '@trestleinc', 'replicate');
	const installedManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
	const packageRequire = createRequire(join(packageRoot, 'package.json'));
	const dependencyManifestPath = packageRequire.resolve('wa-sqlite/package.json');
	assert.ok(dependencyManifestPath.startsWith(directory));
	assert.equal(JSON.parse(await readFile(dependencyManifestPath, 'utf8')).version, '1.1.2');
	for (const subpath of ['.', './client', './server', './convex.config', './worker']) {
		const target = installedManifest.exports[subpath].import?.default ?? installedManifest.exports[subpath].import;
		await access(join(packageRoot, target));
	}
	for (const subpath of ['.', './client', './server', './convex.config']) {
		await access(join(packageRoot, installedManifest.exports[subpath].types));
	}

	const run = () =>
		npm(['exec', '--', 'replicate-sqlite-assets', destination], {
			cwd: consumer,
		});
	await run();
	const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
	for (const [file, expected] of Object.entries(manifest.sha256)) {
		const bytes = await readFile(join(destination, file));
		assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
	}

	await writeFile(join(destination, 'dist', 'wa-sqlite-async.wasm'), 'stale runtime');
	await writeFile(join(destination, 'consumer-owned.txt'), 'preserved');
	await run();
	assert.equal(await readFile(join(destination, 'consumer-owned.txt'), 'utf8'), 'preserved');
	assert.equal(
		createHash('sha256')
			.update(await readFile(join(destination, 'dist', 'wa-sqlite-async.wasm')))
			.digest('hex'),
		manifest.sha256['dist/wa-sqlite-async.wasm']
	);
	process.stdout.write('Packed consumer installed dependency and copied verified SQLite assets\n');
} finally {
	await rm(directory, { recursive: true, force: true });
}
