// Runs modern Fortran in the browser or in Node, on LFortran's LLVM backend compiled to WebAssembly.
//
// The module is LFortran (BSD-3-Clause) built with Emscripten against LLVM, linked `-s MAIN_MODULE=1`
// because its executor loads the program it just compiled with `dlopen`. There is no linker
// subprocess in a browser, so compilation and execution both happen in-process. See
// THIRD-PARTY-NOTICES.md. Nothing here is threaded: no pthreads anywhere, so the host needs neither
// SharedArrayBuffer nor cross-origin isolation.
//
// Three details in this loader are load-bearing, each learned the hard way:
//
//  1. The glue is built EXPORT_ES6=1 + MODULARIZE=1, so importing it yields a factory. That is why
//     there is one code path for a page, a worker and Node: the alternative is a script tag in a
//     browser and a `vm` context in Node, and the realm mismatch that creates made a handled
//     TypeError inside emscripten's addFunction surface as a raw WebAssembly.Table.set error.
//
//  2. The wasm ships gzipped. Raw it is 70.75 MiB, past what a CDN will serve for a package file;
//     gzipped it is 19.04 MiB. Decompressing here and passing `wasmBinary` also stops emscripten from
//     fetching the uncompressed file itself. gzip rather than the smaller brotli (12.90 MiB) because
//     DecompressionStream can only do gzip and deflate.
//
//  3. stdin is wired by pointing fd 0 at a MEMFS file, not by setting `Module.stdin`.
//     FS.createStandardStreams only creates a device for /dev/stdin `if (input)`, and that sits
//     behind emscripten's compile-time expectToReceiveOnModule('stdin') check; otherwise /dev/stdin
//     symlinks to /dev/tty, whose fallback reads the host's stdin. That is how a stray NUL byte
//     reached Fortran's strtol and produced `Invalid input for int32_t`.

const isNode = typeof process !== 'undefined' && process.versions?.node != null;

// Emscripten calls `print` and `printErr` once per line, with the newline consumed, so the separator
// has to be put back or consecutive writes run together.
const joinLines = (lines) => lines.join('\n');

async function readGzippedBytes(url) {
	// Node's fetch does not handle file: URLs, so Node reads and inflates directly.
	if (String(url).startsWith('file:')) {
		const { readFile } = await import('node:fs/promises');
		const { gunzipSync } = await import('node:zlib');
		return new Uint8Array(gunzipSync(await readFile(url)));
	}
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`fetching ${url}: ${response.status} ${response.statusText}`);
	}
	const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(decompressed).arrayBuffer());
}

function makeSetStdin(module) {
	const encoder = new TextEncoder();
	return (text) => {
		const FS = module.FS;
		if (!FS) {
			throw new Error('FS was not exported, so stdin cannot be wired');
		}
		FS.writeFile('/.stdin', encoder.encode(text));
		const stream = FS.open('/.stdin', 'r');
		if (FS.streams[0]) {
			FS.close(FS.streams[0]);
		}
		FS.streams[0] = stream;
	};
}

/**
 * Load the compiler. Do this once and reuse it; each `run` is milliseconds.
 *
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] where to fetch `wasm_run.js`, `wasm_run.wasm.gz` and
 *   `wasm_run.data`. Defaults to the assets shipped in this package, which is what a bundler sees;
 *   pass a CDN URL to load them from elsewhere instead.
 * @param {string|URL} [options.glueUrl]   override the emscripten ES module location
 * @param {string|URL} [options.assetBaseUrl] override where `wasm_run.data` is read from
 * @param {string|URL} [options.wasmUrl]   override the gzipped wasm location
 * @param {ArrayBuffer} [options.wasmBinary] already-decompressed wasm, skips the download
 * @param {(line: string) => void} [options.print]    receive program output as it is written
 * @param {(line: string) => void} [options.printErr] receive the runtime's stderr
 * @returns {Promise<{run: (code: string, stdin?: string) => Promise<{stdout: string, errors: string, exitCode: number|null, runMs: number}>}>}
 */
export async function createCompiler(options = {}) {
	const { baseUrl, glueUrl, assetBaseUrl, wasmUrl, wasmBinary, print, printErr } = options;

	const assetBase = new URL(assetBaseUrl ?? (baseUrl ? new URL(baseUrl, import.meta.url) : new URL('../assets/', import.meta.url)), import.meta.url);
	// Under Node, emscripten reads its assets with `fs`, so locateFile has to hand back a filesystem
	// path; in a browser it fetches, so it needs a URL. Returning a file: URL to the Node path gets it
	// concatenated onto the script directory and the read fails.
	const inNode = isNode && assetBase.protocol === 'file:';
	const toPath = inNode ? (await import('node:url')).fileURLToPath : null;
	const locateFile = (name) => {
		const url = new URL(name, assetBase);
		return inNode ? toPath(url) : url.href;
	};

	const stdout = [];
	const stderr = [];
	const binary = wasmBinary ?? (await readGzippedBytes(new URL(wasmUrl ?? 'wasm_run.wasm.gz', assetBase)));
	const glue = await import(new URL(glueUrl ?? 'wasm_run.js', assetBase).href);
	const factory = glue.default ?? glue.createLFortran;
	if (typeof factory !== 'function') {
		throw new Error('the glue module did not export a factory');
	}

	const module = await factory({
		locateFile,
		wasmBinary: binary,
		print: (line) => (print ? print(line) : stdout.push(line)),
		printErr: (line) => (printErr ? printErr(line) : stderr.push(line)),
	});
	const runFortran = module.cwrap('run_fortran', 'string', ['string']);
	const setStdin = makeSetStdin(module);

	return {
		// The raw emscripten module. Exposed because the virtual filesystem is genuinely useful to a
		// caller: program output files can be read out of it, and inputs written in. It is also how the
		// build probes enumerate what a compiled program imports.
		module,

		/**
		 * Compile and run one Fortran program.
		 *
		 * `exitCode` is 0 when the program ran, and null when it did not — a compile error, or the
		 * program calling exit(). A Fortran exit() arrives as a thrown ExitStatus rather than a
		 * return value, so it is caught here and reported instead of escaping.
		 */
		async run(code, stdin = '') {
			stdout.length = 0;
			stderr.length = 0;
			setStdin(stdin);
			const startedAt = performance.now();
			// A Fortran exit() reaches node as a thrown ExitStatus *and* sets the host process's exit
			// code, which makes a test runner report the whole file as failed even though every test
			// assertion passed. A program run in the sandbox must not decide its host's exit status,
			// so it is put back.
			const hostExitCode = isNode ? process.exitCode : undefined;
			try {
				let status;
				try {
					status = runFortran(code);
				} catch (error) {
					return {
						stdout: joinLines(stdout),
						errors: joinLines(stderr) || `the program terminated: ${error?.message ?? error}`,
						exitCode: null,
						runMs: performance.now() - startedAt,
					};
				}
				if (status === '0') {
					return {
						stdout: joinLines(stdout),
						errors: joinLines(stderr),
						exitCode: 0,
						runMs: performance.now() - startedAt,
					};
				}
				// Everything after the comma is LFortran's own rendered diagnostic.
				return {
					stdout: joinLines(stdout),
					errors: status.replace(/^1,/, '') || joinLines(stderr),
					exitCode: null,
					runMs: performance.now() - startedAt,
				};
			} finally {
				if (isNode) {
					process.exitCode = hostExitCode;
				}
			}
		},
	};
}

export default createCompiler;
