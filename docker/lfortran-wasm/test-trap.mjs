// What happens to a loaded compiler when a program traps?
//
//   node test-trap.mjs
//
// This matters more for a playground than for a batch compiler: users paste broken code constantly, and
// the module is a MAIN_MODULE whose side modules are dlopen'd into one process. If a trap leaves that
// process unusable, the loader has to notice and rebuild, because otherwise one bad paste breaks the
// session. Each probe here is followed by a healthy program to see whether the compiler still works.
import { createCompiler } from '../../packages/lfortran-wasm/src/index.js';

const PROBES = {
	'integer division by zero': `program p
integer :: a, b
a = 10
b = 0
print *, a / b
end program
`,
	'infinite recursion': `program p
call recurse(1)
contains
recursive subroutine recurse(n)
integer, intent(in) :: n
call recurse(n + 1)
end subroutine
end program
`,
	'out-of-bounds write': `program p
integer :: a(3)
a(5) = 1
print *, a(5)
end program
`,
	'negative sqrt': `program p
real :: x
x = sqrt(-1.0)
print *, x
end program
`,
	'read past end of stdin': `program p
integer :: a, b
read *, a
read *, b
print *, a + b
end program
`,
};

const compiler = await createCompiler({ baseUrl: new URL('./out/', import.meta.url) });
console.log('compiler loaded\n');

let usable = 0;
for (const [name, source] of Object.entries(PROBES)) {
	console.log(`--- ${name} ---`);
	try {
		const result = await compiler.run(source, '7\n');
		const first = (result.errors || '').split('\n')[0];
		console.log(`  exitCode=${result.exitCode} stdout=${JSON.stringify(result.stdout)}`);
		if (first) console.log(`  errors: ${first}`);
	} catch (error) {
		// A wasm trap or an ExitStatus escaping run(); the loader is meant to catch these.
		console.log(`  threw out of run(): ${error?.message ?? error}`);
	}

	// The question: does one bad program break the session?
	try {
		const after = await compiler.run(`program ok
print *, 'still alive'
end program
`);
		const fine = after.exitCode === 0 && after.stdout.includes('still alive');
		if (fine) usable += 1;
		console.log(`  compiler afterwards: ${fine ? 'usable' : `BROKEN — ${(after.errors || '').split('\n')[0]}`}`);
	} catch (error) {
		console.log(`  compiler afterwards: BROKEN — threw ${error?.message ?? error}`);
	}
	console.log('');
}

console.log(`${usable}/${Object.keys(PROBES).length} probes left the compiler usable`);
