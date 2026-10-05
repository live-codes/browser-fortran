// Runs modern Fortran in the browser or in Node, on LFortran's own wasm backend.
//
// This loads LFortran's *published* wasm build — the same artifact dev.lfortran.org runs — instead of
// shipping one of our own. Four things follow from that, each measured against the published builds:
//
//  1. The build is compiled `-DWITH_LLVM=no`, so LFortran's wasm backend emits a module directly:
//     no LLVM, no LLD, no dlopen, ~12 MiB rather than ~64 MiB, and a compiled program is a few
//     hundred bytes instead of a shared object.
//
//  2. A program is run as a *fresh* WebAssembly instance per run, against a WASI import object. That
//     is what the playground does, and because nothing is shared between runs, state cannot leak from
//     one run into the next. That eliminates a whole class of failure the previous single-module
//     loader had, where a run that read stdin at end-of-file left every later run unable to read.
//
//  3. The compiler module can only be *evaluated* once per realm: its glue declares script-scope
//     bindings, so a second evaluation throws on redeclaration. Compiling many programs through one
//     loaded module is fine — `emit_wasm_from_source` is re-entrant — so the loaded module is cached
//     and shared, keyed by build base URL.
//
//  4. The build is pinned to release e8c53fddf (0.59.0). That is the newest release where
//     list-directed output inside a do loop is still emitted. On 0.60.0 and later, that program
//     compiles and runs and exits 0 but prints nothing — on the wasm backend and on the LLVM backend
//     alike — and the emitted module is smaller than a hello-world's. 0.59.0 is also the smallest of
//     the tested builds. See THIRD-PARTY-NOTICES.md.
//
// Programs that read stdin are not supported: `read` aborts the wasm backend at compile time with
// CodeGenAbort on every published build from 0.52.0 through 0.66.0. fd_read is wired up regardless, so
// a build that does support it needs no change here.
//
// LFortran is BSD-3-Clause (LLVM is not used) — see THIRD-PARTY-NOTICES.md.

const DEFAULT_BUILD = 'https://lfortran.github.io/wasm_builds/release/e8c53fddf/';

const isNode = typeof process !== 'undefined' && process.versions?.node != null;
const decoder = new TextDecoder();

/**
 * One evaluated compiler module per build base URL, per realm.
 *
 * The key is the base URL rather than a simple flag because two different builds can be loaded in one
 * realm only if their glue happens not to clash, which is not something to rely on; sharing a single
 * module per build is. Holding a promise means concurrent callers share one load.
 */
const loaded = new Map();

function buildBase(baseUrl) {
	const base = String(baseUrl ?? DEFAULT_BUILD);
	return base.endsWith('/') ? base : `${base}/`;
}

async function prepareLocalBuild(base, names) {
	// Under Node the glue reads its assets with `fs`, so locateFile must hand back filesystem paths and
	// the files have to exist. Downloading into a cache directory once keeps that transparent: fetching
	// and inflating a gz is not what emscripten's Node path does.
	const { mkdir, writeFile, access } = await import('node:fs/promises');
	const { createHash } = await import('node:crypto');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const digest = createHash('sha256').update(base).digest('hex').slice(0, 16);
	const dir = join(tmpdir(), `lfortran-wasm-${digest}`);
	await mkdir(dir, { recursive: true });
	for (const name of names) {
		const target = join(dir, name);
		try {
			await access(target);
			continue;
		} catch {
			// Not cached yet.
		}
		const response = await fetch(new URL(name, base));
		if (!response.ok) {
			// A build may legitimately have no .data; anything else missing is fatal.
			if (name.endsWith('.data')) continue;
			throw new Error(`fetching ${name} from ${base}: ${response.status} ${response.statusText}`);
		}
		await writeFile(target, Buffer.from(await response.arrayBuffer()));
	}
	return dir;
}

