// A CLASSIC worker (note: no `type: module` on the Worker constructor that starts this file).
//
//   new Worker('./worker-classic.js')            <- not { type: 'module' }
//
// Two things are being established here, and the second is the point.
//
// 1. A classic worker can still load the ES module package, because dynamic `import()` is available in
//    classic workers as well as module ones. So no new artifact is needed to run the compiler off the
//    main thread in the classic-worker shape.
//
// 2. `importScripts` cannot load the emscripten glue, even cross-origin. The glue is built with
//    EXPORT_ES6=1 — an ES module with a default export — and importScripts evaluates a script, so it
//    needs the classic form (`EXPORT_ES6=0`, a `createLFortran` global). That is the real cost of the
//    importScripts route, and the probe reports what actually happens rather than assuming it.
//
// This file is deliberately not a module: no `import`/`export` at the top level, only `self`, and
// dynamic import() for the rest.
const CDN = 'https://cdn.jsdelivr.net/npm/@live-codes/lfortran-wasm@0.1.0';
const LOCAL_BASE = 'http://localhost:8132/docker/lfortran-wasm/out/';

async function main() {
	postMessage({ stage: 'classic worker started' });

	// (2) Can importScripts load the glue, and can it load a classic script cross-origin at all? The
	// second question is what separates "our glue is an ES module" from "cross-origin importScripts is
	// blocked here". The clang package ships a classic IIFE build, so it is the control.
	const tryImport = (url) => {
		try {
			importScripts(url);
			return 'loaded';
		} catch (error) {
			return `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
		}
	};
	const control = tryImport('https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@0.2.0/dist/clang-wasm.global.js');
	postMessage({ stage: `importScripts control (clang IIFE) -> ${control}` });
	const importScriptsResult = tryImport(`${CDN}/assets/wasm_run.js`);
	postMessage({ stage: `importScripts on our glue -> ${importScriptsResult}` });

	// (1) The actual path: dynamic import, which works here.
	const { createCompiler } = await import(`${CDN}/src/index.js`);
	const { CASES, stdinFor } = await import('./corpus.mjs');
	postMessage({ stage: 'imported the package and the corpus with dynamic import()' });

	const startedAt = performance.now();
	// Local assets, so this measures the worker rather than the link — the CDN path is already covered
	// by worker-test.worker.js, which takes ~67 s to download from here.
	const compiler = await createCompiler({ baseUrl: LOCAL_BASE });
	const loadMs = Math.round(performance.now() - startedAt);

	const failures = [];
	let passed = 0;
	for (const [name, source] of Object.entries(CASES)) {
		const { exitCode, errors } = await compiler.run(source, stdinFor(name));
		if (exitCode === 0) passed += 1;
		else failures.push(`${name}: ${(errors || 'no diagnostic').split('\n')[0]}`);
	}

	// (3) The importScripts route proper: load the classic IIFE build and run the corpus through the
	// global it defines. This is the shape a host needs when its worker plumbing has no ES module
	// support. The local build is used because the published 0.1.0 predates `dist/`.
	let iife;
	try {
		importScripts('http://localhost:8132/packages/lfortran-wasm/dist/lfortran-wasm.global.js');
		const globalCompiler = await self.lfortranWasm.createCompiler({ baseUrl: LOCAL_BASE });
		let ok = 0;
		for (const [name, source] of Object.entries(CASES)) {
			const { exitCode } = await globalCompiler.run(source, stdinFor(name));
			if (exitCode === 0) ok += 1;
		}
		iife = `loaded the IIFE, then ran ${ok}/${Object.keys(CASES).length} through self.lfortranWasm`;
	} catch (error) {
		iife = `failed: ${error?.message ?? error}`;
	}
	postMessage({ stage: `importScripts route -> ${iife}` });

	postMessage({
		passed,
		total: Object.keys(CASES).length,
		failures,
		loadMs,
		importScriptsResult,
		scope: typeof window === 'undefined' ? 'classic worker' : 'page',
	});
}

main().catch((error) => {
	postMessage({ failed: `${error?.name ?? ''} ${error?.message ?? error}` });
});
