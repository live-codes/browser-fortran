// The Fortran driver: everything that is specific to compiling Fortran through Clang rather than
// being Clang's own language. It is the same shape as the Objective-C driver in
// `@live-codes/clang-wasm`, for the same reason - a language whose entry point and link line the
// runtime does not know about has to supply both.
import { CLANG_DRIVER_DEFAULT_ARGS, compilerDiagnostics } from '@live-codes/clang-wasm/toolchain';
import { cleanProgramOutput, makeStdin } from './output.js';

/**
 * f2c emits calls that the reference libf2c expects from the host platform: the newlib spellings
 * `fiprintf`, `siprintf` and `__small_sprintf`, plus `signal`. Without them the linked module fails
 * to instantiate. `tmpfile` returns NULL because a WASI module has nowhere to put one.
 *
 * `__SIG_IGN` is the other half of that: libf2c's `main.o` passes newlib's signal-ignore sentinel to
 * `signal()`, and records it as a *function* symbol, so it has to exist as one for the entry point to
 * link at all - declaring it as data is rejected with `symbol type mismatch`. WASI has no signals and
 * the `signal` shim discards the handler, so a no-op is the entire requirement.
 */
const COMPAT_SOURCE = `#include <stdarg.h>
#include <stdio.h>

typedef void (*sighandler_t)(int);

void __SIG_IGN(int signum) {
    (void)signum;
}

int fiprintf(FILE *stream, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int result = vfprintf(stream, format, ap);
    va_end(ap);
    return result;
}

int siprintf(char *str, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int result = vsprintf(str, format, ap);
    va_end(ap);
    return result;
}

int __small_sprintf(char *str, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int result = vsprintf(str, format, ap);
    va_end(ap);
    return result;
}

sighandler_t signal(int signum, sighandler_t handler) {
    (void)signum;
    return handler;
}

FILE *tmpfile(void) {
    return NULL;
}
`;

const LIBF2C_ENTRY_MEMBER = 'main.o';
const LIBF2C_ENTRY_OBJECT = 'libf2c_main.o';
const COMPAT_SOURCE_NAME = 'f2c_compat.c';
const COMPAT_OBJECT = 'f2c_compat.o';

const ensureTrailingNewline = (source) => (source.endsWith('\n') ? source : `${source}\n`);

const stem = (path) => {
	const base = String(path).split('/').pop() || 'main';
	return base.replace(/\.[^.]+$/, '') || 'main';
};

/**
 * Mounts the Fortran half of the toolchain into the runtime's filesystem and compiles `f2c` itself.
 *
 * Called once per runtime, because the memfs is shared: adding the same file twice is an error, and
 * recompiling `f2c.wasm` for every run would be absurd.
 */
export async function mountFortranAssets(toolchain, assets) {
	const [f2cBytes, libf2cBytes, f2cHeaderBytes] = await Promise.all([
		assets.read('f2c.wasm'),
		assets.read('libf2c.a'),
		assets.read('f2c.h')
	]);

	// The generated C includes "f2c.h" and is linked against libf2c, both from the directory the
	// compiler works in.
	toolchain.addFile('f2c.h', new TextDecoder().decode(f2cHeaderBytes));
	toolchain.addFile('libf2c.a', libf2cBytes);
	toolchain.addFile(LIBF2C_ENTRY_OBJECT, extractArchiveMember(libf2cBytes, LIBF2C_ENTRY_MEMBER));

	return WebAssembly.compile(f2cBytes);
}

/**
 * Pulls one member out of a `!<arch>` archive.
 *
 * libf2c's C entry point only exists as the archive member `main.o`, and the linker will not extract
 * it on its own: the WASI crt references `main` *weakly*, so `wasm-ld` is content to synthesise a
 * trapping stub for it (`undefined_weak:main`) rather than search the archive. Handing the member
 * over as an object file is what actually pulls it in. `-u main` does not do it.
 */