async function loadCompiler(base, { print, printErr } = {}) {
	const names = ['lfortran.js', 'lfortran.wasm', 'lfortran.data'];
	// Resolved here and closed over, rather than inside the download helper: locateFile needs the join
	// too, and node: imports must stay out of a browser bundle's static imports.
	let localDir = null;
	let join = null;
	let gluePath = null;
	if (isNode) {
		({ join } = await import('node:path'));
		const { pathToFileURL, fileURLToPath } = await import('node:url');
		if (base.startsWith('file:')) {
			// A build directory on disk. Nothing to fetch, which is how a freshly built artifact is
			// tested before it is published anywhere.
			localDir = fileURLToPath(base);
		} else {
			localDir = await prepareLocalBuild(base, names);
		}
		// A bare `file://` + a Windows path is not a file URL; the trailing separator makes it worse.
		gluePath = pathToFileURL(join(localDir, 'lfortran.js'));
	}

	const compilerOut = [];
	const compilerErr = [];
	let readyResolve;
	let readyReject;
	const ready = new Promise((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});

	const module = {
		// The CLI is never used: the compiler is driven through its emit entry points, and `noInitialRun`
		// keeps the glue from running main() with an empty command line, which would fail for want of a
		// backend.
		noInitialRun: true,
		print: (line) => compilerOut.push(line),
		printErr: (line) => {
			compilerErr.push(line);
			if (printErr) printErr(line);
		},
		// Set before loading: importScripts is synchronous, so a handler attached afterwards could miss
		// a runtime that was already initialised.
		onRuntimeInitialized: () => readyResolve(),
		onAbort: (reason) => readyReject(new Error(`the compiler aborted while loading: ${reason}`)),
		locateFile: (file) => (localDir ? join(localDir, file) : new URL(file, base).href),
	};

	const glueUrl = new URL('lfortran.js', base).href;
	if (isNode) {
		// The glue is a classic script, so in Node it is evaluated in this realm with Module injected as
		// a global — which is also how the playground loads it, with a script tag. A CommonJS require
		// would not do: its own `var Module` shadows an injected one.
		const { createRequire } = await import('node:module');
		const { readFile } = await import('node:fs/promises');
		const vm = await import('node:vm');
		globalThis.Module = module;
		globalThis.__dirname = localDir;
		globalThis.require = createRequire(import.meta.url);
		vm.runInThisContext(await readFile(gluePath, 'utf8'), { filename: glueUrl });
	} else if (typeof importScripts === 'function') {
		// A classic worker. Their glue is a classic script, so importScripts can load it cross-origin,
		// which is why the loader needs no CORS-blessed ES module loader here.
		self.Module = module;
		importScripts(glueUrl);
	} else {
		// A page. A script tag is the browser's equivalent of importScripts, and gives the glue the
		// global Module it expects.
		globalThis.Module = module;
		await new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = glueUrl;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`could not load the compiler glue from ${glueUrl}`));
			document.head.appendChild(script);
		});
	}

	const timer = setTimeout(() => readyReject(new Error('the compiler never became ready')), 180000);
	await ready;
	clearTimeout(timer);

	let emitWasm;
	try {
		emitWasm = module.cwrap('emit_wasm_from_source', 'string', ['string']);
	} catch {
		throw new Error(
			`the build at ${base} does not export emit_wasm_from_source, so it cannot compile anything`,
		);
	}

	return { module, emitWasm, compilerOut, compilerErr, base };
}

/** The reply is "<status>,<byte>,<byte>,...": a status, then the module. */
function readEmitReply(csv) {
	if (typeof csv !== 'string') {
		return { error: `the compiler returned ${typeof csv} instead of a module` };
	}
	const fields = csv.split(',');
	const status = Number(fields[0]);
	const bytes = Uint8Array.from(fields.slice(1).map(Number));
	if (status !== 0) {
		return { error: csv.slice(0, 2000) };
	}
	if (!(bytes[0] === 0 && bytes[1] === 97 && bytes[2] === 115 && bytes[3] === 109)) {
		return { error: `the compiler did not return a wasm module: ${csv.slice(0, 200)}` };
	}
	return { bytes };
}

