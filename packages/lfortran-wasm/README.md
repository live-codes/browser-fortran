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

## Why this LFortran, and not a published build

Every published LFortran wasm build — the ones at `lfortran.github.io/wasm_builds`, which is what
dev.lfortran.org runs — is built `-DWITH_LLVM=no`. LFortran's own wasm backend emits a module directly:
small, fast, and upstream-maintained, and unable to compile ordinary modern Fortran. Measured against
release `e8c53fddf` (0.59.0), the newest release this package uses:

| feature | wasm backend (every published build) | LLVM backend at 0.59.0 |
| --- | --- | --- |
| `print *` inside a `do` loop | works | works |
| module + contained procedure | works | works |
| derived-type member access (`q%x`) | `visit_StructInstanceMember() not implemented` | works |
| array section (`a(2:3)`) | `visit_ArraySection() not implemented` | works |
| allocatable array (`allocate(v(3))`) | `visit_Allocate() not implemented` | works |
| `read` / stdin | aborts with `CodeGenAbort` | works |

None of those gaps are fixed on `main`; they are the same at `0.66.0-602-gd981ac1f4`, where the
diagnostics have degraded from named `visit_X() not implemented` to a bare `LCompilersException`.

The LLVM backend has one problem of its own, and it is why this package is pinned to 0.59.0 rather than
to the newest release: **from 0.60.0 onward it drops `print *` inside a `do` loop.** Same pipeline, same
program, only the build changed:

| release | wasm | `do` loop with `print *` |
| --- | --- | --- |
| 0.52.0 | 22.32 MiB | `1 2 3` |
| **0.59.0** | **11.75 MiB** | **`1 2 3`** |
| 0.60.0 | 12.00 MiB | nothing |
| 0.63.0 | 13.65 MiB | nothing |
| 0.66.0 / current `dev` | 16.62 / 17.60 MiB | nothing |

"Nothing" is a silent success: the program compiles, runs, exits 0, and prints nothing. The emitted
module comes out **smaller than a hello-world's** — 644 bytes against 898 — so the statement is dropped
at codegen, and the `| (I0)` formatted write in the same loop still works. Confirmed on the LLVM
backend too, so it is not a property of one backend.

0.59.0 is therefore the newest release where the LLVM backend is both **complete** (the table above) and
**correct** (this one), which is why the artifact is built from that tag in
`docker/lfortran-wasm/build-wasm-059.sh` rather than taken from a release page.

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

One compiler is meant to be reused: it holds the loaded module, and `run` compiles a fresh program each
time. Each run links its program as a separate wasm side module, which the module's executor loads;
those live for the lifetime of the loaded compiler, which is why a long-lived page should create one
and reuse it rather than one per keystroke.

### Classic workers

A page or a module worker imports the package directly. A **classic** worker can use it too, because
dynamic `import()` is available in classic workers as well — `await import(packageUrl)` works, verified
with the corpus.

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

The shipped artifact is built from LFortran v0.59.0 against LLVM 21:

| asset | raw |
| --- | --- |
| `wasm_run.wasm` | 57,186,792 B (54.5 MiB) |
| `wasm_run.js` | 566,837 B |
| `wasm_run.data` | 72,569 B |

`copy-assets` gzips the wasm when vendoring and prints a size and SHA-256 receipt per asset. The raw
file is not published, and the client decompresses the gzip with `DecompressionStream`. Brotli would be
smaller but browsers cannot decompress it from script — `DecompressionStream` supports only gzip and
deflate — so it is left on the table.

For comparison: the `v0.66.0` build this package used to ship was 63.70 MiB raw, and the toolchain
LiveCodes already loads for C and C++ (`@live-codes/clang-wasm` 0.2.0) is 28.5 MiB across 30 files.
This artifact is 6% smaller than the 0.66.0 one and, unlike the published wasm-backend builds, complete.

## Why it is built the way it is

The artifact is produced by the Docker build in this repository at `docker/lfortran-wasm/`, which
documents each decision at the point it is made. The short version:

- **LFortran v0.59.0**, Emscripten 4.0.9, and LLVM **21** for `emscripten-wasm32`. The LLVM line matters:
  `llvm = "*"` in `pixi.toml` solves to whatever the channel has newest, and LLVM's C++ API breaks
  between majors, so 0.59.0 has to be built against 21 — against 22 it fails on
  `no member named 'CreateGlobalStringPtr'`.
- **No terminator patch at this ref.** Up to v0.65.0 LFortran's two `start_new_block` helpers called
  `getTerminator()` as a test, and modern LLVM changed that method to *assume* a well-formed block, so
  under `NDEBUG` a block ending in a call looked terminated, no branch was emitted, and the IR was
  invalid (`does not have terminator`). Both replacement functions — `getTerminatorOrNull()` and
  `hasTerminator()` — arrived in **LLVM 22**, so at 0.59.0 against LLVM 21 the original code is already
  correct and the patch does not compile.
- **`HAVE_BUILD_TO_WASM` is defined.** LFortran guards a 32-bit portability assert with it:

  ```cpp
  #if !defined(HAVE_BUILD_TO_WASM) && !defined(__ppc__)
  static_assert(sizeof(YYSTYPE) == sizeof(Vec<AST::ast_t*>));
  #endif
  ```

  The equality holds on a 64-bit host and not on wasm32 — upstream knows, which is what the guard is
  for. Defining only the macro, rather than turning the `LFORTRAN_BUILD_TO_WASM` option on, keeps the
  emit-only CLI out of the build.
- **`MAIN_MODULE=2` was measured and rejected.** Exporting only a curated list would drop the 43,098
  exported symbols `MAIN_MODULE=1` carries — about 4.74 MiB of export section — and would freeze the
  importable surface at build time, so a program needing a runtime function the link did not pull in
  would fail at `dlopen`, where `MAIN_MODULE=1` simply works. The reasoning lives in
  `docker/lfortran-wasm/build-in-container.sh`.

