// Tests the loader against the published LFortran build it pins.
//
//   npm test
//
// In Node the build is downloaded once into a cache directory under the system temp directory, so the
// first run pays for ~12 MiB and later runs do not.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCompiler } from '../src/index.js';

// Loading is shared across the file: the module can only be evaluated once per realm, and reuse is
// exactly what a compiler that is loaded once and run many times should do.
//
// Point the suite at another published build to compare behaviour between them:
//
//   set LFORTRAN_WASM_BUILD=dev/d981ac1f4 && npm test
const requestedBuild = process.env.LFORTRAN_WASM_BUILD?.trim();
const compilerPromise = createCompiler(
	requestedBuild
		? { baseUrl: `https://lfortran.github.io/wasm_builds/${requestedBuild.replace(/\/$/, '')}/` }
		: {},
);

test('runs a free-form program and captures stdout', async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`program hello
print *, 'hello from LFortran'
end program
`);

	assert.equal(exitCode, 0, errors);
	assert.equal(errors, '');
	assert.equal(stdout.trimEnd(), 'hello from LFortran');
});

// The case that pins the build. On release 0.60.0 and later this compiles, runs, exits 0 and prints
// nothing: the print inside the loop is not emitted, and the module comes out smaller than a
// hello-world's. It works on 0.59.0, which is why that release is the pinned one.
test('prints inside a do loop', async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
`);

	assert.equal(exitCode, 0, errors);
	assert.equal(stdout.replace(/\s+/g, ' ').trim(), '1 2 3');
});

// Derived types are a gap in this backend: member access is answered with
// "visit_StructInstanceMember() not implemented", so the case cannot be exercised here. Skipped with
// the reason rather than deleted, so the limitation is visible in the suite and not just the README.
test('supports modules, contained procedures and derived types', {
	skip: 'the wasm backend does not implement derived-type member access',
}, async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`module geometry
implicit none
type :: point
   real :: x, y
end type
contains
real function total(p)
   type(point), intent(in) :: p
   total = p%x + p%y
end function
end module
program main
use geometry
type(point) :: p
p%x = 3.0
p%y = 4.0
print *, total(p)
end program
`);

	assert.equal(exitCode, 0, errors);
	assert.equal(stdout.trim(), '7.00000000');
});

// Element references work. Array *sections* (a(2:3)) do not: this backend answers
// "visit_ArraySection() not implemented", so the case the f2c pipeline got wrong cannot be exercised
// here — see the limitation list in the README.
test('indexes array elements', async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`program p
real :: a(4)
a(1) = 10.0
a(2) = 20.0
a(3) = 30.0
a(4) = 40.0
print *, a(2), a(3)
end program
`);

	assert.equal(exitCode, 0, errors);
	const printed = stdout.split(/\s+/).filter(Boolean).map(Number);
	assert.deepEqual(printed, [20, 30]);
});

test('reports a compile error instead of throwing', async () => {
	const compiler = await compilerPromise;
	const { errors, exitCode } = await compiler.run(`program broken
this is not fortran
end program
`);

	assert.equal(exitCode, null);
	assert.match(errors, /syntax|token|expect|semantic/i);
});

// A program the compiler refuses must not spoil the loaded module. The wasm backend throws rather
// than returning a status for constructs it cannot lower — `read` among them — and a live-coding host
// hit that on every keystroke, so the run after a refused one has to work.
test('a refused program does not poison the compiler for the next one', async () => {
	const compiler = await compilerPromise;
	const refused = await compiler.run(`program p
integer :: a
read *, a
print *, a
end program
`);
	assert.equal(refused.exitCode, null);
	assert.ok(refused.errors.length > 0, 'expected a diagnostic for the refused program');

	const after = await compiler.run(`program p
print *, 'still working'
end program
`);
	assert.equal(after.exitCode, 0, after.errors);
	assert.equal(after.stdout.trim(), 'still working');
});

// Nothing is shared between runs, so the same program gives the same answer every time. This is the
// property that replaced the previous loader's shared-module bug, where a run that read stdin at
// end-of-file left every later run unable to read at all.
test('running the same program repeatedly gives identical results', async () => {
	const compiler = await compilerPromise;
	const program = `program p
integer :: i
do i = 1, 2
   print *, i
end do
end program
`;
	const first = await compiler.run(program);
	const second = await compiler.run(program);

	assert.equal(first.exitCode, 0, first.errors);
	assert.equal(second.exitCode, 0, second.errors);
	assert.equal(first.stdout, second.stdout);
	assert.equal(first.stdout.replace(/\s+/g, ' ').trim(), '1 2');
});