function extractArchiveMember(archive, wanted) {
	const text = (start, length) => new TextDecoder().decode(archive.subarray(start, start + length));
	if (text(0, 8) !== '!<arch>\n') throw new Error('libf2c.a is not an ar archive');

	let longNames = '';
	for (let pos = 8; pos + 60 <= archive.byteLength; ) {
		const rawName = text(pos, 16).trim();
		const size = Number(text(pos + 48, 10).trim());
		const body = archive.subarray(pos + 60, pos + 60 + size);
		pos += 60 + size + (size % 2);

		if (rawName === '//') {
			longNames = new TextDecoder().decode(body);
			continue;
		}
		if (rawName === '/' || rawName === '/SYM64/') continue;

		const name = /^\/\d+$/.test(rawName)
			? longNames.slice(Number(rawName.slice(1))).split('\n')[0].replace(/\/$/, '')
			: rawName.replace(/\/$/, '');

		if (name === wanted) return new Uint8Array(body);
	}
	throw new Error(`libf2c.a has no member named ${wanted}`);
}

/**
 * Compiles and runs one program, holding the runtime for the whole of it.
 *
 * The runtime owns a single filesystem and one compiler process, and a toolchain shares its lock with
 * everything else using it, so translation, linking, reading the artifact back out and running it all
 * happen under one turn.
 */
export async function runFortran(entry, params) {
	const { toolchain, f2cModule } = entry;
	const { code, input, fileName } = params;

	return toolchain.lock(async () => {
		const compileStarted = performance.now();

		// 1. Fortran -> C, by running f2c as a WASI command.
		const command = await toolchain.runCommand(f2cModule, {
			args: [fileName],
			env: { TMPDIR: '/tmp' },
			files: [{ path: fileName, contents: ensureTrailingNewline(code) }],
			programName: 'f2c.wasm'
		});
		const translateMs = Math.round(performance.now() - compileStarted);

		// f2c prefixes its messages with the input file and program unit, and emits that preamble even
		// when it has nothing further to say, so its output is surfaced only when it fails.
		if (command.exitCode) {
			const messages = `${command.stderr}${command.stdout}`.trimEnd();
			return failed(
				[...(messages ? [messages] : []), `f2c exited with ${command.exitCode}`],
				performance.now() - compileStarted,
				translateMs
			);
		}

		const cPath = `${stem(fileName)}.c`;
		const generated = command.readFile(cPath);
		if (!generated) {
			return failed([`f2c did not produce ${cPath}`], performance.now() - compileStarted, translateMs);
		}

		// 2 and 3. Compile the generated C and link it into a WASI module.
		const built = await toolchain.captureCompilerOutput(() =>
			compileAndLink(toolchain, { cPath, cSource: new TextDecoder().decode(generated) })
		);
		const compileMs = Math.round(performance.now() - compileStarted);

		if (built.error) {
			// clang's and wasm-ld's own words, once the runtime's log lines and ANSI colour are taken
			// out of them. If they said nothing, the failure was the runtime's own.
			const diagnostics = compilerDiagnostics(built.raw);
			return failed(
				diagnostics.length ? diagnostics : [String(built.error?.message ?? built.error)],
				compileMs,
				translateMs
			);
		}

		// 4. Run it.
		const order = [];
		const stdout = [];
		const stderr = [];
		const runStarted = performance.now();
		const collect = {
			stdin: makeStdin(input),
			stdout: (chunk) => {
				order.push(chunk);
				stdout.push(chunk);
			},
			stderr: (chunk) => {
				order.push(chunk);
				stderr.push(chunk);
			}
		};

		try {
			const result = await toolchain.execute(built.result, collect);
			return {
				// `output` is the two streams in the order the program wrote them, which is what a
				// terminal would have shown.
				stdout: cleanProgramOutput(stdout.join('')),
				stderr: cleanProgramOutput(stderr.join('')),
				output: cleanProgramOutput(order.join('')),
				errors: [],
				exitCode: result.exitCode,
				compileMs,
				translateMs,
				runMs: Math.round(performance.now() - runStarted)
			};
		} catch (error) {
			// A WebAssembly trap is a real way for a Fortran program to end here, and it is the
			// program's problem rather than the caller's - so it comes back as a result, with whatever
			// the program managed to print, instead of as a rejection.
			return {
				stdout: cleanProgramOutput(stdout.join('')),
				stderr: cleanProgramOutput(stderr.join('')),
				output: cleanProgramOutput(order.join('')),
				errors: [describeTrap(error)],
				exitCode: null,
				compileMs,
				translateMs,
				runMs: Math.round(performance.now() - runStarted)
			};
		}
	});
}

