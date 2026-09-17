// @vitest-environment node
import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

test('asset CLI installs into a new directory and refreshes assets on repeated builds', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'replicate-assets-'));
	const destination = join(directory, 'public', 'sqlite');
	const script = fileURLToPath(new URL('../../scripts/copy-sqlite-assets.mjs', import.meta.url));
	const run = () => promisify(execFile)(process.execPath, [script, destination]);
	try {
		await run();
		const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
		const verify = async () => {
			for (const [file, expected] of Object.entries(manifest.sha256)) {
				const bytes = await readFile(join(destination, file));
				expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(expected);
			}
		};
		await verify();
		await writeFile(join(destination, 'dist', 'wa-sqlite-async.wasm'), 'previous build');
		await writeFile(join(destination, 'unrelated.txt'), 'preserve');
		await run();
		await verify();
		expect(await readFile(join(destination, 'unrelated.txt'), 'utf8')).toBe('preserve');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
