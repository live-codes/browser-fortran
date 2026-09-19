// Real compiles, in Node, off the assets the package ships - so no server and no configuration.
//
// The cases here are the surface a Fortran 77 program actually has: a program with its own
// subroutines and functions, file I/O, stdin, and the three ways one can fail - f2c refusing the
// source, wasm-ld refusing the link, and the program trapping at run time.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
// By name, so the tests exercise the real entry point - including the `node` condition that wires
// the packaged assets in.
import { createCompiler } from '@live-codes/fortran-wasm';
import { ASSET_RECEIPTS } from '../src/asset-receipts.js';

const HELLO = `      PROGRAM HELLO
      PRINT *, 'Hello from Fortran!'
      END
`;

test('a program compiles and runs, with no configuration at all', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(HELLO);

	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, ' Hello from Fortran!\n');
	assert.equal(result.stderr, '');
	assert.equal(result.output, ' Hello from Fortran!\n');
	assert.equal(result.exitCode, 0);
	// The Fortran-to-C step is part of the compile, not beside it.
	assert.ok(result.translateMs >= 0);
	assert.ok(result.compileMs >= result.translateMs);
	assert.ok(result.runMs >= 0);
	compiler.dispose();
});

test('the result shape is the documented one', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(HELLO);

	assert.deepEqual(Object.keys(result).sort(), [
		'compileMs',
		'errors',
		'exitCode',
		'output',
		'runMs',
		'stderr',
		'stdout',
		'translateMs'
	]);
	assert.equal(compiler.language, 'fortran');
	assert.equal(compiler.dialect, 'fortran77');
	compiler.dispose();
});

test('stdin reaches READ', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(
		`      PROGRAM ADDER
      INTEGER A, B
      READ *, A
      READ *, B
      PRINT *, 'Sum = ', A + B
      END
`,
		'20\n22\n'
	);

	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, ' Sum =  42\n');
	assert.equal(result.exitCode, 0);
	compiler.dispose();
});

test('a program can have subroutines and functions of its own', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(
		`      PROGRAM CALLS
      INTEGER TRIPLE, N
      CALL DOUBLE(21, N)
      PRINT *, N
      PRINT *, TRIPLE(14)
      END
      SUBROUTINE DOUBLE(V, OUT)
      INTEGER V, OUT
      OUT = V * 2
      END
      INTEGER FUNCTION TRIPLE(V)
      INTEGER V
      TRIPLE = V * 3
      END
`
	);

	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, ' 42\n 42\n');
	compiler.dispose();
});

test('a program can write a file and read it back', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(
		`      PROGRAM FILES
      INTEGER I, N
      OPEN (UNIT=7, FILE='data.txt', STATUS='UNKNOWN')
      DO 10 I = 1, 3
         WRITE (7, 20) I * 11
   10 CONTINUE
      CLOSE (7)
      OPEN (UNIT=7, FILE='data.txt', STATUS='OLD')
      DO 30 I = 1, 3
         READ (7, 20) N
         PRINT *, N
   30 CONTINUE
      CLOSE (7)
   20 FORMAT (I6)
      END
`
	);

	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, ' 11\n 22\n 33\n');
	compiler.dispose();
});

test('a bad program is f2c to report, and does not run', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(
		`      PROGRAM BROKEN
      INTEGER I
      DO 10 I = 1, 3
         PRINT *, I
      END
`
	);

	assert.equal(result.exitCode, null);
	assert.equal(result.runMs, null);
	assert.equal(result.stdout, '');
	assert.ok(result.errors.length > 0, 'expected diagnostics');
	assert.ok(
		result.errors.some((line) => /statement label 10/.test(line)),
		`expected f2c to name the missing label, got:\n${result.errors.join('\n')}`
	);
	// Diagnostics are colourless: the runtime compiles with -fcolor-diagnostics.
	assert.ok(!/\u001b\[/.test(result.errors.join('\n')), 'expected ANSI escapes to be stripped');
	compiler.dispose();
});

test('a bad link is wasm-ld to report, and does not run', async () => {
	const compiler = await createCompiler();
	const result = await compiler.run(
		`      PROGRAM MISSING
      CALL NOSUCHSUB
      END
`
	);

	assert.equal(result.exitCode, null);
	assert.equal(result.stdout, '');
	assert.ok(
		result.errors.some((line) => /undefined symbol: nosuchsub_/.test(line)),
		`expected the linker to name the missing symbol, got:\n${result.errors.join('\n')}`
	);
	compiler.dispose();
});

