# @live-codes/lfortran-wasm

Run modern Fortran in the browser or in Node, on **LFortran**'s LLVM backend compiled to WebAssembly.
No server, no transpiler step, and no cross-origin isolation: nothing in the pipeline is threaded, so
no `SharedArrayBuffer` is involved.

```js
import { createCompiler } from '@live-codes/lfortran-wasm';

const compiler = await createCompiler();          // once; each run is milliseconds after this
const { stdout, errors, exitCode } = await compiler.run(`
program hello
print *, 'hello from LFortran'
end program
`);

console.log(exitCode, stdout);                    // 0  'hello from LFortran\n'
```

## Why this LFortran, and why one pass is skipped

There are two ways to build LFortran for wasm, and neither released artifact was usable on its own.

**Every published build** — `lfortran.github.io/wasm_builds`, which is what dev.lfortran.org runs — is
built `-DWITH_LLVM=no`. LFortran's own wasm backend emits a module directly: small, fast, and unable to
compile ordinary modern Fortran. Measured against release `e8c53fddf` (0.59.0):

| feature | wasm backend (every published build) | LLVM backend |
| --- | --- | --- |
| derived-type member access (`q%x`) | `visit_StructInstanceMember() not implemented` | works |
| array section (`a(2:3)`) | `visit_ArraySection() not implemented` | works |
| allocatable array (`allocate(v(3))`) | `visit_Allocate() not implemented` | works |
| `read` / stdin | aborts with `CodeGenAbort` | works |
| `print *` inside a `do` loop | works | **loses the print, from 0.60.0** |

Those gaps are not fixed on `main`; they are the same at `0.66.0-602-gd981ac1f4`, where the diagnostics
have degraded from named `visit_X() not implemented` to a bare `LCompilersException`.

**And the LLVM backend drops `print *` inside a `do` loop from 0.60.0 onward.** Same pipeline, same
program, only the build changed:

| release | wasm | `do` loop with `print *` |
| --- | --- | --- |
| 0.52.0 | 22.32 MiB | `1 2 3` |
| 0.59.0 | 11.75 MiB | `1 2 3` |
| 0.60.0 | 12.00 MiB | nothing |
| 0.63.0 | 13.65 MiB | nothing |
| 0.66.0 / current `dev` | 16.62 / 17.60 MiB | nothing |

"Nothing" is a silent success: the program compiles, runs, exits 0, and prints nothing. The emitted
module comes out **smaller than a hello-world's** — 644 bytes against 898 — so the statement is dropped
at codegen rather than lost at run time.

**It is one pass, and skipping it costs nothing.** `PassManager` exposes exactly one public lever for
this — `passes_to_skip_with_llvm`, which `parse_pass_arg()` folds into `_skip_passes` and
`apply_passes()` honours — so the entry point skips `print_arr` at run time. A pass-by-pass bisect
through all thirty-seven defaults against a 0.66.0 module says that pass and no other: skipping
`print_arr` restores `1 2 3`, skipping each of the other thirty-six does not. Between 0.59.0 and 0.60.0
the only print-related pass that changed is `print_arr.cpp`, which gained implied-do-loop expansion — a
redundancy that is also wrong.

Nothing is lost by skipping it, measured case by case: whole-array prints, array sections, allocatable
prints and derived types are all byte-identical, because `print_list_tuple` already covers them. Two
cases change for the better — a scalar `print *` in a loop, and a mixed list in a loop, both of which
printed nothing before.

So the shipped artifact is **0.66.0's LLVM backend with that one pass skipped** — the only build that is
both complete and correct. 0.59.0's LLVM backend was tried first and abandoned: that ref has no wasm run
path at all, only the ORC JIT, which cannot exist in wasm.

## API

### `createCompiler(options?) → Promise<compiler>`

| option | meaning |
| --- | --- |
| `baseUrl` | where to fetch `wasm_run.js`, `wasm_run.wasm.gz` and `wasm_run.data`. Defaults to the assets shipped in this package, which is what a bundler resolves; pass a CDN URL to load them from elsewhere |
| `glueUrl`, `assetBaseUrl`, `wasmUrl` | finer-grained overrides if the three assets do not sit together |
| `wasmBinary` | an already-decompressed `ArrayBuffer`, which skips the download entirely |
| `print`, `printErr` | receive output as it is written, instead of collecting it into the result |

### `compiler.run(code, stdin = '') → Promise<{ stdout, errors, exitCode, runMs }>`

