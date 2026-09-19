// Vendors the three wasm-side Fortran assets into `assets/`.
//
//   npm run fetch:assets
//
// The Clang half of this toolchain is not fetched here: it belongs to `@live-codes/clang-wasm`, which
// ships and pins its own. What is fetched is the Fortran half - `f2c` and the `libf2c` runtime - as
// built for wasm32-wasi by the `seo-rii/wasm-llvm` producer and published on a mirror.
//
// There is no source build to run, so the guarantee is the receipt: everything is checked against
// `src/asset-receipts.js` before it is written, and the inflated bytes are what lands in `assets/`,
// because that is what the compiler reads. The mirror publishes the two binaries gzipped under a
// `.gz` suffix, and `f2c.h` plain; a mirror that serves either form works.
import { mkdir, writeFile } from 'node:fs/promises';
import { ASSET_RECEIPTS, ASSET_SOURCE } from '../src/asset-receipts.js';

const OUT = new URL('../assets/', import.meta.url);
await mkdir(OUT, { recursive: true });

async function fetchAsset(name, receipt) {
	for (const candidate of [name, `${name}.gz`]) {
		const url = `${ASSET_SOURCE.mirror}${candidate}?v=${ASSET_SOURCE.version}`;
		const response = await fetch(url);
		if (!response.ok) continue;

		const raw = new Uint8Array(await response.arrayBuffer());
		const bytes = isGzip(raw) ? await inflateGzip(raw, candidate) : raw;

		if (bytes.byteLength !== receipt.bytes) {
			throw new Error(
				`${candidate} inflates to ${bytes.byteLength} bytes, expected ${receipt.bytes}`
			);
		}
		const digest = await sha256Hex(bytes);
		if (digest !== receipt.sha256) {
			throw new Error(`${candidate} failed SHA-256 verification: expected ${receipt.sha256}`);
		}
		return bytes;
	}
	throw new Error(`No copy of ${name} at ${ASSET_SOURCE.mirror}`);
}

const isGzip = (bytes) => bytes.byteLength > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

async function inflateGzip(bytes, label) {
	if (typeof DecompressionStream !== 'function') {
		throw new Error(`Inflating ${label} needs DecompressionStream (Node 18 and later)`);
	}
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes) {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

let total = 0;
for (const [name, receipt] of Object.entries(ASSET_RECEIPTS)) {
	const bytes = await fetchAsset(name, receipt);
	await writeFile(new URL(name, OUT), bytes);
	total += bytes.byteLength;
	console.log(`${name.padEnd(12)} ${String(bytes.byteLength).padStart(9)} bytes  ${receipt.sha256.slice(0, 16)}…  verified`);
}
console.log(`\nassets/ now holds ${total} bytes, all matching their receipts.`);
