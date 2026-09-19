import { createToolchain } from '@live-codes/clang-wasm/toolchain';
import { resolveFortranAssets } from './assets.js';
import { mountFortranAssets, runFortran } from './compile.js';

// One prepared toolchain per asset source, shared by every compiler created against it.
//
// The costly part - ~28 MB of Clang, and mounting `f2c`, `libf2c` and `libf2c`'s entry point into
// that runtime's filesystem - happens once. The memfs is shared with every other user of the same
// runtime, so a second copy would be wrong as well as wasteful: adding the same file twice is an
// error.
const entries = new Map();

const DEFAULT_FILE_NAME = 'main.f';

export function createApi({ packaged }) {
	/**
	 * Create a Fortran compiler.
	 *
	 * @param {object} [options]
	 * @param {string} [options.baseUrl] - where the Fortran assets (`f2c.wasm`, `libf2c.a`, `f2c.h`)
	 *   are served from. **Optional in Node**, where the assets that ship in this package are read off
	 *   disk; required anywhere else, and absolute http(s) except in a browser, where it may be
	 *   relative to the page.
	 * @param {string} [options.clangBaseUrl] - where the Clang half is served from. Same rule: optional
	 *   in Node, required in a browser. `npx --package @live-codes/clang-wasm clang-wasm-copy-assets`
	 *   writes that tree.
	 * @param {string} [options.fileName] - the name the source is compiled under, and so the stem of
	 *   everything derived from it. Defaults to `main.f`, which is fixed-form. `.f90` would be a lie:
	 *   f2c is a Fortran 77 translator.
	 * @param {(value: number) => void} [options.onProgress] - Clang asset download progress, 0 to 1.
	 *   The Fortran assets are ~1 MB and are not reported.
	 * @param {number} [options.maxAssetBytes] - ceiling for a decompressed Clang asset.
	 *
	 * There is no `args` option. A program cannot read its own argv: the only way in is `GETARG`, and
	 * a call into the runtime library from generated code traps - see the README.
	 */
	async function createCompiler(options = {}) {
		const assets = resolveFortranAssets(options, packaged);

		// Keyed by both halves: a different Clang base URL means a different runtime, and the Fortran
		// files have to be mounted into each of them.
		const key = `${assets.key}\u0000${options.clangBaseUrl ?? ''}`;

		let pending = entries.get(key);
		if (!pending) {
			pending = prepare(key, assets, options).catch((error) => {
				// A failed load must not poison the cache - the next caller should be able to retry.
				entries.delete(key);
				throw error;
			});
			entries.set(key, pending);
		}
		const entry = await pending;
		entry.references += 1;
		if (options.onProgress) entry.progressSinks.add(options.onProgress);

		const defaults = {
			fileName: options.fileName ?? DEFAULT_FILE_NAME
		};

		let disposed = false;

		return {
			/** The language this compiler runs. */
			language: 'fortran',

			/** The dialect, which is what a caller needs to know to write source for it. */
			dialect: 'fortran77',

			/**
			 * Compile and run a program.
			 *
			 * @param {string} code - the program source, fixed-form Fortran 77.
			 * @param {string|Uint8Array} [input] - stdin, handed to the program once and then closed.
			 * @param {object} [runOptions] - per-run overrides: `fileName`.
			 * @returns {Promise<{stdout: string, stderr: string, output: string, errors: string[],
			 *   exitCode: number|null, compileMs: number, translateMs: number, runMs: number|null}>}
			 *   `output` is stdout and stderr in the order the program wrote them. `errors` holds the
			 *   compiler's diagnostics and is empty when it compiled; `exitCode` is null when the
			 *   program never ran. `translateMs` is the Fortran-to-C step and is part of `compileMs`.
			 */
			async run(code, input, runOptions = {}) {
				if (disposed) throw new Error('This compiler has been disposed.');
				if (typeof code !== 'string') {
					throw new Error('run() needs the program source as its first argument.');
				}
				return runFortran(entry, {
					code,
					input: input ?? '',
					fileName: runOptions.fileName ?? defaults.fileName
				});
			},

			/** Release this compiler's hold on the shared toolchain. Further runs throw. */
			dispose() {
				if (disposed) return;
				disposed = true;
				release(entry, options.onProgress);
			}
		};
	}

	return { createCompiler };
}

async function prepare(key, assets, options) {
	const entry = {
		key,
		references: 0,
		progressSinks: new Set(),
		toolchain: null,
		f2cModule: null
	};
	if (options.onProgress) entry.progressSinks.add(options.onProgress);

	let toolchain;
	try {
		toolchain = await createToolchain({
			baseUrl: options.clangBaseUrl,
			maxAssetBytes: options.maxAssetBytes,
			// Every compiler on this entry gets progress, not just the one that happened to create it.
			onProgress: (value) => {
				for (const sink of entry.progressSinks) sink(value);
			}
		});
	} catch (caught) {
		// Which half failed is not obvious from the asset error, and the fix differs.
		throw new Error(`The Clang half of the toolchain could not be loaded: ${caught.message}`, {
			cause: caught
		});
	}

	entry.toolchain = toolchain;
	entry.f2cModule = await mountFortranAssets(toolchain, assets);
	return entry;
}

function release(entry, progressSink) {
	if (progressSink) entry.progressSinks.delete(progressSink);
	entry.references -= 1;
	if (entry.references <= 0) {
		entries.delete(entry.key);
		entry.toolchain.dispose();
	}
}