## Loader details worth knowing

Each of these was found by running it, and each is load-bearing:

- **stdin is wired by pointing fd 0 at a MEMFS file**, not by setting `Module.stdin`.
  `FS.createStandardStreams` only creates a device for `/dev/stdin` `if (input)`, and that sits behind
  Emscripten's compile-time `expectToReceiveOnModule('stdin')` check; otherwise `/dev/stdin` symlinks
  to `/dev/tty`, whose fallback reads the host's stdin.
- **The end-of-file flag on stdin is cleared before every run**, with `clearerr(stdin)` in the entry
  point. Nothing else clears it, so a run whose stdin was empty left the flag set and every later run
  died with `Failed to read input.` **even when input was supplied** — which is exactly what a host
  with an empty input pane does on its first run. Measured, then fixed in `wasm-run-main.cpp`, so it is
  compiled into the artifact rather than papered over in the loader.
- **`locateFile` must return a filesystem path under Node** and a URL in a browser. Emscripten's Node
  path reads assets with `fs`, so a `file:` URL gets concatenated onto the script directory.
- **`print` and `printErr` are called once per line with the newline consumed**, so output has to be
  rejoined with `\n` or consecutive writes run together.
- **A Fortran `exit()` arrives as a thrown `ExitStatus` rather than a return value**, and under Node it
  also sets the host process's exit code — which makes a test runner report a whole file as failed even
  when every assertion passed. Both are handled here.
- **The glue is an ES module** (`EXPORT_ES6=1`). That is why one loader covers a page, a worker and
  Node. The alternative — a script tag in one and a `vm` context in the other — creates a realm
  mismatch in which a `TypeError` thrown by the host's `WebAssembly` is not an instance of the vm's
  `TypeError`, turning a handled case into a raw `WebAssembly.Table.set` failure.

## Building the artifact

```sh
docker build -t lfortran-wasm-build docker/lfortran-wasm

# the shipping build: LFortran 0.59.0 against LLVM 21, with the wasm environments this ref predates
docker run -d --name lf-wasm059 lfortran-wasm-build sleep infinity
docker cp docker/lfortran-wasm/build-wasm-059.sh   lf-wasm059:/port.sh
docker cp docker/lfortran-wasm/wasm-run-main.cpp   lf-wasm059:/wasm-run-main.cpp
docker cp docker/lfortran-wasm/build-in-container.sh lf-wasm059:/build.sh
docker exec -d lf-wasm059 bash -c "bash /port.sh > /port.log 2>&1"

docker cp lf-wasm059:/src/build-wasm/src/bin/wasm_run.js   docker/lfortran-wasm/out-059/
docker cp lf-wasm059:/src/build-wasm/src/bin/wasm_run.wasm docker/lfortran-wasm/out-059/
docker cp lf-wasm059:/src/build-wasm/src/bin/wasm_run.data docker/lfortran-wasm/out-059/

npm run copy-assets     # vendors + gzips into assets/, printing receipts
npm run build:iife      # dist/lfortran-wasm.global.js
```

A different ref can be built with the same toolchain, which is how the versions above were compared:
`docker run -e LLVM_SPEC='llvm>=21,<22' -e TERMINATOR_PATCH=0 … bash /try-newer-ref.sh v0.59.0`. The
default ref builds upstream's source unmodified against LLVM 22.

`build:iife` needs `esbuild`; in this repository it falls back to the copy the sibling package has
installed.

## Tests

```sh
npm test        # the packaged artifact through the public API
```

They exercise free-form source, a `do` loop that prints, modules with contained procedures, array
elements, a compile error, a program that is *refused* by the compiler followed by a working one, and
repeated runs giving identical results. `assets/` is produced by the build above, so a checkout without
it skips rather than fails.

The same loader and corpus are also driven against a real browser by
`docker/lfortran-wasm/browser-test.html` and in Node by `docker/lfortran-wasm/test-run.mjs`, which is
how the browser path is verified rather than assumed. Both assert on the program's **output**, not just
its exit code — which is how the loop regression was found in the first place.

## Behaviour worth knowing

Verified, not assumed — each of these was run:

- **Bounds and intrinsic-domain errors are compile-time diagnostics.** `a(5) = 1` on `integer :: a(3)`
  reports `Array index 5 is out of bounds (1 to 3)` and `sqrt(-1.0)` reports `Argument of 'sqrt' has a
  negative argument`. They are not runtime traps.
- **A trap does not poison the compiler.** Stack exhaustion from runaway recursion surfaces as
  `Maximum call stack size exceeded`, and the next `run()` works normally.
- **Integer division by zero prints `0`** rather than trapping or diagnosing. Fortran leaves it
  undefined, so this is a defensible choice rather than a bug, but it is silent.
- **Node cannot import the glue from a CDN.** Node's ESM loader accepts only `file:` and `data:` URLs,
  so `baseUrl` pointing at a CDN works in a browser and a worker, and in Node only the wasm and
  `.data` come from there — the loader says so explicitly rather than failing obscurely.
- **Coverage is thin.** Modules with contained procedures, derived types, allocatables, array sections,
  whole-array arithmetic, formatted and file I/O, stdin and libm are all exercised, but LFortran is a
  young compiler: coarrays, submodules, quad precision and parts of I/O are not verified here, and a
  live playground will find things this does not.

## License

MIT for this package. The wasm it ships is LFortran (BSD 3-Clause), LLVM and LLD (Apache-2.0 with LLVM
Exceptions) and Emscripten (MIT/University of Illinois) — see `THIRD-PARTY-NOTICES.md`, which must
travel with any redistribution.
