// Call run_fortran directly, without the loader's try/catch, so the trap's stack survives.
//
//   node probe-run-fortran.mjs <dir with wasm_run.js + wasm_run.wasm[.gz] + wasm_run.data>
//
// The loader turns a trap into a friendly string, which is right for users and useless for diagnosis:
// "memory access out of bounds" says nothing about *where*. This drives the same glue the loader does
// and lets the error propagate, so the wasm frames are printed. Run against the working v0.66.0 assets
// as a control and against the 0.59.0 build to see the difference.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const dir = resolve(process.argv[2] ?? '.');
const gz = join(dir, 'wasm_run.wasm.gz');
const raw = join(dir, 'wasm_run.wasm');
const wasmBinary = new Uint8Array(existsSync(gz) ? gunzipSync(readFileSync(gz)) : readFileSync(raw));
console.log(`dir: ${dir}`);
console.log(`wasm: ${wasmBinary.length.toLocaleString()} bytes (${existsSync(gz) ? 'gzipped' : 'raw'})`);

const glue = await import(pathToFileURL(join(dir, 'wasm_run.js')).href);
const factory = glue.default ?? glue.createLFortran;
if (typeof factory !== 'function') throw new Error('the glue did not export a factory');

const stdout = [];
const stderr = [];
const module = await factory({
	locateFile: (file) => join(dir, file),
	wasmBinary,
	print: (line) => stdout.push(line),
	printErr: (line) => stderr.push(line),
});
console.log('module ready');

const runFortran = module.cwrap('run_fortran', 'string', ['string']);
// The program is a parameter because the trap's *input* is the cheapest thing to vary: no rebuild, and
// a minimal input says whether parsing needs content at all. `\n` is expanded so it can be passed on a
// command line, and "" is allowed through deliberately.
const PROGRAM =
	process.argv[3] === undefined
		? `program p
print *, 'hello from the probe'
end program
`
		: process.argv[3].replace(/\\n/g, '\n');
console.log(`program: ${JSON.stringify(PROGRAM.slice(0, 80))}${PROGRAM.length > 80 ? '…' : ''}`);

// Before blaming run_fortran, check the runtime underneath it. If malloc/free work, the module's
// memory and its stdio are alive and the fault is inside run_fortran's own first statements; if they
// trap too, nothing about this module is usable and the cause is earlier — in the link or the init.
for (const name of ['_malloc', '_free']) {
	try {
		const fn = module[name];
		if (typeof fn !== 'function') {
			console.log(`${name}: not exported`);
			continue;
		}
		if (name === '_malloc') {
			const pointer = fn(4096);
			console.log(`${name}(4096) -> ${pointer}`);
			module._free(pointer);
			console.log('_free ok');
		}
	} catch (error) {
		console.log(`${name} THREW: ${error?.message ?? error}`);
	}
}

// Emscripten keeps the runtime's own error text, which the loader's catch discards.
console.log(`ABORT text so far: ${JSON.stringify(String(module.ABORT ?? ''))}`);

let status;
try {
	status = runFortran(PROGRAM);
	console.log(`run_fortran returned: ${JSON.stringify(status)}`);
} catch (error) {
	console.log('run_fortran THREW');
	console.log(`  message: ${error?.message ?? error}`);
	const stack = String(error?.stack ?? '');
	console.log('  stack:');
	for (const line of stack.split('\n').slice(0, 12)) console.log(`    ${line.trim()}`);
}
console.log(`stdout: ${JSON.stringify(stdout.join('\n'))}`);
console.log(`printErr: ${JSON.stringify(stderr.join('\n').slice(0, 600))}`);
