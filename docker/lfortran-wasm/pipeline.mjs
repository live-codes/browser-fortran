// The loader core, against a chosen build.
//
//   node pipeline.mjs [<type>/<commit>]        e.g. release/b5e05bd3a, dev/d981ac1f4
//
// Compiles with the build's own emit entry point, instantiates the result with a WASI import object
// and runs it with _start(). A fresh instance per run is what makes the earlier stdin state bug
// impossible. Run against the build the user's playground reports (b5e05bd3a, 0.52.0) and against the
// newest dev build, to tell whether the do-loop output loss is a regression.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ref = process.argv[2] ?? 'dev/d981ac1f4';
const BASE = `https://lfortran.github.io/wasm_builds/${ref}/`;
const cache = new URL(`./official-${ref.replace('/', '-')}/`, import.meta.url);
const dir = fileURLToPath(cache);
mkdirSync(cache, { recursive: true });
console.log(`build: ${ref}`);
for (const name of ['lfortran.js', 'lfortran.wasm', 'lfortran.data']) {
	const target = new URL(name, cache);
	if (existsSync(target)) {
		console.log(`  cached  ${name}`);
		continue;
	}
	const response = await fetch(BASE + name);
	if (!response.ok) {
		console.log(`  MISSING ${name}: HTTP ${response.status}`);
		continue;
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	writeFileSync(target, bytes);
	console.log(`  fetched ${name}: ${(bytes.length / 1048576).toFixed(2)} MiB`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const compilerErr = [];
const Module = {
	noInitialRun: true,
	print: () => {},
	printErr: (line) => compilerErr.push(line),
	locateFile: (file) => dir + file,
};
globalThis.Module = Module;
globalThis.__dirname = dir;
globalThis.require = createRequire(import.meta.url);
vm.runInThisContext(readFileSync(new URL('lfortran.js', cache), 'utf8'), { filename: 'lfortran.js' });
await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('never became ready')), 600000);
	Module.onRuntimeInitialized = () => {
		clearTimeout(timer);
		resolve();
	};
});

let emitWasm = null;
try {
	emitWasm = Module.cwrap('emit_wasm_from_source', 'string', ['string']);
} catch (error) {
	console.log(`emit_wasm_from_source unavailable: ${error.message}`);
	const emits = Object.getOwnPropertyNames(Module).filter((name) => name.startsWith('_emit_'));
	console.log(`  it exports instead: ${emits.join(', ') || 'nothing emit-shaped'}`);
}
console.log('');

const compile = (source) => {
	compilerErr.length = 0;
	if (!emitWasm) {
		return { error: 'this build has no emit_wasm_from_source' };
	}
	let csv;
	try {
		csv = emitWasm(source);
	} catch (error) {
		return { error: `the compiler threw: ${error.message ?? error}` };
	}
	if (typeof csv !== 'string') {
		return { error: `unexpected compiler output type: ${typeof csv}` };
	}
	const fields = csv.split(',');
	const status = Number(fields[0]);
	const bytes = Uint8Array.from(fields.slice(1).map(Number));
	if (status !== 0) {
		return { error: `status ${status}: ${csv.slice(0, 300)} | ${compilerErr.join('\n').slice(0, 200)}` };
	}
	if (!(bytes[0] === 0 && bytes[1] === 97 && bytes[2] === 115 && bytes[3] === 109)) {
		return { error: `not a wasm module: ${csv.slice(0, 200)}` };
	}
	return { bytes };
};

class GuestExit {
	constructor(code) {
		this.code = code;
	}
}

const instantiate = async (bytes, stdin) => {
	const stdout = [];
	const stderr = [];
	const input = encoder.encode(stdin ?? '');
	let inputAt = 0;
	let memory = null;
	let exitCode = 0;

	const { instance } = await WebAssembly.instantiate(bytes, {
		wasi_snapshot_preview1: {
			fd_write: (fd, iovs, count, writtenPtr) => {
				const view = new DataView(memory.buffer);
				let written = 0;
				for (let i = 0; i < count; i += 1) {
					const at = view.getUint32(iovs + i * 8, true);
					const length = view.getUint32(iovs + i * 8 + 4, true);
					(fd === 2 ? stderr : stdout).push(decoder.decode(new Uint8Array(memory.buffer, at, length)));
					written += length;
				}
				view.setUint32(writtenPtr, written, true);
				return 0;
			},
			fd_read: (fd, iovs, count, readPtr) => {
				const view = new DataView(memory.buffer);
				let read = 0;
				for (let i = 0; i < count; i += 1) {
					const at = view.getUint32(iovs + i * 8, true);
					const length = view.getUint32(iovs + i * 8 + 4, true);
					const take = Math.max(0, Math.min(length, input.length - inputAt));
					if (take > 0) {
						new Uint8Array(memory.buffer, at, take).set(input.subarray(inputAt, inputAt + take));
						inputAt += take;
						read += take;
					}
				}
				view.setUint32(readPtr, read, true);
				return 0;
			},
			proc_exit: (code) => {
				exitCode = code;
				throw new GuestExit(code);
			},
		},
	});
	memory = instance.exports.memory;
	const started = performance.now();
	try {
		instance.exports._start();
	} catch (error) {
		if (!(error instanceof GuestExit)) throw error;
		exitCode = error.code;
	}
	return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode, runMs: performance.now() - started };
};

const run = async (label, source, stdin, expect) => {
	const compiled = compile(source);
	if (compiled.error) {
		console.log(`--- ${label}: compilation failed`);
		console.log(`    ${compiled.error.split('\n')[0].slice(0, 220)}`);
		return;
	}
	let result;
	try {
		result = await instantiate(compiled.bytes, stdin);
	} catch (error) {
		console.log(`--- ${label}: the program failed — ${error.message ?? error}`);
		return;
	}
	const flat = result.stdout.trim().replace(/\s+/g, ' ');
	console.log(`--- ${label}: ${compiled.bytes.length} bytes, exit=${result.exitCode}, ${result.runMs.toFixed(1)} ms`);
	console.log(`    stdout: ${JSON.stringify(flat)}`);
	console.log(`    expected ${JSON.stringify(expect)}: ${flat === expect ? 'OK' : 'MISMATCH'}`);
};

await run(
	'do-loop print',
	`program p\ninteger :: i\ndo i = 1, 3\n   print *, i\nend do\nend program\n`,
	'',
	'1 2 3',
);
// Scope of the breakage: is it printing inside a loop specifically, or loop bodies generally, or
// programs with declarations at all? The emitted module for the loop case is 644 bytes, smaller than
// a hello-world's 701, which points at the body being dropped at codegen.
await run(
	'declaration and assignment, no loop',
	`program p\ninteger :: i\ni = 5\nprint *, i\nend program\n`,
	'',
	'5',
);
await run(
	'loop whose body does not print',
	`program p\ninteger :: i, total\ntotal = 0\ndo i = 1, 3\n   total = total + i\nend do\nprint *, total\nend program\n`,
	'',
	'6',
);
await run(
	'print after an empty loop',
	`program p\ninteger :: i\ndo i = 1, 2\nend do\nprint *, 'done'\nend program\n`,
	'',
	'done',
);
await run('hello', `program p\nprint *, 'Hello, Fortran!'\nend program\n`, '', 'Hello, Fortran!');
await run(
	'reading stdin',
	`program p\ninteger :: a\nread *, a\nprint *, a * 2\nend program\n`,
	'21\n',
	'42',
);