async function compileAndLink(toolchain, { cPath, cSource }) {
	const { runtime } = toolchain;
	const mainObject = `${stem(cPath)}.o`;
	const wasmPath = `${stem(cPath)}.wasm`;

	// `-I.` because the generated C includes "f2c.h" from the filesystem root, and `-w` because f2c's
	// output warns freely and none of it is the user's doing. `CLANG_DRIVER_DEFAULT_ARGS` first,
	// because compiling through the runtime's frontend does not get the defaults clang's driver would
	// have supplied - see that export's note in `@live-codes/clang-wasm`.
	await runtime.compile({
		input: cPath,
		code: cSource,
		obj: mainObject,
		language: 'C',
		compileArgs: [...CLANG_DRIVER_DEFAULT_ARGS, '-I.', '-w']
	});
	await runtime.compile({
		input: COMPAT_SOURCE_NAME,
		code: COMPAT_SOURCE,
		obj: COMPAT_OBJECT,
		language: 'C',
		compileArgs: [...CLANG_DRIVER_DEFAULT_ARGS, '-w']
	});

	// f2c emits `MAIN__` and nothing else; the C `main` that sets up the runtime and calls it is
	// libf2c's, mounted as LIBF2C_ENTRY_OBJECT. See `extractArchiveMember` for why it is handed over
	// as an object rather than left to the archive.
	const libdir = 'lib/wasm32-wasi';
	const compilerRuntimeLibDir =
		runtime.compilerConfig?.compilerRuntimeLibDir || 'lib/clang/8.0.1/lib/wasi';
	const lld = await runtime.getModule(runtime.assetUrls.lld);
	await runtime.run(
		lld,
		runtime.log,
		'wasm-ld',
		'--export-dynamic',
		'-z',
		'stack-size=1048576',
		`-L${libdir}/noeh`,
		`-L${libdir}`,
		`${libdir}/crt1.o`,
		mainObject,
		COMPAT_OBJECT,
		LIBF2C_ENTRY_OBJECT,
		'libf2c.a',
		'-lc',
		'-lm',
		`-L${compilerRuntimeLibDir}`,
		'-lclang_rt.builtins-wasm32',
		'-o',
		wasmPath
	);

	const bytes = Uint8Array.from(runtime.memfs.getFileContents(wasmPath));
	return {
		bytes,
		wasm: await WebAssembly.compile(bytes),
		target: 'wasm32-wasi',
		format: 'wasi-core-wasm',
		fileName: wasmPath,
		language: 'C'
	};
}

const failed = (errors, compileMs, translateMs) => ({
	stdout: '',
	stderr: '',
	output: '',
	errors,
	exitCode: null,
	compileMs: Math.round(compileMs),
	translateMs,
	runMs: null
});

/**
 * Turns a WebAssembly trap into something a person can act on.
 *
 * On its own the message is `unreachable`, which says nothing. The trap a Fortran program reliably
 * produces here is a call into the runtime library whose signature the generated code got wrong: f2c
 * knows those routines by name only, so it cannot pass the interface libf2c was compiled with, and
 * wasm-ld answers with a stub that traps. `GETARG` and the library's own error paths are the ones
 * that matter. The routine's name is in the stack and nowhere else, so this reads it from there -
 * a heuristic, but a silent `unreachable` is worse, and a test pins it.
 */
function describeTrap(error) {
	const message = error instanceof Error ? error.message : String(error);
	const mismatch = /signature_mismatch:([A-Za-z0-9_]+)/.exec(String(error?.stack ?? ''));
	if (!mismatch) return `The program stopped at run time: ${message}`;
	return (
		`The program stopped at run time: it called the runtime library routine \`${mismatch[1]}\`, ` +
		`which this toolchain cannot call from generated code. ${message}`
	);
}
