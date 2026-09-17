// Read-only comparison with pinned official distribution; does not regenerate compiler output.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(
	await readFile(new URL('../assets/wa-sqlite/manifest.json', import.meta.url), 'utf8')
);
for (const [file, hash] of Object.entries(manifest.sha256)) {
	const response = await fetch(
		`https://raw.githubusercontent.com/rhashimoto/wa-sqlite/${manifest.revision}/${file}`
	);
	if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
	if (
		createHash('sha256')
			.update(new Uint8Array(await response.arrayBuffer()))
			.digest('hex') !== hash
	) {
		throw new Error(`Upstream checksum mismatch: ${file}`);
	}
}
