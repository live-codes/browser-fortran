// Lists what the built module imports, i.e. what it expects to be satisfied at instantiation.
//
//   node inspect-wasm.mjs
//
// A MAIN_MODULE is linked with `--unresolved-symbols=import-dynamic`, so symbols that were never
// defined are permitted at link time and become imports. In a browser nothing satisfies them until a
// side module is dlopen'd, which is why it is worth seeing the list rather than guessing.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const bytes = await readFile(join(OUT, 'wasm_run.wasm'));
const module = new WebAssembly.Module(bytes);

const imports = WebAssembly.Module.imports(module);
const byModule = new Map();
for (const entry of imports) {
	if (!byModule.has(entry.module)) byModule.set(entry.module, []);
	byModule.get(entry.module).push(`${entry.name} (${entry.kind})`);
}

console.log(`${(bytes.length / 1048576).toFixed(1)} MB, ${imports.length} imports\n`);
for (const [name, names] of [...byModule].sort((a, b) => b[1].length - a[1].length)) {
	console.log(`${name}: ${names.length}`);
	for (const entry of names.slice(0, 40)) console.log(`    ${entry}`);
	if (names.length > 40) console.log(`    ... and ${names.length - 40} more`);
}
