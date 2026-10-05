// What does a given published build actually support?
//
//   node capabilities.mjs                       # the pinned build
//   node capabilities.mjs dev/d981ac1f4          # any other build, as <type>/<commit>
//
// The wasm backend answers "X not implemented" for constructs it cannot lower, and the set differs
// between builds. This reports, per feature, whether the build compiled it — which is what decides
// whether a build is usable as the playground's compiler at all.
import { createCompiler } from '../../packages/lfortran-wasm/src/index.js';

const ref = process.argv[2] ?? 'release/e8c53fddf';
const baseUrl = `https://lfortran.github.io/wasm_builds/${ref.replace(/\/$/, '')}/`;

// Each case states what a working build prints. Checking the exit code alone is not enough: a build
// that silently drops the statement still exits 0 with empty output, which is exactly the loop
// regression — so that would be reported as "supported".
const CASES = {
	'print in a do loop': {
		expect: '1 2 3',
		source: `program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
`,
	},
	'module with a contained procedure': {
		expect: '42',
		source: `module m
contains
integer function twice(n)
   integer, intent(in) :: n
   twice = 2 * n
end function
end module
program p
use m
print *, twice(21)
end program
`,
	},
	'derived type member access': {
		expect: '7',
		source: `program p
type :: point
   real :: x, y
end type
type(point) :: q
q%x = 3.0
q%y = 4.0
print *, q%x + q%y
end program
`,
	},
	'array section': {
		expect: '1 1',
		source: `program p
real :: a(4)
a = 1.0
print *, a(2:3)
end program
`,
	},
	'sqrt on a real': {
		expect: '1.41421353',
		source: `program p
real :: r
r = sqrt(2.0)
print *, r
end program
`,
	},
	'allocatable array': {
		expect: '8',
		source: `program p
integer, allocatable :: v(:)
allocate(v(3))
v = 7
print *, v(1) + 1
end program
`,
	},
	'string concatenation': {
		expect: 'fortran',
		source: `program p
character(len=20) :: s
s = 'for' // 'tran'
print *, s
end program
`,
	},
	'read from stdin': {
		expect: '42',
		source: `program p
integer :: a
read *, a
print *, a
end program
`,
	},
};

const compiler = await createCompiler({ baseUrl });
console.log(`build: ${ref}\n`);

for (const [feature, { source, expect }] of Object.entries(CASES)) {
	const result = await compiler.run(source, '42\n');
	const got = result.stdout.replace(/\s+/g, ' ').trim();
	const supported = result.exitCode === 0 && got === expect;
	const detail = supported
		? `-> ${JSON.stringify(got.slice(0, 60))}`
		: result.exitCode !== 0
			? `-> ${JSON.stringify(result.errors.split('\n')[0].slice(0, 100))}`
			: `-> printed ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`;
	console.log(`${(supported ? 'supported' : 'NOT supported').padEnd(14)} ${feature.padEnd(34)} ${detail}`);
}
