const { createRequire } = require('node:module');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
	const packageRoot = path.resolve(__dirname, '..');
	const repo = path.resolve(packageRoot, '../..');
	const expoRequire = createRequire(path.join(repo, 'apps/expo/package.json'));
	const { getDefaultConfig } = expoRequire('expo/metro-config');
	const metro = createRequire(expoRequire.resolve('expo/package.json'))('metro');
	const fixture = path.join(packageRoot, 'test/native');
	const config = getDefaultConfig(path.join(repo, 'apps/expo'));
	config.projectRoot = fixture;
	config.watchFolders = [repo];
	config.resolver.nodeModulesPaths = [
		path.join(packageRoot, 'node_modules'),
		path.join(repo, 'apps/expo/node_modules'),
		path.join(repo, 'node_modules'),
		path.join(repo, 'node_modules/.bun/node_modules'),
	];
	config.resolver.extraNodeModules = { '@trestleinc/replicate': packageRoot };
	const lib0Root = path.dirname(require.resolve('lib0/package.json', { paths: [packageRoot] }));
	// lib0's RN conditional export requires obsolete isomorphic-webcrypto.
	// Use its browser entry with the application's native CSPRNG installed first.
	config.resolver.resolveRequest = (context, name, platform) => {
		if (name === 'lib0/webcrypto')
			return { type: 'sourceFile', filePath: path.join(lib0Root, 'webcrypto.js') };
		return context.resolveRequest(context, name, platform);
	};
	config.maxWorkers = 2;
	const directory = await mkdtemp(path.join(tmpdir(), 'replicate-native-'));
	try {
		const output = path.join(directory, 'android.js');
		await metro.runBuild(config, {
			entry: path.join(fixture, 'index.js'),
			platform: 'android',
			dev: false,
			minify: false,
			out: output,
		});
		const bundle = await readFile(output, 'utf8');
		assert.ok(bundle.includes('replicateNativeGraph'));
		assert.ok(bundle.includes('PersistenceProvider.storeUpdate'));
		assert.ok(!bundle.includes('wa-sqlite-async.mjs'));
		assert.ok(!bundle.includes('IDBBatchAtomicVFS.create'));
		process.stdout.write(
			'Full client graph bundled for Android without browser SQLite runtime (no device execution)\n'
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
})().catch((error) => {
	process.stderr.write(String(error) + '\n');
	process.exitCode = 1;
});
