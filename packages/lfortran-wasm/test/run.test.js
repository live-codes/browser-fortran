// Tests the packaged artifact: the run_fortran loader against the vendored assets.
//
//   npm test
//
// These run the artifact LiveCodes would load, through `createCompiler(...).run(...)`. Two of them are
// guards for bugs that have actually bitten:
//
//   * `print *` inside a do loop produces no output at all from LFortran 0.60.0 onward. It is fixed by
//     skipping the print_arr pass in the entry point, and this is what keeps it fixed.
//   * a successful run used to return the entry point's own stderr as `errors`, so a configuration
//     note showed up as a diagnostic on a program that worked perfectly.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCompiler } from '../src/index.js';

// Loading costs the ~17 MiB read plus instantiation, so it is shared across the tests.
const compilerPromise = createCompiler();

const flat = (text) => text.replace(/\s+/g, ' ').trim();

test('runs a free-form program and captures stdout', async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`program hello
print *, 'hello from LFortran'
end program
`);

	assert.equal(exitCode, 0, errors);
	assert.equal(flat(stdout), 'hello from LFortran');
});

// The regression guard. On every released build from 0.60.0 through current main this prints nothing,
// silently: the print_arr pass drops the statement.
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
	assert.equal(flat(stdout), '1 2 3');
});

test('prints a mixed list inside a do loop', async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`program p
integer :: i
real :: a(3)
a = [1.0, 2.0, 3.0]
do i = 1, 3
   print *, 'a(', i, ') =', a(i)
end do
end program
`);

	assert.equal(exitCode, 0, errors);
	assert.equal(flat(stdout), 'a( 1 ) = 1.00000000 a( 2 ) = 2.00000000 a( 3 ) = 3.00000000');
});

// Skipping print_arr must not cost the thing that pass is named for. Nothing is lost: print_list_tuple
// covers these, and each of these outputs is byte-identical with the pass skipped.
test('prints whole arrays, sections and allocatables', async () => {
	const compiler = await compilerPromise;

	const whole = await compiler.run(`program p
real :: a(3)
a = [1.0, 2.0, 3.0]
print *, a
end program
`);
	assert.equal(whole.exitCode, 0, whole.errors);
	assert.equal(flat(whole.stdout), '1.00000000 2.00000000 3.00000000');

	const section = await compiler.run(`program p
real :: a(4)
a = [10.0, 20.0, 30.0, 40.0]
print *, a(2:3)
end program
`);
	assert.equal(section.exitCode, 0, section.errors);
	assert.equal(flat(section.stdout), '20.0000000 30.0000000');

	const allocatable = await compiler.run(`program p
integer, allocatable :: v(:)
allocate(v(3))
v = 7
print *, v
end program
`);
	assert.equal(allocatable.exitCode, 0, allocatable.errors);
	assert.equal(flat(allocatable.stdout), '7 7 7');
});

test('supports derived types, which the published wasm backend cannot compile', async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(`program p
type :: point
   real :: x, y
end type
type(point) :: q
q%x = 3.0
q%y = 4.0
print *, q%x + q%y
end program
`);

	assert.equal(exitCode, 0, errors);
	assert.equal(flat(stdout), '7.00000000');
});

test('reads stdin, which the published wasm backend aborts on', async () => {
	const compiler = await compilerPromise;
	const { stdout, errors, exitCode } = await compiler.run(
		`program adder
integer :: a, b
read *, a
read *, b
print *, a + b
end program
`,
		'20\n22\n',
	);

	assert.equal(exitCode, 0, errors);
	assert.equal(flat(stdout), '42');
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

// A successful run must have *empty* diagnostics. The host returns the program's stderr as `errors`, so
// anything the entry point writes there — a configuration note, say — reads as an error to the user on
// a program that worked perfectly. That happened; this is the guard against it returning.
test('a successful run has no diagnostics', async () => {
	const compiler = await compilerPromise;
	const { errors, exitCode } = await compiler.run(`program p
print *, 'ok'
end program
`);

	assert.equal(exitCode, 0);
	assert.equal(errors, '');
});

// A failed program must not spoil the loaded module for the next run.
test('a failed program does not poison the compiler for the next one', async () => {
	const compiler = await compilerPromise;
	const failed = await compiler.run(`program p
this is not fortran
end program
`);
	assert.equal(failed.exitCode, null);
	assert.ok(failed.errors.length > 0, 'expected a diagnostic');

	const after = await compiler.run(`program p
print *, 'still working'
end program
`);
	assert.equal(after.exitCode, 0, after.errors);
	assert.equal(flat(after.stdout), 'still working');
});
