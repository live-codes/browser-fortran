// Runs Fortran through the freshly built LFortran wasm module, the way a browser driver would.
//
//   node test-run.mjs
//
// Expects `out/wasm_run.js`, `out/wasm_run.wasm` and `out/wasm_run.data` from the container. The
// module is `-s MAIN_MODULE=1` with `MODULARIZE=1` and `EXPORT_NAME=createLFortran`, so it exports a
// factory, and the entry point (`run_fortran`, from wasm-run-main.cpp) is reached through `cwrap`.
//
// The corpus lives in corpus.mjs, shared with browser-test.html, so this harness and the browser
// probe judge exactly the same programs.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { CASES, stdinFor } from './corpus.mjs';

// Emscripten's node path reaches for fs/path through require(). Supplied under another name because a
// bare `require` next to top-level await makes node treat the file as ambiguous CommonJS.
const nodeRequire = createRequire(import.meta.url);

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

// Setting `Module.stdin` is not enough: FS.createStandardStreams only creates a device for /dev/stdin
// `if (input)`, and that path sits behind emscripten's compile-time expectToReceiveOnModule('stdin')
// check. Otherwise /dev/stdin is a symlink to /dev/tty, whose fallback reads the *host* process's
// stdin — which is how a stray NUL byte reached Fortran's strtol and produced "Invalid input for
// int32_t". Pointing fd 0 at a MEMFS file instead is deterministic, needs no prompt and is per-run.
export function makeSetStdin(instance) {
	const encoder = new TextEncoder();
	return (text) => {
		const FS = instance.FS;
		if (!FS) throw new Error('FS was not exported, so stdin cannot be wired');
		FS.writeFile('/.stdin', encoder.encode(text));
		const stream = FS.open('/.stdin', 'r');
		if (FS.streams[0]) FS.close(FS.streams[0]);
		FS.streams[0] = stream;
	};
}

async function loadModule() {
	const js = await readFile(join(OUT, 'wasm_run.js'), 'utf8');
	const context = {
		// Emscripten's node path wants these.
		require: nodeRequire,
		module: { exports: {} },
		exports: {},
		__dirname: OUT,
		__filename: join(OUT, 'wasm_run.js'),
		console,
		process,
		Buffer,
		TextDecoder,
		TextEncoder,
		WebAssembly,
		// The vm realm needs the host's error constructors: the wasm objects come from the host's
		// WebAssembly, so a TypeError it throws is not an instance of the vm's TypeError, and
		// emscripten's `err instanceof TypeError` checks in addFunction silently stop matching —
		// which turns a handled case into a raw WebAssembly.Table.set error.
		TypeError,
		RangeError,
		Error,
		fetch,
		URL,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		queueMicrotask,
		performance,
	};
	context.global = context;
	context.globalThis = context;
	vm.createContext(context);
	vm.runInContext(js, context);

	const factory = context.createLFortran ?? context.module.exports;
	if (typeof factory !== 'function') {
		throw new Error('the module did not export a factory (expected createLFortran)');
	}

	const out = [];
	const err = [];
	const instance = await factory({
		locateFile: (path) => join(OUT, path),
		print: (text) => out.push(text),
		printErr: (text) => err.push(text),
	});
	return {
		runFortran: instance.cwrap('run_fortran', 'string', ['string']),
		setStdin: makeSetStdin(instance),
		out,
		err,
	};
}

const { runFortran, setStdin, out, err } = await loadModule();
console.log(`loaded; run_fortran is ${typeof runFortran}\n`);

let passed = 0;
let dumped = false;
for (const [name, source] of Object.entries(CASES)) {
	out.length = 0;
	err.length = 0;
	setStdin(stdinFor(name));

	let status;
	try {
		status = runFortran(source);
	} catch (error) {
		status = `1,threw: ${error.message}`;
	}

	const ok = status === '0';
	if (ok) passed += 1;
	// Emscripten's print callback is invoked once per line, with the newline consumed, so the
	// separator has to be put back rather than joining with ''.
	const stdout = out.join('\n').trimEnd();
	console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}`);
	if (ok) {
		if (stdout) console.log(`      ${stdout.split('\n').join('\n      ')}`);
	} else {
		console.log(`      ${status.slice(0, 300).replace(/\n/g, '\n      ')}`);
		// `asr_to_llvm` prints the whole module to stdout when verification fails
		// (asr_to_llvm.cpp: `v.module->print(os, nullptr); std::cout << os.str();`), so the invalid IR
		// is sitting in the captured output rather than being lost.
		if (!dumped && out.length > 0) {
			dumped = true;
			const dump = join(OUT, 'invalid.ll');
			await writeFile(dump, out.join(''));
			console.log(`      (invalid IR: ${dump}, ${out.join('').length} chars)`);
		}
	}
	if (err.length) console.log(`      [stderr] ${err.join('').slice(0, 200)}`);
}

console.log(`\n${passed}/${Object.keys(CASES).length} compiled and ran`);
