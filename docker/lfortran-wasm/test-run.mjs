// Runs Fortran through the freshly built LFortran wasm module, the way a browser driver would.
//
//   node test-run.mjs
//
// Expects `out/wasm_run.js`, `out/wasm_run.wasm` and `out/wasm_run.data` from the container. The
// module is `-s MAIN_MODULE=1` with `MODULARIZE=1` and `EXPORT_NAME=createLFortran`, so it exports a
// factory, and the entry point (`run_fortran`, from wasm-run-main.cpp) is reached through `cwrap`.
//
// The corpus is the same one run against the f2c pipeline, so the two can be compared directly —
// including the cases f2c accepted *and got wrong*, which is the point of the exercise.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Emscripten's node path reaches for fs/path through require(). Supplied under another name because a
// bare `require` next to top-level await makes node treat the file as ambiguous CommonJS.
const nodeRequire = createRequire(import.meta.url);

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

const CASES = {
	'hello (free form)': `program hello
print *, 'hello from LFortran'
end program
`,
	'DO loop': `program squares
integer :: i, sq
do i = 1, 10
   sq = i * i
   print *, 'n=', i, '  n squared=', sq
end do
end program
`,
	'arrays, DATA, REAL': `program stats
real :: x(5), total, avg
integer :: i
data x /1.0, 2.0, 3.0, 4.0, 5.0/
total = 0.0
do i = 1, 5
   total = total + x(i)
end do
avg = total / 5.0
print *, 'Sum  = ', total
print *, 'Mean = ', avg
end program
`,
	'subroutine and function': `program calls
integer :: n
call double(21, n)
print *, 'doubled:', n
print *, 'tripled:', triple(14)
contains
integer function triple(v)
   integer, intent(in) :: v
   triple = v * 3
end function
subroutine double(v, out)
   integer, intent(in) :: v
   integer, intent(out) :: out
   out = v * 2
end subroutine
end program
`,
	'F90 declarations': `program decl
integer :: i
real(8) :: r
character(len=10) :: s
i = 1
r = 1.5
s = 'hi'
print *, i, r, s
end program
`,
	'MODULE + USE': `module m
implicit none
contains
subroutine say
   print *, 'from a module'
end subroutine
end module
program p
use m
call say
end program
`,
	'derived type': `program p
type :: point
   real :: x, y
end type
type(point) :: p1
p1%x = 1.0
p1%y = 2.0
print *, p1%x, p1%y
end program
`,
	'ALLOCATABLE': `program p
real, allocatable :: a(:)
allocate(a(3))
a(1) = 1.0
a(2) = 2.0
a(3) = 3.0
print *, a(1) + a(2) + a(3)
end program
`,
	'array section A(2:3)': `program p
real :: a(4)
a(1) = 10.0
a(2) = 20.0
a(3) = 30.0
a(4) = 40.0
print *, 'A(2:3) =', a(2:3)
end program
`,
	'whole-array arithmetic': `program p
real :: a(3), b(3)
a = 1.0
b = a + 1.0
print *, b
end program
`,
	'SUM intrinsic': `program p
real :: a(3)
a(1) = 1.0
a(2) = 2.0
a(3) = 3.0
print *, sum(a)
end program
`,
	'READ from stdin': `program adder
integer :: a, b
print *, 'Enter two integers:'
read *, a
read *, b
print *, 'Sum = ', a + b
end program
`,
	// The shape upstream's own wasm tests use: global statements with no program unit. If these pass
	// where the ones above fail, the fault is in the interactive `_program` path specifically.
	'statements, no program unit': `integer :: i
i = 5
print *, i
`,
	'statements, implicit program': `real :: x
x = 3.5
print *, x
`,
};

async function loadModule() {
	const js = await readFile(join(OUT, 'wasm_run.js'), 'utf8');
	const context = {
		// Emscripten's node path wants these.
		require: nodeRequire,
		module: { exports: {} },
		exports: {},
		__dirname: OUT,
		__filename: join(OUT, 'wasm_run.js'),
		console,
		process,
		Buffer,
		TextDecoder,
		TextEncoder,
		WebAssembly,
		// The vm realm needs the host's error constructors: the wasm objects come from the host's
		// WebAssembly, so a TypeError it throws is not an instance of the vm's TypeError, and
		// emscripten's `err instanceof TypeError` checks in addFunction silently stop matching —
		// which turns a handled case into a raw WebAssembly.Table.set error.
		TypeError,
		RangeError,
		Error,
		fetch,
		URL,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		queueMicrotask,
		performance,
	};
	context.global = context;
	context.globalThis = context;
	vm.createContext(context);
	vm.runInContext(js, context);

	const factory = context.createLFortran ?? context.module.exports;
	if (typeof factory !== 'function') {
		throw new Error('the module did not export a factory (expected createLFortran)');
	}

	const out = [];
	const err = [];
	// Emscripten hands the program whatever `Module.stdin` returns, and keeps calling it until it
	// returns null. Since the function itself is what gets stored, a queue that the harness refills
	// per run gives each program its own stdin without rebuilding the module.
	const stdinQueue = [];
	const instance = await factory({
		locateFile: (path) => join(OUT, path),
		print: (text) => out.push(text),
		printErr: (text) => err.push(text),
		stdin: () => (stdinQueue.length ? stdinQueue.shift() : null),
	});
	return {
		runFortran: instance.cwrap('run_fortran', 'string', ['string']),
		setStdin(text) {
			stdinQueue.length = 0;
			for (const line of text.split('\n')) {
				if (line !== '') stdinQueue.push(`${line}\n`);
			}
		},
		out,
		err,
	};
}

const { runFortran, setStdin, out, err } = await loadModule();
console.log(`loaded; run_fortran is ${typeof runFortran}\n`);

let passed = 0;
let dumped = false;
for (const [name, source] of Object.entries(CASES)) {
	out.length = 0;
	err.length = 0;
	const stdin = name === 'READ from stdin' ? '20\n22\n' : '';
	setStdin(stdin);

	let status;
	try {
		status = runFortran(source);
	} catch (error) {
		status = `1,threw: ${error.message}`;
	}

	const ok = status === '0';
	if (ok) passed += 1;
	// Emscripten's print callback is invoked once per line, with the newline consumed, so the
	// separator has to be put back rather than joining with ''.
	const stdout = out.join('\n').trimEnd();
	console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}`);
	if (ok) {
		if (stdout) console.log(`      ${stdout.split('\n').join('\n      ')}`);
	} else {
		console.log(`      ${status.slice(0, 300).replace(/\n/g, '\n      ')}`);
		// `asr_to_llvm` prints the whole module to stdout when verification fails
		// (asr_to_llvm.cpp: `v.module->print(os, nullptr); std::cout << os.str();`), so the invalid IR
		// is sitting in the captured output rather than being lost.
		if (!dumped && out.length > 0) {
			dumped = true;
			const dump = join(OUT, 'invalid.ll');
			await writeFile(dump, out.join(''));
			console.log(`      (invalid IR: ${dump}, ${out.join('').length} chars)`);
		}
	}
	if (err.length) console.log(`      [stderr] ${err.join('').slice(0, 200)}`);
}

console.log(`\n${passed}/${Object.keys(CASES).length} compiled and ran`);
