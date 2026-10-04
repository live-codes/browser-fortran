// Tests the packaged artifact: src/index.js against the vendored assets.
//
//   npm test
//
// The assets are ~20 MiB and are produced by `npm run copy-assets` from a container build, so they
// may be absent in a fresh checkout. Rather than fail on that, the whole file skips with a reason.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createCompiler } from '../src/index.js';

const assets = fileURLToPath(new URL('../assets/wasm_run.wasm.gz', import.meta.url));
const hasAssets = existsSync(assets);
const skip = hasAssets ? false : 'assets not vendored yet — run `npm run copy-assets`';

// Loading the compiler costs the 19 MiB read plus instantiation, so it is shared across tests.
const compilerPromise = hasAssets ? createCompiler() : null;

test('runs a free-form program and captures stdout', { skip }, async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`program hello
print *, 'hello from LFortran'
end program
`);

	assert.equal(exitCode, 0);
	assert.equal(errors, '');
	assert.equal(stdout.trimEnd(), 'hello from LFortran');
});

test('supports modules, contained procedures and derived types', { skip }, async () => {
	const compiler = await compilerPromise;
	const { stdout, exitCode } = await compiler.run(`module geometry
implicit none
type :: point
   real :: x, y
end type
contains
real function norm2d(p)
   type(point), intent(in) :: p
   norm2d = sqrt(p%x**2 + p%y**2)
end function
end module
program main
use geometry
type(point) :: p
p%x = 3.0
p%y = 4.0
print *, norm2d(p)
end program
`);

	assert.equal(exitCode, 0);
	assert.equal(stdout.trim(), '5.00000000');
});

// The case the f2c pipeline it replaced compiled, linked, ran, exited 0 on — and got wrong, printing
// all four elements, because f2c reads x(a:b) as a character substring.
test('array sections print the section, not the whole array', { skip }, async () => {
	const compiler = await compilerPromise;
	const { stdout, exitCode } = await compiler.run(`program p
real :: a(4)
a(1) = 10.0
a(2) = 20.0
a(3) = 30.0
a(4) = 40.0
print *, a(2:3)
end program
`);

	assert.equal(exitCode, 0);
	const printed = stdout.split(/\s+/).filter(Boolean).map(Number);
	assert.deepEqual(printed, [20, 30]);
});

test('reads stdin', { skip }, async () => {
	const compiler = await compilerPromise;
	const { stdout, exitCode } = await compiler.run(
		`program adder
integer :: a, b
read *, a
read *, b
print *, a + b
end program
`,
		'20\n22\n',
	);

	assert.equal(exitCode, 0);
	assert.equal(Number(stdout.trim()), 42);
});

test('reports a compile error instead of throwing', { skip }, async () => {
	const compiler = await compilerPromise;
	const { errors, exitCode } = await compiler.run(`program broken
this is not fortran
end program
`);

	assert.equal(exitCode, null);
	assert.match(errors, /syntax|token|expect/i);
});

// Guards the artifact against a build that fights itself. `open` loads a runtime module at compile
// time, and LFortran refuses a .mod written by a different version — which is what a compiler that
// reports "0.65.0-dirty" does against modules that say "0.65.0", because the build tree carries the
// patches in docker/lfortran-wasm/build-in-container.sh. This is the test that keeps the two in step.
test('uses runtime modules it is willing to load', { skip }, async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`program p
integer :: u, i
open (newunit=u, file='out.txt', status='replace')
do i = 1, 3
   write (u, *) i * i
end do
close (u)
print *, 'wrote the file'
end program
`);

	assert.equal(exitCode, 0, errors);
	assert.equal(stdout.trim(), 'wrote the file');
});

test('a program that exits is reported, not thrown', { skip }, async () => {
	const compiler = await compilerPromise;
	// Reading when stdin is exhausted makes the runtime exit(1), which arrives as a thrown
	// ExitStatus rather than a return value.
	const { exitCode } = await compiler.run(`program p
integer :: a
read *, a
end program
`);

	assert.equal(exitCode, null);
});
