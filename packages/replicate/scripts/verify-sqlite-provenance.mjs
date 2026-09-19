// Read-only comparison with the pinned original source; does not regenerate compiler output.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(
	await readFile(new URL('../assets/wa-sqlite/manifest.json', import.meta.url), 'utf8')
);
const archiveResponse = await fetch(manifest.archive);
if (!archiveResponse.ok) throw new Error(`source archive: HTTP ${archiveResponse.status}`);
const archive = new Uint8Array(await archiveResponse.arrayBuffer());
const archiveSha512 = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
if (archiveSha512 !== manifest.archiveIntegrity) throw new Error('source archive integrity mismatch');
if (createHash('sha256').update(archive).digest('hex') !== manifest.archiveSha256) {
	throw new Error('source archive SHA-256 mismatch');
}

for (const file of manifest.dependencyFiles) {
	const response = await fetch(
		`${manifest.repository.replace('github.com', 'raw.githubusercontent.com')}/${manifest.revision}/${file}`
	);
	if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
	const hash = manifest.sha256[file];
	if (
		createHash('sha256')
			.update(new Uint8Array(await response.arrayBuffer()))
			.digest('hex') !== hash
	) {
		throw new Error(`Upstream checksum mismatch: ${file}`);
	}
}