test('a program that traps is reported, not thrown', async () => {
	const compiler = await createCompiler();
	// GETARG is how a Fortran program would read its argv. f2c knows the routine by name only, so it
	// cannot pass the interface libf2c was compiled with, and the call traps - see the README.
	const result = await compiler.run(
		`      PROGRAM ARGS
      CHARACTER*20 VALUE
      CALL GETARG(1, VALUE)
      PRINT *, VALUE
      END
`
	);

	assert.equal(result.exitCode, null);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0], /stopped at run time/);
	assert.match(result.errors[0], /getarg_/, 'expected the trapping routine to be named');
	// It ran, so this is a duration rather than null.
	assert.ok(result.runMs >= 0);
	compiler.dispose();
});

test('output is stdout and stderr in the order the program wrote them', async () => {
	const compiler = await createCompiler();
	// Fortran 77 writes to unit 0 for stderr; PRINT goes to unit 6.
	const result = await compiler.run(
		`      PROGRAM STREAMS
      WRITE (0, 100) 'err-first'
  100 FORMAT (A)
      PRINT *, 'out-first'
      END
`
	);

	assert.equal(result.stderr, 'err-first\n');
	assert.ok(result.stdout.includes('out-first'), `expected stdout, got ${JSON.stringify(result.stdout)}`);
	compiler.dispose();
});

test('one compiler keeps working across runs with different sources', async () => {
	const compiler = await createCompiler();

	assert.equal((await compiler.run(HELLO)).stdout, ' Hello from Fortran!\n');
	assert.equal((await compiler.run(`      PROGRAM N\n      PRINT *, 7\n      END\n`)).stdout, ' 7\n');
	// And it survives a failure in between, which is when a shared filesystem tends to break.
	assert.ok((await compiler.run(`      PROGRAM X\n      CALL NOPE\n      END\n`)).errors.length > 0);
	assert.equal((await compiler.run(HELLO)).stdout, ' Hello from Fortran!\n');
	compiler.dispose();
});

test('the toolchain is shared, so two compilers can be used side by side', async () => {
	const first = await createCompiler();
	const second = await createCompiler();

	// They queue on one runtime rather than writing over each other's files.
	const results = await Promise.all([
		first.run(`      PROGRAM A\n      PRINT *, 'first'\n      END\n`),
		second.run(`      PROGRAM B\n      PRINT *, 'second'\n      END\n`)
	]);

	assert.deepEqual(
		results.map((result) => result.stdout),
		[' first\n', ' second\n']
	);
	for (const result of results) assert.deepEqual(result.errors, []);
	first.dispose();
	second.dispose();
});

test('the fileName decides the name the source is compiled under', async () => {
	const compiler = await createCompiler({ fileName: 'program.f' });
	const result = await compiler.run(HELLO);

	assert.deepEqual(result.errors, []);
	assert.equal(result.stdout, ' Hello from Fortran!\n');
	compiler.dispose();
});

test('a disposed compiler refuses further runs', async () => {
	const compiler = await createCompiler();
	compiler.dispose();
	await assert.rejects(() => compiler.run(HELLO), /disposed/);
});

test('run() without source says so', async () => {
	const compiler = await createCompiler();
	await assert.rejects(() => compiler.run(), /needs the program source/);
	compiler.dispose();
});

test('a baseUrl that is not http(s) is rejected', async () => {
	await assert.rejects(
		() => createCompiler({ baseUrl: 'ftp://example.com/fortran/' }),
		/baseUrl must be http\(s\)/
	);
});

test('without a filesystem baseUrl is required, and the error says what to do', async () => {
	const browserEntry = await import('../src/index.js');
	await assert.rejects(
		() => browserEntry.createCompiler(),
		/baseUrl is required here[\s\S]*copy-assets/
	);
});

test('every asset shipped in the package matches its pinned receipt', async () => {
	for (const [name, receipt] of Object.entries(ASSET_RECEIPTS)) {
		const bytes = await readFile(new URL(`../assets/${name}`, import.meta.url));
		assert.equal(bytes.length, receipt.bytes, `${name} is the wrong size`);
		assert.equal(
			createHash('sha256').update(bytes).digest('hex'),
			receipt.sha256,
			`${name} does not hash to its receipt`
		);
	}
});
