// Reports what the built artifacts cost, and what the module imports.
//
//   node inspect-wasm.mjs
//
// The raw sizes are not what a browser downloads: jsDelivr and friends serve gzip or brotli, so the
// compressed numbers are the ones that matter for deciding whether this can ship.
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const ARTIFACTS = ['wasm_run.js', 'wasm_run.wasm', 'wasm_run.data'];

const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;

console.log('artifact            raw        gzip       brotli');
let rawTotal = 0;
let gzipTotal = 0;
let brotliTotal = 0;
for (const name of ARTIFACTS) {
	const bytes = await readFile(join(OUT, name));
	const gzip = gzipSync(bytes, { level: 9 }).length;
	const brotli = brotliCompressSync(bytes).length;
	rawTotal += bytes.length;
	gzipTotal += gzip;
	brotliTotal += brotli;
	console.log(
		`${name.padEnd(18)}${mib(bytes.length).padEnd(11)}${mib(gzip).padEnd(11)}${mib(brotli)}`,
	);
}
console.log(
	`${'total'.padEnd(18)}${mib(rawTotal).padEnd(11)}${mib(gzipTotal).padEnd(11)}${mib(brotliTotal)}`,
);

// What the module needs satisfied at instantiation. A MAIN_MODULE is linked with
// --unresolved-symbols=import-dynamic, so anything left undefined becomes an import.
const bytes = await readFile(join(OUT, 'wasm_run.wasm'));
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module);
const byModule = new Map();
for (const entry of imports) {
	if (!byModule.has(entry.module)) byModule.set(entry.module, []);
	byModule.get(entry.module).push(entry.name);
}

console.log(`\n${imports.length} imports`);
for (const [name, names] of [...byModule].sort((a, b) => b[1].length - a[1].length)) {
	const gl = names.filter((n) => n.startsWith('emscripten_gl')).length;
	const note = gl ? ` (${gl} unused emscripten_gl* — MAIN_MODULE=1 exports everything)` : '';
	console.log(`  ${name}: ${names.length}${note}`);
}