`exitCode` is `0` when the program ran, and `null` when it did not — a compile error, or the program
calling `exit()`. Compile failures put LFortran's own rendered diagnostic in `errors`; they do not
throw.

A successful run has **empty** `errors`. The program's stderr is returned as `errors`, so the entry
point deliberately writes nothing there — a configuration note would otherwise appear as a diagnostic
on a program that worked perfectly.

One compiler is meant to be reused: it holds the loaded module, and `run` compiles a fresh program each
time. Each run links its program as a separate wasm side module, which the module's executor loads;
those live for the lifetime of the loaded compiler, which is why a long-lived page should create one
and reuse it rather than one per keystroke.

### Classic workers

A page or a module worker imports the package directly. A **classic** worker can use it too, because
dynamic `import()` is available in classic workers as well — `await import(packageUrl)` works.

If a host can only use `importScripts`, there is a classic IIFE build for that:

```js
// in a classic (non-module) worker
importScripts('https://cdn.jsdelivr.net/npm/@live-codes/lfortran-wasm/dist/lfortran-wasm.global.js');
const compiler = await self.lfortranWasm.createCompiler();   // baseUrl optional; defaults to the CDN
```

It is 3.4 KB minified, because the loader has no dependencies. Pin the version in production.

`importScripts` cannot load the emscripten glue, and this build exists because of it: the glue is an ES
module (`EXPORT_ES6=1`), so `importScripts` reports a NetworkError for it. The loader therefore reaches
the glue with dynamic `import()`, which works from a classic worker, and only the loader needed a
classic form.

## What it costs

The shipped artifact is built from LFortran v0.66.0 against LLVM 22.1.8, with `print_arr` skipped:

| asset | raw |
| --- | --- |
| `wasm_run.wasm` | 64,844,732 B (61.84 MiB) |
| `wasm_run.js` | 566,906 B |
| `wasm_run.data` | 178,967 B |

`copy-assets` gzips the wasm when vendoring and prints a size and SHA-256 receipt per asset — **17.31
MiB** gzipped. The raw file is not published, and the client decompresses the gzip with
`DecompressionStream`. Brotli would be smaller but browsers cannot decompress it from script —
`DecompressionStream` supports only gzip and deflate — so it is left on the table.

For comparison, the published 0.66.0 wasm-backend build is 16.62 MiB raw but cannot compile derived
types, array sections, allocatables or `read`, and the toolchain LiveCodes already loads for C and C++
(`@live-codes/clang-wasm` 0.2.0) is 28.5 MiB across 30 files.

## Why it is built the way it is

The artifact is produced by the Docker build in this repository at `docker/lfortran-wasm/`, which
documents each decision where it is made — including why `MAIN_MODULE=2` was measured and rejected, and
why `getTerminator` is left unpatched. Two things are worth knowing from here:

- **`print_arr` is skipped in the entry point**, not patched. `wasm-run-main.cpp` sets
  `lpm.passes_to_skip_with_llvm = {"print_arr"}` and also honours an optional `/skip.txt` in the wasm
  filesystem, which is how this was bisected and how a future regression can be narrowed without a
  rebuild. `docker/lfortran-wasm/pass-bisect.mjs` does that bisect; `verify-skip.mjs` checks what
  skipping a pass costs.
- **The terminator patch is off by default.** Up to v0.65.0 LFortran called `getTerminator()` as a test,
  and modern LLVM changed that method to *assume* a well-formed block, so under `NDEBUG` a block ending
  in a call looked terminated and no branch was emitted — invalid IR. Both replacement spellings,
  `getTerminatorOrNull()` and `hasTerminator()`, are absent from LLVM 22.1.8 and from 21, so with this
  pin the original code is correct and the patch does not compile. It is kept, off, for refs built
  against LLVM 23.

## Loader details worth knowing

Each of these was found by running it, and each is load-bearing:

- **stdin is wired by pointing fd 0 at a MEMFS file**, not by setting `Module.stdin`.
  `FS.createStandardStreams` only creates a device for `/dev/stdin` `if (input)`, and that sits behind
  Emscripten's compile-time `expectToReceiveOnModule('stdin')` check; otherwise `/dev/stdin` symlinks
  to `/dev/tty`, whose fallback reads the host's stdin.
- **The end-of-file flag on stdin is cleared before every run**, with `clearerr(stdin)` in the entry
  point. Nothing else clears it, so a run whose stdin was empty left the flag set and every later run
  died with `Failed to read input.` **even when input was supplied** — which is exactly what a host
  with an empty input pane does on its first run.
