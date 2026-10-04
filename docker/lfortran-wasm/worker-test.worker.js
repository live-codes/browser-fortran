// Runs the corpus in a Web Worker, importing the *published* package from jsDelivr — the way LiveCodes
// loads a language runtime.
//
// The import is dynamic and falls back to the local package, deliberately. A static cross-origin
// import happens before any of this file runs, so if it stalls or is refused, the worker simply never
// posts anything and there is nothing to diagnose. This way the worker reports which source it used
// and why the CDN failed, and the worker path itself is still verified either way.
import { CASES, stdinFor } from './corpus.mjs';

const CDN = 'https://cdn.jsdelivr.net/npm/@live-codes/lfortran-wasm@0.1.0/src/index.js';
const LOCAL = './../../packages/lfortran-wasm/src/index.js';

async function loadPackage() {
	try {
		const { createCompiler } = await import(CDN);
		return { createCompiler, source: `jsDelivr (${CDN})`, cdnError: null };
	} catch (error) {
		const { createCompiler } = await import(LOCAL);
		return {
			createCompiler,
			source: `the local package, after the CDN import failed (${error?.message ?? error})`,
			cdnError: `${error?.message ?? error}`,
		};
	}
}

async function main() {
	postMessage({ stage: 'worker started' });
	const { createCompiler, source, cdnError } = await loadPackage();
	postMessage({ stage: `imported ${source}` });

	const startedAt = performance.now();
	const compiler = await createCompiler();
	const loadMs = Math.round(performance.now() - startedAt);

	const failures = [];
	let passed = 0;
	const slowest = { name: '', runMs: 0 };
	for (const [name, source_] of Object.entries(CASES)) {
		const { exitCode, errors, runMs } = await compiler.run(source_, stdinFor(name));
		if (exitCode === 0) passed += 1;
		else failures.push(`${name}: ${(errors || 'no diagnostic').split('\n')[0]}`);
		if (runMs > slowest.runMs) {
			slowest.name = name;
			slowest.runMs = runMs;
		}
	}

	postMessage({
		passed,
		total: Object.keys(CASES).length,
		failures,
		loadMs,
		slowest,
		source,
		cdnError,
		scope: typeof window === 'undefined' ? 'worker' : 'page',
	});
}

main().catch((error) => {
	postMessage({ failed: `${error?.message ?? error}` });
});
