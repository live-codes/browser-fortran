// The CLI route: what the playground actually does.
//
//   node cli-route.mjs
//
// The playground's output includes "Compilation time" and "Execution time", which are messages the
// lfortran CLI prints itself when it runs a program. So it is not using emit_wasm_from_source, which
// only emits a module (and whose emitted module stays silent for the do loop). This runs the loop
// program through the CLI route, with the source preloaded and the command line set, and captures what
// the compiler writes. A module can only be driven once, and the auto-run does the work here, so no
// noInitialRun.
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

const LOOP = `program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
`;

const argv = process.argv.slice(2);
if (argv.length === 0) {
	console.log('usage: node cli-route.mjs <lfortran args...>   source is the do-loop repro');
}

const out = [];
const err = [];
const Module = {
	print: (line) => out.push(line),
	printErr: (line) => err.push(line),
	locateFile: (file) => dir + file,
	arguments: argv,
	preRun: [
		() => {
			Module.FS_createDataFile('/', 'p.f90', new TextEncoder().encode(LOOP), true, true);
		},
	],
};

// The glue takes its command line from process.argv in Node, so point that at our arguments too: the
// leading two entries are node and the script.
process.argv = ['node', 'lfortran', ...argv];

globalThis.Module = Module;
globalThis.__dirname = dir;
globalThis.require = createRequire(import.meta.url);
vm.runInThisContext(readFileSync(new URL('lfortran.js', cache), 'utf8'), { filename: 'lfortran.js' });

await new Promise((resolve) => setTimeout(resolve, 15000));

console.log(`--- arguments: ${JSON.stringify(argv)}`);
console.log(`--- stdout (${out.length} lines) ---`);
console.log(out.join('\n').slice(0, 1500));
console.log(`--- stderr (${err.length} lines) ---`);
console.log(err.join('\n').slice(0, 1500));
