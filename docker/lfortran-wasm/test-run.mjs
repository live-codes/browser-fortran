// Runs Fortran through the built LFortran wasm module, using the same loader the browser does.
//
//   node test-run.mjs
//
// The corpus (corpus.mjs) and the loader (lfortran-loader.mjs) are shared with browser-test.html, so
// this and the browser probe exercise identical code — only the environment differs.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES, stdinFor } from './corpus.mjs';
// The package's loader, not a copy of it: the probe and the shipped package must be the same code.
import { createCompiler } from '../../packages/lfortran-wasm/src/index.js';

const OUT = fileURLToPath(new URL('./out/', import.meta.url));

// An optional base URL, so the same corpus can be run against the assets the *published* package
// serves rather than the local build:
//   node test-run.mjs https://cdn.jsdelivr.net/npm/@live-codes/lfortran-wasm@0.1.0/assets/
const baseUrl = process.argv[2] ?? new URL('./out/', import.meta.url);

const compiler = await createCompiler({ baseUrl });
console.log(`compiler loaded${process.argv[2] ? ` from ${process.argv[2]}` : ''}\n`);

let passed = 0;
let dumped = false;
for (const [name, source] of Object.entries(CASES)) {
	const { stdout, errors, exitCode, runMs } = await compiler.run(source, stdinFor(name));

	const ok = exitCode === 0;
	if (ok) passed += 1;
	console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}  (${Math.round(runMs)} ms)`);
	if (stdout.trim()) console.log(`      ${stdout.trimEnd().split('\n').join('\n      ')}`);
	if (!ok) {
		if (errors) console.log(`      ${errors.trim().split('\n').slice(0, 8).join('\n      ')}`);
		// LFortran prints the whole module to stdout when verification fails
		// (asr_to_llvm.cpp: `v.module->print(os, nullptr); std::cout << os.str();`), so an invalid
		// module shows up as stdout rather than being lost.
		if (!dumped && stdout.includes('define ')) {
			dumped = true;
			const dump = join(OUT, 'invalid.ll');
			await writeFile(dump, stdout);
			console.log(`      (invalid IR written to ${dump})`);
		}
	}
}

console.log(`\n${passed}/${Object.keys(CASES).length} compiled and ran`);
process.exit(passed === Object.keys(CASES).length ? 0 : 1);
