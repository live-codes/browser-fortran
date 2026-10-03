// Turns the container's output into the assets a package would actually ship.
//
//   node make-assets.mjs
//
// The raw wasm is 70.75 MiB, which is past what a CDN will serve for a package file (jsDelivr's
// largest file for our clang-wasm package is 15.0 MiB, of a 28.5 MiB total). gzip brings it to
// 19.04 MiB, which fits, and `DecompressionStream('gzip')` means the loader can decompress it
// in-browser with no dependency — the same trick clang-wasm uses to ship `clang.wasm.gz`.
//
// brotli is smaller (12.90 MiB) but browsers cannot decompress it from script: DecompressionStream
// supports only gzip/deflate. It is reported for reference, not written.
import { readFile, writeFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;

const wasm = await readFile(join(OUT, 'wasm_run.wasm'));
const gzipped = gzipSync(wasm, { level: 9 });
await writeFile(join(OUT, 'wasm_run.wasm.gz'), gzipped);

console.log(`wasm_run.wasm     ${mib(wasm.length)}`);
console.log(`wasm_run.wasm.gz  ${mib(gzipped.length)}  <- written`);
console.log(`  (brotli would be ${mib(brotliCompressSync(wasm).length)}, but not script-decompressible)`);

// The preloaded runtime .mod files stay uncompressed: they are 178 KiB, and emscripten fetches the
// .data itself.
const data = await readFile(join(OUT, 'wasm_run.data'));
console.log(`wasm_run.data     ${mib(data.length)}  <- served as-is`);
