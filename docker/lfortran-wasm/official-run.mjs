// Compile with the official build's own entry point.
//
//   node official-run.mjs
//
// The module exports _emit_wasm_from_source (and _emit_wat_from_source), and cwrap is available to
// marshal strings even though the heap helpers are not exported. That means one loaded compiler can
// compile many programs — no fresh module per compile. This calls both on the user's do-loop repro:
// the WAT is readable text, so it also shows whether the wasm backend keeps the loop's print.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const BASE = 'https://lfortran.github.io/wasm_builds/dev/d981ac1f4/';
const cache = new URL('./official/', import.meta.url);
const dir = fileURLToPath(cache);
mkdirSync(cache, { recursive: true });

for (const name of ['lfortran.js', 'lfortran.wasm', 'lfortran.data']) {
	const target = new URL(name, cache);
	if (existsSync(target)) continue;
	const response = await fetch(BASE + name);
	if (!response.ok) continue;
	writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}
console.log('build cached\n');

const LOOP = `program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
`;

const Module = { noInitialRun: true, print: () => {}, printErr: () => {}, locateFile: (f) => dir + f };
globalThis.Module = Module;
globalThis.__dirname = dir;
globalThis.require = createRequire(import.meta.url);
vm.runInThisContext(readFileSync(new URL('lfortran.js', cache), 'utf8'), { filename: 'lfortran.js' });

await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('never became ready')), 600000);
	Module.onRuntimeInitialized = () => {
		clearTimeout(timer);
		resolve();
	};
});
console.log('module ready\n');

const call = (label, name, returnType, argTypes, args) => {
	let wrapped;
	try {
		wrapped = Module.cwrap(name, returnType, argTypes);
	} catch (error) {
		console.log(`${label}: cwrap failed — ${error.message}`);
		return null;
	}
	let result;
	try {
		result = wrapped(...args);
	} catch (error) {
		console.log(`${label}: call threw — ${error.message}`);
		return null;
	}
	const described =
		typeof result === 'string'
			? `string of ${result.length} chars`
			: `${typeof result} ${String(result)}`;
	console.log(`${label}: ${described}`);
	return result;
};

const wat = call('emit_wat_from_source', 'emit_wat_from_source', 'string', ['string'], [LOOP]);
if (typeof wat === 'string') {
	console.log('\n--- the WAT it produced (first 1200 chars) ---');
	console.log(wat.slice(0, 1200));
	console.log('--- does the wat mention the loop print? ---');
	console.log(`  contains "print"/"write": ${/print|write/i.test(wat)}`);
}

const wasm = call('\nemit_wasm_from_source', 'emit_wasm_from_source', 'string', ['string'], [LOOP]);
if (typeof wasm === 'string') {
	console.log(`  first 120 chars: ${JSON.stringify(wasm.slice(0, 120))}`);
	console.log(`  starts with the wasm magic: ${wasm.charCodeAt(0) === 0 && wasm.charCodeAt(1) === 97}`);
}
