// Builds the IIFE bundle: one classic script for workers and pages that cannot use ES modules.
//
//   npm run build:iife
//
// Why this exists: `importScripts()` evaluates a *classic* script, and an ES module is not one. Measured
// in Chromium, against the same CDN — importing the clang package's IIFE works, while importing our
// `assets/wasm_run.js` fails with a NetworkError precisely because it is a module. The glue can stay a
// module (this bundle reaches it with dynamic import(), which a classic worker supports), but the
// loader itself has to have a classic form for `importScripts` to be able to load anything.
//
// The output is committed, because a classic worker can only point at a URL and a consumer should not
// need a bundler to get one.
//
// `import.meta.url` is defined rather than left to the bundler: esbuild has no meaning for it in an
// IIFE, and the loader uses it for its default asset base. Pointing it at this package's `src/index.js`
// on jsDelivr makes the default resolve to `.../assets/` there, which is what a consumer of the global
// build wants; `baseUrl` still overrides it, which is how the local build is tested.
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(
	readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);
const sourceUrl = `https://cdn.jsdelivr.net/npm/${packageJson.name}@${packageJson.version}/src/index.js`;
const outfile = fileURLToPath(new URL('../dist/lfortran-wasm.global.js', import.meta.url));

// esbuild is a devDependency of this package. In this repository the sibling package already has it
// installed, so fall back to that rather than requiring a network install to build.
async function loadEsbuild() {
	try {
		return await import('esbuild');
	} catch {
		// A file: URL, not a path — on Windows a bare `D:\...` is read as a URL scheme.
		const sibling = new URL('../../fortran-wasm/node_modules/esbuild/lib/main.js', import.meta.url);
		return import(sibling.href);
	}
}

const { build } = await loadEsbuild();

const banner = `/*! ${packageJson.name} - MIT. IIFE build, sets self.lfortranWasm.
 *  importScripts('lfortran-wasm.global.js') then self.lfortranWasm.createCompiler({ baseUrl }).
 *  Downloads the LFortran + LLVM wasm from assets/ (19 MiB compressed). LFortran is BSD 3-Clause and
 *  LLVM is Apache-2.0 WITH LLVM-exception - see THIRD-PARTY-NOTICES.md. */`;

await build({
	entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
	outfile,
	bundle: true,
	format: 'iife',
	globalName: 'lfortranWasm',
	minify: true,
	platform: 'browser',
	target: 'es2022',
	// Node-only paths in the loader are behind a runtime check and never taken in a browser, so they are
	// left as imports rather than bundled.
	external: ['node:*'],
	define: { 'import.meta.url': JSON.stringify(sourceUrl) },
	legalComments: 'external',
	banner: { js: banner },
});

console.log(`dist/lfortran-wasm.global.js  ${(statSync(outfile).size / 1024).toFixed(1)} KB (minified)`);
console.log(`default asset base: ${new URL('../assets/', sourceUrl).href}`);
