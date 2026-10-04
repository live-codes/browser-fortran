# @live-codes/lfortran-wasm

Run modern Fortran in the browser or in Node, on **LFortran**'s LLVM backend compiled to
WebAssembly. No server, no transpiler step, and no cross-origin isolation: nothing in the pipeline is
threaded, so no `SharedArrayBuffer` is involved.

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

One compiler is meant to be reused: it holds the loaded module, and `run` compiles a fresh program
each time. Each run links its program as a separate wasm side module, which the module's executor
loads; those live for the lifetime of the loaded compiler, which is why a long-lived page should
create one and reuse it rather than one per keystroke.

## What it costs

| asset | raw | gzip | brotli |
| --- | --- | --- | --- |
| `wasm_run.wasm` | 70.75 MiB | 19.04 MiB | 12.90 MiB |
| `wasm_run.js` | 0.54 MiB | 0.12 MiB | 0.10 MiB |
| `wasm_run.data` | 0.17 MiB | 0.03 MiB | 0.02 MiB |
| **total** | **71.46 MiB** | **19.19 MiB** | **13.02 MiB** |

The package ships the **gzip** (19.04 MiB) and decompresses it in the client with
`DecompressionStream`. The raw file is never published: at 70.75 MiB it is past what a CDN will serve
for a package file. Brotli is smaller but browsers cannot decompress it from script —
`DecompressionStream` supports only gzip and deflate — so it is left on the table.

For comparison, the toolchain LiveCodes already loads for C and C++ (`@live-codes/clang-wasm`
0.2.0) is 28.5 MiB across 30 files, its largest being 15.0 MiB. This package is smaller in total but
ships as one much larger file.

## Why it is built the way it is

The artifact is produced by the Docker build in this repository at `docker/lfortran-wasm/`, which
documents each decision at the point it is made. The short version:

- **LFortran v0.65.0**, Emscripten 4.0.9, LLVM **22.1.8** for `emscripten-wasm32`. The LLVM version is
  pinned deliberately: `pixi.toml` says `llvm = "*"`, so solving today gives LLVM 23, and LFortran
  v0.65.0 does not build against it.
- **Own entry point.** LFortran's wasm build only *emits* things — AST, ASR, WAT, C, C++, wasm bytes.
  In a browser there is no linker subprocess to hand a binary to, so `wasm-run-main.cpp` compiles and
  runs in-process through `FortranEvaluator`, which is what its own wasm-compatible tests use.
- **`-s MAIN_MODULE=1`**, because the executor loads the program it just compiled with `dlopen`. No
  `-pthread` and no `USE_PTHREADS` anywhere.
- **One patch to LFortran**, in two `start_new_block` helpers: `getTerminator()` became
  `getTerminatorOrNull()`. Modern LLVM changed `BasicBlock::getTerminator()` to *assume* a
  well-formed block; under `NDEBUG` it returns the trailing instruction for a block that is not
  terminated, so LFortran concluded blocks were already terminated and emitted no branches, producing
  invalid IR (`does not have terminator`) for every program.
- **The reported version is pinned to the clean tag**, because that patch makes the build tree dirty:
  `build0.sh` runs `ci/version.sh`, which is `git describe --tags --dirty`, so the compiler called
  itself `0.65.0-dirty` while the preloaded runtime `.mod` files said `0.65.0` — and LFortran refuses
  to load a `.mod` from a different version, which breaks `open`, `use iso_fortran_env` and more.
  There is a test for it.

**`MAIN_MODULE=2` was measured and rejected.** Exporting only a curated list would drop the 43,098
exported symbols that `MAIN_MODULE=1` carries — about 4.74 MiB of export section, roughly 7% of the
raw wasm and less once compressed. The list has to be exactly what the link defines, and deriving it
is awkward in both obvious ways (from the runtime's sources it includes symbols the link never pulls
in; from the side modules' imports it includes GOT entries they resolve locally), so it needs a
CMake custom command running `nm` over `liblfortran_runtime_static.a` before the link. Worse, the
importable surface would then be frozen at build time, so a user program needing a runtime function
the link did not happen to pull in would fail at `dlopen` — where `MAIN_MODULE=1` simply works. Not
worth 4.7 MiB. The reasoning lives in `docker/lfortran-wasm/build-in-container.sh`.

## Loader details worth knowing

Each of these was found by running it, and each is load-bearing:

- **`locateFile` must return a filesystem path under Node** and a URL in a browser. Emscripten's Node
  path reads assets with `fs`, so a `file:` URL gets concatenated onto the script directory.
- **stdin is wired by pointing fd 0 at a MEMFS file**, not by setting `Module.stdin`.
  `FS.createStandardStreams` only creates a device for `/dev/stdin` `if (input)`, and that sits behind
  Emscripten's compile-time `expectToReceiveOnModule('stdin')` check; otherwise `/dev/stdin` symlinks
  to `/dev/tty`, whose fallback reads the host's stdin.
- **`print` and `printErr` are called once per line with the newline consumed**, so output has to be
  rejoined with `\n` or consecutive writes run together.
- **A Fortran `exit()` arrives as a thrown `ExitStatus` rather than a return value**, and under Node
  it also sets the host process's exit code — which makes a test runner report a whole file as failed
  even when every assertion passed. Both are handled here.
- **The glue is an ES module** (`EXPORT_ES6=1`). That is why one loader covers a page, a worker and
  Node. The alternative — a script tag in one and a `vm` context in the other — creates a realm
  mismatch in which a `TypeError` thrown by the host's `WebAssembly` is not an instance of the vm's
  `TypeError`, turning a handled case into a raw `WebAssembly.Table.set` failure.

## Building the artifact

```sh
docker build -t lfortran-wasm-build docker/lfortran-wasm
docker run -d --name lfortran-wasm-run lfortran-wasm-build      # ~25 min first time, ~7 after
docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.js   docker/lfortran-wasm/out/
docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.wasm docker/lfortran-wasm/out/
docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.data docker/lfortran-wasm/out/
npm run copy-assets                                             # vendors + gzips into assets/
```

`npm run copy-assets` prints a size and a SHA-256 receipt per asset, so a published artifact can be
matched against a build.

## Tests

```sh
npm test        # 6 tests
```

They exercise the packaged artifact through the public API: free-form source, modules with contained
procedures and derived types, array sections, stdin, a compile error, and a program that exits.
`assets/` is produced by the build above, so a checkout without it skips rather than fails.

The same loader and the same corpus are also driven against a real browser by
`docker/lfortran-wasm/browser-test.html` (14/14) and in Node by `docker/lfortran-wasm/test-run.mjs`,
which is how the browser path is verified rather than assumed.

## License

MIT for this package. The wasm it ships is LFortran (BSD 3-Clause), LLVM and LLD (Apache-2.0 with
LLVM Exceptions) and Emscripten (MIT/University of Illinois) — see `THIRD-PARTY-NOTICES.md`, which
must travel with any redistribution.
