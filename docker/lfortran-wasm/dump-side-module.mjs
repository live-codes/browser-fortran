// Reads the side modules LFortran compiled, out of the wasm filesystem, and unions their imports.
//
//   node dump-side-module.mjs
//
// This is what makes `-s MAIN_MODULE=2` tractable, and what decides whether it is safe. With
// MAIN_MODULE=1 the main module exports everything, so a compiled program can import whatever it
// likes. MAIN_MODULE=2 exports only what is named in EXPORTED_FUNCTIONS, so the list has to cover
// every symbol any program might import — not just the ones a corpus happens to touch. Guessing
// would cost a build cycle per missing symbol, so instead: build once with MAIN_MODULE=1, run a
// spread of programs, and read the artifacts they produced out of the emscripten filesystem.
//
// LFortran's executor writes each program out as a wasm side module and loads it with dlopen, so
// those files are still there afterwards. Their imports are exactly what the main module must export.
import { CASES } from './corpus.mjs';
import { createCompiler } from '../../packages/lfortran-wasm/src/index.js';

// Chosen to pull in code paths the corpus does not: libm calls, formatted writes, string intrinsics,
// 64-bit arithmetic (which can become a compiler-rt libcall), and file I/O.
const EXTRA = {
	'libm: sqrt, sin, pow': `program p
real(8) :: x
x = 2.0d0
print *, sqrt(x), sin(x), x**3, atan(x)
end program
`,
	'formatted write': `program p
integer :: i = 42
real :: r = 3.5
write (*, '(A,I0)') 'i=', i
write (*, '(F6.2)') r
end program
`,
	'string intrinsics': `program p
character(len=20) :: s
character(len=:), allocatable :: t
s = '  hello  '
t = trim(s) // '!'
print *, len_trim(s), len(s), t
end program
`,
	'64-bit arithmetic': `program p
integer(8) :: a, b
a = 9000000000_8
b = a * a
print *, b
end program
`,
	'file io': `program p
integer :: u, i
open (newunit=u, file='out.txt', status='replace')
do i = 1, 3
   write (u, *) i
end do
close (u)
open (newunit=u, file='out.txt', status='old')
do i = 1, 3
   print *, 'read back'
end do
close (u)
end program
`,
	'allocate and deallocate': `program p
real, allocatable :: a(:)
integer :: i
allocate (a(10))
do i = 1, 10
   a(i) = real(i)
end do
print *, maxval(a), minval(a), size(a)
deallocate (a)
end program
`,
	'while loop and select case': `program p
integer :: i = 0
do while (i < 3)
   i = i + 1
   select case (i)
   case (1)
      print *, 'one'
   case default
      print *, i
   end select
end do
end program
`,
	'subroutine with assumed-shape array': `program p
real :: a(5)
interface
   subroutine fill(x)
      real, intent(out) :: x(:)
   end subroutine
end interface
call fill(a)
print *, a(1), a(5)
end program
subroutine fill(x)
   real, intent(out) :: x(:)
   integer :: i
   do i = 1, size(x)
      x(i) = real(i) * 2.0
   end do
end subroutine
`,
};

const FS = (module) => module.FS;

function allWasmFiles(fs, dir = '/', found = []) {
	for (const entry of fs.readdir(dir)) {
		if (entry === '.' || entry === '..' || entry === 'dev' || entry === 'lib') continue;
		const path = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
		let stats;
		try {
			stats = fs.stat(path);
		} catch {
			continue;
		}
		if (fs.isDir(stats.mode)) allWasmFiles(fs, path, found);
		else if (path.endsWith('.wasm') && stats.size > 100) found.push(path);
	}
	return found;
}

const programs = { ...CASES, ...EXTRA };
const compiler = await createCompiler({ baseUrl: new URL('./out/', import.meta.url) });

let failures = 0;
for (const [name, source] of Object.entries(programs)) {
	const { exitCode, errors } = await compiler.run(source, '20\n22\n');
	if (exitCode !== 0) {
		failures += 1;
		console.log(`FAILED  ${name}: ${(errors || '').split('\n')[0]}`);
	}
}
console.log(`${Object.keys(programs).length - failures}/${Object.keys(programs).length} programs ran\n`);

const fs = FS(compiler.module);
const files = allWasmFiles(fs);
console.log(`${files.length} side modules left in the filesystem\n`);

const imported = new Set();
for (const path of files) {
	const module = new WebAssembly.Module(fs.readFile(path));
	for (const entry of WebAssembly.Module.imports(module)) {
		// memory/table plus the dynamic-linking bookkeeping are supplied by MAIN_MODULE itself.
		if (['memory', '__stack_pointer', '__memory_base', '__table_base'].includes(entry.name)) continue;
		imported.add(entry.name);
	}
}

const names = [...imported].sort();
const groups = {
	'lfortran runtime': names.filter((n) => /^_(lfortran|lcompilers|lpython)_/.test(n)),
	'libc / libm': names.filter((n) => !/^_(lfortran|lcompilers|lpython)_/.test(n)),
};
for (const [label, group] of Object.entries(groups)) {
	console.log(`${label}: ${group.length}`);
	for (const name of group) console.log(`    ${name}`);
}

console.log(`\n${names.length} symbols total`);