- **The LLVM target registry has to be populated by the host.** Upstream's CLI does it in `main()`;
  a browser host calls `run_fortran` instead. Without it `TargetRegistry::lookupTarget` returns null and
  the evaluator dereferences it.
- **`locateFile` must return a filesystem path under Node** and a URL in a browser. Emscripten's Node
  path reads assets with `fs`, so a `file:` URL gets concatenated onto the script directory.
- **`print` and `printErr` are called once per line with the newline consumed**, so output has to be
  rejoined with `\n` or consecutive writes run together.
- **A Fortran `exit()` arrives as a thrown `ExitStatus` rather than a return value**, and under Node it
  also sets the host process's exit code — which makes a test runner report a whole file as failed even
  when every assertion passed.
- **The glue is an ES module** (`EXPORT_ES6=1`). That is why one loader covers a page, a worker and
  Node. The alternative — a script tag in one and a `vm` context in the other — creates a realm
  mismatch in which a `TypeError` thrown by the host's `WebAssembly` is not an instance of the vm's
  `TypeError`, turning a handled case into a raw `WebAssembly.Table.set` failure.

## Building the artifact

```sh
docker build -t lfortran-wasm-build docker/lfortran-wasm

# the shipping build: the image's default ref, v0.66.0, with the entry point above
docker run -d --name lf-wasm066 lfortran-wasm-build sleep infinity
docker cp docker/lfortran-wasm/wasm-run-main.cpp      lf-wasm066:/wasm-run-main.cpp
docker cp docker/lfortran-wasm/build-in-container.sh  lf-wasm066:/build.sh
docker exec -d lf-wasm066 bash -c "cd /src && bash /build.sh > /build.log 2>&1"

docker cp lf-wasm066:/src/build-wasm/src/bin/wasm_run.js   docker/lfortran-wasm/out-066b/
docker cp lf-wasm066:/src/build-wasm/src/bin/wasm_run.wasm docker/lfortran-wasm/out-066b/
docker cp lf-wasm066:/src/build-wasm/src/bin/wasm_run.data docker/lfortran-wasm/out-066b/

npm run copy-assets ..\..\docker\lfortran-wasm\out-066b   # vendors + gzips, printing receipts
npm run build:iife                                        # dist/lfortran-wasm.global.js
```

A different ref can be built with the same toolchain, which is how the versions above were compared:
`docker run lfortran-wasm-build bash /try-newer-ref.sh <ref>`. `build-in-container.sh` takes
`LLVM_SPEC` (this pin uses `llvm==22.1.8`) and `TERMINATOR_PATCH`.

`build:iife` needs `esbuild`; in this repository it falls back to the copy the sibling package has
installed.

## Tests

```sh
npm test        # 9 tests, the packaged artifact through the public API
```

Free-form source; **`print *` inside a `do` loop**; a mixed list inside a loop; whole-array, array
section and allocatable prints; derived-type member access; stdin; a compile error reported rather than
thrown; **that a successful run has empty diagnostics**; and that a failed program does not poison the
compiler for the next one.

The first loop test and the empty-diagnostics test each guard a bug that shipped: the first is the pass
being skipped, the second is the entry point writing a configuration note to stderr. `assets/` is
produced by the build above.

## Behaviour worth knowing

Verified, not assumed — each of these was run:

- **Bounds and intrinsic-domain errors are compile-time diagnostics.** `a(5) = 1` on `integer :: a(3)`
  reports `Array index 5 is out of bounds (1 to 3)` and `sqrt(-1.0)` reports `Argument of 'sqrt' has a
  negative argument`. They are not runtime traps.
- **Integer division by zero prints `0`** rather than trapping or diagnosing. Fortran leaves it
  undefined, so this is a defensible choice rather than a bug, but it is silent.
- **Node cannot import the glue from a CDN.** Node's ESM loader accepts only `file:` and `data:` URLs,
  so `baseUrl` pointing at a CDN works in a browser and a worker, and in Node only the wasm and
  `.data` come from there — the loader says so explicitly rather than failing obscurely.
- **Coverage is thin.** Modules with contained procedures, derived types, allocatables, array sections,
  whole-array arithmetic, formatted and file I/O, stdin and libm are exercised, but LFortran is a young
  compiler: coarrays, submodules, quad precision and parts of I/O are not verified here, and a live
  playground will find things this does not.

## License

MIT for this package. The wasm it ships is LFortran (BSD 3-Clause), LLVM and LLD (Apache-2.0 with LLVM
Exceptions) and Emscripten (MIT/University of Illinois) — see `THIRD-PARTY-NOTICES.md`, which must
travel with any redistribution.
