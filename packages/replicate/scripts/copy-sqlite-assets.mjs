#!/usr/bin/env node
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const packageSource = fileURLToPath(new URL('../assets/wa-sqlite/', import.meta.url));
const manifestPath = resolve(packageSource, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const require = createRequire(import.meta.url);
const dependencyManifestPath = require.resolve(`${manifest.package}/package.json`);
const dependencySource = dirname(dependencyManifestPath);
const dependencyManifest = JSON.parse(await readFile(dependencyManifestPath, 'utf8'));
if (dependencyManifest.name !== manifest.package || dependencyManifest.version !== manifest.version) {
	throw new Error(
		`Expected ${manifest.package}@${manifest.version}, found ${dependencyManifest.name}@${dependencyManifest.version}`
	);
}

const dependencyFiles = new Set(manifest.dependencyFiles);
const packageFiles = new Set(manifest.packageFiles);
for (const [file, expected] of Object.entries(manifest.sha256)) {
	const source = dependencyFiles.has(file)
		? resolve(dependencySource, file)
		: packageFiles.has(file)
			? resolve(packageSource, file)
			: undefined;
	if (!source) throw new Error(`SQLite asset has no declared source: ${file}`);
	const actual = createHash('sha256')
		.update(await readFile(source))
		.digest('hex');
	if (actual !== expected) throw new Error(`SQLite asset checksum mismatch: ${file}`);
}
if (process.argv[2] !== '--verify') {
	if (!process.argv[2])
		throw new Error('Usage: replicate-sqlite-assets <public-directory> | --verify');
	const destination = resolve(process.argv[2]);
	for (const file of Object.keys(manifest.sha256)) {
		const source = dependencyFiles.has(file)
			? resolve(dependencySource, file)
			: resolve(packageSource, file);
		const target = resolve(destination, file);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	}
	await mkdir(destination, { recursive: true });
	await copyFile(manifestPath, resolve(destination, 'manifest.json'));
}
