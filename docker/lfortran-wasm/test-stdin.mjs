// The order that fails in the app: a run with no input, then runs with input.
//
//   node test-stdin.mjs
//
// The app's sequence is exactly this — the sandbox runs the program once with the empty stdin pane,
// then the starter's own input arrives on later runs. If a run that finds no input leaves stdin in a
// state later runs cannot recover from, both the initial output and every click fail with
// "Failed to read input."
import { createCompiler } from '../../packages/lfortran-wasm/src/index.js';

const PROGRAM = `program p
integer :: a
read *, a
print *, a
end program
`;

const compiler = await createCompiler({ baseUrl: new URL('./out/', import.meta.url) });
console.log('compiler loaded\n');

const RUNS = [
	['1. empty stdin (expected to fail - nothing to read)', ''],
	['2. input 7 - must work after the empty run', '7\n'],
	['3. empty stdin again', ''],
	['4. input 9 - must work again', '9\n'],
];

for (const [label, input] of RUNS) {
	const { stdout, errors, exitCode } = await compiler.run(PROGRAM, input);
	const first = (errors || '').split('\n')[0];
	console.log(`${label}: exit=${exitCode} stdout=${JSON.stringify(stdout.trim())}${first ? ` errors=${JSON.stringify(first)}` : ''}`);
}
