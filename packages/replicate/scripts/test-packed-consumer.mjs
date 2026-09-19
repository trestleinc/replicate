import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const tarballArgument = process.env.REPLICATE_PACKAGE_TARBALL;
if (!tarballArgument) {
	throw new Error('Set REPLICATE_PACKAGE_TARBALL to a packed @trestleinc/replicate tarball');
}
const tarball = isAbsolute(tarballArgument)
	? tarballArgument
	: resolve(process.cwd(), tarballArgument);
const npmCandidates = [
	process.env.REPLICATE_NPM_CLI,
	process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : undefined,
	join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
	join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
	'/usr/local/lib/node_modules/npm/bin/npm-cli.js',
	'/usr/lib/node_modules/npm/bin/npm-cli.js',
	'/usr/share/nodejs/npm/bin/npm-cli.js',
].filter(Boolean);
let npmCli;
for (const candidate of npmCandidates) {
	try {
		await access(candidate);
		npmCli = candidate;
		break;
	} catch {
		// Try the next known npm layout.
	}
}
if (!npmCli) throw new Error('Could not locate npm-cli.js; set REPLICATE_NPM_CLI');
const npm = (args, options) => promisify(execFile)(process.execPath, [npmCli, ...args], options);

let cleanupDirectory;
try {
	cleanupDirectory = await mkdtemp(join(tmpdir(), 'replicate packed consumer '));
	const directory = await realpath(cleanupDirectory);
	const consumer = join(directory, 'consumer with spaces');
	const destination = join(consumer, 'public assets', 'sqlite');
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
			'typescript@5.9.3',
		],
		{ cwd: consumer }
	);

	const packageRoot = join(consumer, 'node_modules', '@trestleinc', 'replicate');
	const packageRequire = createRequire(join(packageRoot, 'package.json'));
	const dependencyManifestPath = packageRequire.resolve('wa-sqlite/package.json');
	assert.ok(dependencyManifestPath.startsWith(directory));
	assert.equal(JSON.parse(await readFile(dependencyManifestPath, 'utf8')).version, '1.1.2');
	const specifiers = [
		'@trestleinc/replicate',
		'@trestleinc/replicate/client',
		'@trestleinc/replicate/server',
		'@trestleinc/replicate/convex.config',
		'@trestleinc/replicate/worker',
	];
	const resolver = join(consumer, 'resolve-exports.mjs');
	await writeFile(
		resolver,
		`const specifiers = ${JSON.stringify(specifiers)};
const resolved = specifiers.map((specifier) => import.meta.resolve(specifier));
for (const specifier of specifiers.slice(0, -1)) await import(specifier);
process.stdout.write(JSON.stringify(resolved));
`
	);
	const { stdout: resolvedOutput } = await promisify(execFile)(process.execPath, [resolver], {
		cwd: consumer,
	});
	for (const url of JSON.parse(resolvedOutput)) {
		assert.ok(fileURLToPath(url).startsWith(packageRoot), url);
	}

	await writeFile(
		join(consumer, 'consumer-exports.ts'),
		`import type * as shared from '@trestleinc/replicate';
import type * as client from '@trestleinc/replicate/client';
import type * as server from '@trestleinc/replicate/server';
import type * as config from '@trestleinc/replicate/convex.config';
type ResolvedExports = [typeof shared, typeof client, typeof server, typeof config];
declare const resolvedExports: ResolvedExports;
void resolvedExports;
`
	);
	await writeFile(
		join(consumer, 'tsconfig.json'),
		JSON.stringify(
			{
				compilerOptions: {
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					noUncheckedSideEffectImports: true,
					noEmit: true,
					skipLibCheck: false,
					strict: true,
					target: 'ES2022',
				},
				files: ['consumer-exports.ts'],
			},
			null,
			2
		)
	);
	const consumerRequire = createRequire(join(consumer, 'package.json'));
	await promisify(execFile)(process.execPath, [consumerRequire.resolve('typescript/bin/tsc')], {
		cwd: consumer,
	});

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
	if (cleanupDirectory) await rm(cleanupDirectory, { recursive: true, force: true });
}
