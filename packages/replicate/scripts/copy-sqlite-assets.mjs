#!/usr/bin/env node
import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const source = fileURLToPath(new URL('../assets/wa-sqlite/', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
for (const [file, expected] of Object.entries(manifest.sha256)) {
	const actual = createHash('sha256')
		.update(await readFile(resolve(source, file)))
		.digest('hex');
	if (actual !== expected) throw new Error(`SQLite asset checksum mismatch: ${file}`);
}
if (process.argv[2] !== '--verify') {
	if (!process.argv[2])
		throw new Error('Usage: replicate-sqlite-assets <public-directory> | --verify');
	const destination = resolve(process.argv[2]);
	await cp(source, destination, { recursive: true });
}
