#!/usr/bin/env node
// Vendors the built LFortran wasm module into this package's assets/.
//
//   node bin/copy-assets.mjs [sourceDir]
//
// `sourceDir` defaults to docker/lfortran-wasm/out in this repository, which is where the build
// container writes its output. The raw wasm is never copied: it is 70.75 MiB, past what a CDN will
// serve for a package file, so this gzips it to 19.04 MiB and the loader decompresses it in the
// client with DecompressionStream. See src/index.js for why gzip rather than brotli.
//
// The three artifacts come from one another, so they must come from a single build:
//   wasm_run.js      the emscripten ES module glue (EXPORT_ES6=1)
//   wasm_run.wasm.gz the compiler and the LLVM backend it carries
//   wasm_run.data    the runtime .mod files, preloaded into the wasm filesystem at /lib
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_SOURCE = fileURLToPath(new URL('../../../docker/lfortran-wasm/out/', import.meta.url));
const sourceDir = process.argv[2] ? process.argv[2] : DEFAULT_SOURCE;
const assetsDir = join(PACKAGE_DIR, 'assets');

const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;

async function requireFile(name) {
	const path = join(sourceDir, name);
	try {
		await stat(path);
	} catch {
		throw new Error(
			`${path} is missing. Build it first:\n` +
				'  docker build -t lfortran-wasm-build docker/lfortran-wasm\n' +
				'  docker run -d --name lfortran-wasm-run lfortran-wasm-build\n' +
				'  docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.js docker/lfortran-wasm/out/\n' +
				'  docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.wasm docker/lfortran-wasm/out/\n' +
				'  docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.data docker/lfortran-wasm/out/',
		);
	}
	return path;
}

await mkdir(assetsDir, { recursive: true });

// Copied or generated, then verified by reading each one back.
const writes = [
	{ name: 'wasm_run.js', from: await requireFile('wasm_run.js') },
	{ name: 'wasm_run.data', from: await requireFile('wasm_run.data') },
];

const rawWasm = await readFile(await requireFile('wasm_run.wasm'));
const gzipped = gzipSync(rawWasm, { level: 9 });
await writeFile(join(assetsDir, 'wasm_run.wasm.gz'), gzipped);

for (const asset of writes) {
	await copyFile(asset.from, join(assetsDir, asset.name));
}

let total = 0;
console.log(`vendored into ${assetsDir}\n`);
for (const name of ['wasm_run.js', 'wasm_run.wasm.gz', 'wasm_run.data']) {
	const bytes = await readFile(join(assetsDir, name));
	const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
	total += bytes.length;
	const note = name === 'wasm_run.wasm.gz' ? `  (from ${mib(rawWasm.length)} raw)` : '';
	console.log(`  ${name.padEnd(20)} ${mib(bytes.length).padStart(9)}  sha256:${digest}${note}`);
}
console.log(`  ${'total'.padEnd(20)} ${mib(total).padStart(9)}`);
