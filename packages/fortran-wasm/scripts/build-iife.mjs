// Builds the IIFE bundle: one classic script for workers and pages that cannot use ES modules.
//
//   npm run build:iife
//
// The output is committed, because a classic worker can only `importScripts()` a URL and consumers
// should not need a bundler to get one. It is built from `src/index.js`, the browser entry, so it
// never pulls in the Node-only packaged-assets code.
//
// The bundle is not small, and it is not supposed to be: it contains the Clang runtime this package
// compiles through, which is the same ~296 KB the clang-wasm bundle carries. A consumer that only
// needs the ES module never pays for it.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outfile = fileURLToPath(new URL('../dist/fortran-wasm.global.js', import.meta.url));

const banner = `/*! @live-codes/fortran-wasm - MIT. IIFE build, sets self.fortranWasm.
 *  importScripts('fortran-wasm.global.js') then self.fortranWasm.createCompiler({ baseUrl }).
 *  Bundles @live-codes/clang-wasm (MIT) and @wasm-idle/llvm-core (MIT AND Apache-2.0 WITH LLVM-exception),
 *  @bjorn3/browser_wasi_shim (MIT OR Apache-2.0) and fflate (MIT). The f2c and libf2c binaries in assets/
 *  are third-party builds - see THIRD-PARTY-NOTICES.md. */`;

await build({
	entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
	outfile,
	bundle: true,
	format: 'iife',
	globalName: 'fortranWasm',
	minify: true,
	platform: 'browser',
	target: 'es2022',
	// Keeps any third-party @license comments in a sidecar rather than in the payload.
	legalComments: 'external',
	banner: { js: banner }
});

console.log(`dist/fortran-wasm.global.js  ${(statSync(outfile).size / 1024).toFixed(1)} KB (minified)`);
