// End-to-end smoke test through the package, which is what would actually ship.
//
//   node smoke-package.mjs
//
// Uses createCompiler from the package — the run_fortran loader with its fd-0 stdin wiring and the
// clearerr fix — against the vendored assets, so this exercises the same path LiveCodes would.
import { createCompiler } from '../../packages/lfortran-wasm/src/index.js';

const CASES = [
	['hello', `program p\nprint *, 'hello'\nend program\n`, '', 'hello'],
	[
		'do loop with print *  (the regression)',
		`program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
`,
		'',
		'1 2 3',
	],
	[
		'mixed list inside a loop',
		`program p
integer :: i
real :: a(3)
a = [1.0, 2.0, 3.0]
do i = 1, 3
   print *, 'a(', i, ') =', a(i)
end do
end program
`,
		'',
		'a( 1 ) = 1.00000000 a( 2 ) = 2.00000000 a( 3 ) = 3.00000000',
	],
	[
		'whole-array print',
		`program p
real :: a(3)
a = [1.0, 2.0, 3.0]
print *, a
end program
`,
		'',
		'1.00000000 2.00000000 3.00000000',
	],
	[
		'array section',
		`program p
real :: a(4)
a = [10.0, 20.0, 30.0, 40.0]
print *, a(2:3)
end program
`,
		'',
		'20.0000000 30.0000000',
	],
	[
		'allocatable array',
		`program p
integer, allocatable :: v(:)
allocate(v(3))
v = 7
print *, v
end program
`,
		'',
		'7 7 7',
	],
	[
		'derived type member access',
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
		'',
		'7.00000000',
	],
	[
		'read from stdin',
		`program p
integer :: a, b
read *, a
read *, b
print *, a + b
end program
`,
		'20\n22\n',
		'42',
	],
	[
		'compile error is reported, not thrown',
		`program p\nthis is not fortran\nend program\n`,
		'',
		null,
	],
];

const compiler = await createCompiler();
console.log('compiler loaded\n');

let pass = 0;
let fail = 0;
for (const [label, code, stdin, expect] of CASES) {
	const result = await compiler.run(code, stdin);
	const got = result.stdout.replace(/\s+/g, ' ').trim();
	if (expect === null) {
		const ok = result.exitCode === null && result.errors.length > 0;
		console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(42)} exitCode=${result.exitCode} errors=${JSON.stringify(result.errors.split('\n')[0].slice(0, 60))}`);
		ok ? (pass += 1) : (fail += 1);
		continue;
	}
	// A successful run must also have *empty* diagnostics: the host returns the program's stderr as
	// `errors`, so anything the entry point writes there — a configuration note, say — shows up as a
	// diagnostic on a program that worked perfectly. That is a real bug this check now catches.
	const ok = result.exitCode === 0 && got === expect && result.errors === '';
	console.log(
		`${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(42)} ${JSON.stringify(got)}` +
			(ok ? '' : `  expected ${JSON.stringify(expect)}  errors=${JSON.stringify(result.errors.slice(0, 80))}`),
	);
	ok ? (pass += 1) : (fail += 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
