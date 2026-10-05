// What does skipping print_arr cost? Every case run with and without it.
//
//   node verify-skip.mjs <dir with wasm_run.js / wasm_run.wasm / wasm_run.data>
//
// print_arr is the pass the bisect identified: skipping it restores `print *` inside a do loop, and no
// other pass does. It is named for array printing, so the question is whether skipping it breaks
// anything a playground needs. Each case is therefore run twice — default, and with print_arr skipped —
// and the two outputs compared.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const dir = resolve(process.argv[2] ?? '.');
const gz = join(dir, 'wasm_run.wasm.gz');
const raw = join(dir, 'wasm_run.wasm');
const wasmBinary = new Uint8Array(
	existsSync(gz) ? gunzipSync(readFileSync(gz)) : readFileSync(raw),
);

const CASES = [
	[
		'loop with print *  (the regression)',
		`program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
`,
	],
	['hello', `program p\nprint *, 'hello'\nend program\n`],
	[
		'whole-array print',
		`program p
real :: a(4)
a = [10.0, 20.0, 30.0, 40.0]
print *, a
end program
`,
	],
	[
		'array section print',
		`program p
real :: a(4)
a = [10.0, 20.0, 30.0, 40.0]
print *, a(2:3)
end program
`,
	],
	[
		'element and mixed list',
		`program p
real :: a(4)
integer :: i
a = [10.0, 20.0, 30.0, 40.0]
do i = 1, 3
   print *, 'a(', i, ') =', a(i)
end do
end program
`,
	],
	[
		'allocatable array print',
		`program p
integer, allocatable :: v(:)
allocate(v(3))
v = 7
print *, v
end program
`,
	],
	[
		'derived type',
		`program p
type :: point
   real :: x, y
end type
type(point) :: q
q%x = 3.0
q%y = 4.0
print *, q%x + q%y
end program
`,
	],
];

const glue = await import(pathToFileURL(join(dir, 'wasm_run.js')).href);
const factory = glue.default ?? glue.createLFortran;
// The collector has to be passed in here: emscripten captures print/printErr during initialisation, so
// assigning to module.print afterwards has no effect and every run looks empty.
const capture = [];
const module = await factory({
	locateFile: (file) => join(dir, file),
	wasmBinary,
	print: (line) => capture.push(line),
	printErr: () => {},
});
const run = module.cwrap('run_fortran', 'string', ['string']);

const call = (program, skipPrintArr) => {
	capture.length = 0;
	try {
		module.FS.unlink('/skip.txt');
	} catch {
		// Not there.
	}
	if (skipPrintArr) {
		module.FS.writeFile('/skip.txt', new TextEncoder().encode('print_arr\n'));
	}
	let threw = null;
	try {
		run(program);
	} catch (error) {
		threw = String(error?.message ?? error);
	}
	return { out: capture.join('\n').replace(/\s+/g, ' ').trim(), threw };
};

console.log(`dir: ${dir}`);
console.log(`wasm: ${wasmBinary.length.toLocaleString()} bytes\n`);
console.log(`${'case'.padEnd(38)} ${'default'.padEnd(26)} ${'print_arr skipped'.padEnd(26)} verdict`);
console.log('-'.repeat(110));

for (const [label, program] of CASES) {
	const d = call(program, false);
	const s = call(program, true);
	const dText = d.threw ? `threw: ${d.threw}` : d.out === '' ? '(nothing)' : d.out;
	const sText = s.threw ? `threw: ${s.threw}` : s.out === '' ? '(nothing)' : s.out;
	let verdict;
	if (d.threw || s.threw) verdict = 'ERROR';
	else if (d.out === s.out) verdict = d.out === '' ? 'both empty' : 'identical';
	else verdict = 'DIFFERS';
	console.log(
		`${label.padEnd(38)} ${dText.slice(0, 25).padEnd(26)} ${sText.slice(0, 25).padEnd(26)} ${verdict}`,
	);
}