class GuestExit extends Error {
	constructor(code) {
		super(`the program exited with status ${code}`);
		this.code = code;
	}
}

/**
 * Run a compiled program as a fresh instance against a WASI import object, which is how the playground
 * runs one. Output is taken from fd_write as it is written; stdin is served from fd_read.
 */
async function runInstance(bytes, stdin, streaming) {
	const programOut = [];
	const programErr = [];
	const encoder = new TextEncoder();
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
					const text = decoder.decode(new Uint8Array(memory.buffer, at, length));
					if (fd === 2) {
						programErr.push(text);
						if (streaming.printErr) streaming.printErr(text);
					} else {
						programOut.push(text);
						if (streaming.print) streaming.print(text);
					}
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

	const startedAt = performance.now();
	try {
		instance.exports._start();
	} catch (error) {
		if (!(error instanceof GuestExit)) throw error;
		exitCode = error.code;
	}
	return {
		stdout: programOut.join(''),
		stderr: programErr.join(''),
		exitCode,
		runMs: performance.now() - startedAt,
	};
}

/**
 * Load the compiler for a build. Load once and reuse it; each `run` reuses the loaded module and
 * costs only a compile and a small instantiation.
 *
 * @param {object} [options]
 * @param {string|URL} [options.baseUrl] the published build directory containing `lfortran.js`,
 *   `lfortran.wasm` and `lfortran.data`. Defaults to the pinned release.
 * @param {(text: string) => void} [options.print]    program output as it is written
 * @param {(text: string) => void} [options.printErr]  program stderr, and the compiler's, as written
 * @returns {Promise<{
 *   build: string,
 *   run: (code: string, stdin?: string) => Promise<{stdout: string, errors: string, exitCode: number|null, runMs: number}>
 * }>}
 */
export async function createCompiler(options = {}) {
	const base = buildBase(options.baseUrl);
	if (!loaded.has(base)) {
		loaded.set(
			base,
			loadCompiler(base, options).catch((error) => {
				// A failed load must not poison the cache, or every later attempt reports the same stale
				// error instead of retrying.
				loaded.delete(base);
				throw error;
			}),
		);
	}
	const compiler = await loaded.get(base);
	const streaming = { print: options.print, printErr: options.printErr };

	return {
		build: base,

		/**
		 * Compile and run one Fortran program.
		 *
		 * `exitCode` is the program's own exit status — 0 when it ran to completion — and null when it
		 * did not compile. A compile error is reported in `errors`, never thrown.
		 */
		async run(code, stdin = '') {
			const startedAt = performance.now();
			compiler.compilerOut.length = 0;
			compiler.compilerErr.length = 0;

			let reply;
			try {
				reply = compiler.emitWasm(code);
			} catch (error) {
				// The wasm backend throws rather than returning status for constructs it cannot lower,
				// `read` among them. That is a compile error like any other, so it is reported, not
				// thrown — and the module stays usable for the next program.
				const detail = compiler.compilerErr.join('\n');
				const name = Array.isArray(error?.message) ? error.message[0] : (error?.message ?? error);
				return {
					stdout: '',
					errors: detail || `the compiler could not compile this program (${name})`,
					exitCode: null,
					runMs: performance.now() - startedAt,
				};
			}

			const compiled = readEmitReply(reply);
			if (compiled.error) {
				return {
					stdout: '',
					errors: compiler.compilerErr.join('\n') || compiled.error,
					exitCode: null,
					runMs: performance.now() - startedAt,
				};
			}

			try {
				const result = await runInstance(compiled.bytes, stdin, streaming);
				return {
					stdout: result.stdout,
					errors: result.stderr,
					exitCode: result.exitCode,
					runMs: result.runMs,
				};
			} catch (error) {
				return {
					stdout: '',
					errors: `${error?.message ?? error}`,
					exitCode: null,
					runMs: performance.now() - startedAt,
				};
			}
		},
	};
}

export default createCompiler;
