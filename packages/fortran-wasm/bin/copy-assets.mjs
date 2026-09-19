#!/usr/bin/env node
// Copies the Fortran assets this package ships into a directory a page can fetch.
//
//   fortran-wasm-copy-assets [directory]        (default: fortran)
//
// A browser cannot read a file inside an npm package, so this is the browser half of `baseUrl`:
//
//   await createCompiler({ baseUrl: new URL('/fortran/', location.href) })
//
// The Clang half is a separate tree with its own command, and a browser needs both:
//
//   npx --package @live-codes/clang-wasm clang-wasm-copy-assets public/clang
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ASSET_RECEIPTS, ASSET_SOURCE } from '../src/asset-receipts.js';
import { PACKAGED_ROOT } from '../src/packaged.node.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(`Usage: fortran-wasm-copy-assets [directory]

Copies f2c.wasm, libf2c.a and f2c.h into <directory> (default: fortran), plus an
asset-receipts.json describing them. Serve that directory and pass its URL as baseUrl.

The Clang half of the toolchain is a separate tree:
  npx --package @live-codes/clang-wasm clang-wasm-copy-assets <directory>`);
	process.exit(0);
}

const target = resolve(argv.find((arg) => !arg.startsWith('-')) ?? 'fortran');
await mkdir(target, { recursive: true });

const written = {};
for (const [name, receipt] of Object.entries(ASSET_RECEIPTS)) {
	const bytes = await readFile(new URL(name, PACKAGED_ROOT));
	await writeFile(join(target, name), bytes);
	written[name] = { bytes: receipt.bytes, sha256: receipt.sha256 };
}

// Written next to the copy so whoever serves it can verify it at the CDN or in a build - the package
// cannot check a hosted asset it did not fetch itself.
await writeFile(
	join(target, 'asset-receipts.json'),
	`${JSON.stringify({ source: ASSET_SOURCE, assets: written }, null, 2)}\n`
);

console.log(`Fortran assets copied to ${target}`);
console.log('Serve that directory and pass its URL as baseUrl, for example:');
console.log("  await createCompiler({ baseUrl: new URL('/fortran/', location.href) })");
console.log('\nThe Clang half is separate and also required in a browser:');
console.log('  npx --package @live-codes/clang-wasm clang-wasm-copy-assets <directory>');
