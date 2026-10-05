# Browser Fortran

Run **Fortran entirely in the browser** — no server, no upload, no install, and no cross-origin
isolation headers. The compiler runs in WebAssembly, so a program typed into a page is compiled and
executed in that tab.

It is a proof of concept for adding a `fortran` language to [LiveCodes](https://livecodes.io), in the
same shape as [`browser-cobol`](https://github.com/live-codes/browser-cobol) and
[`browser-elixir`](https://github.com/live-codes/browser-elixir) were for their languages.

```
modern Fortran  →  LFortran + LLVM (wasm)  →  compiled and run in place
```

There is no separate link step: a browser has no linker subprocess to hand a binary to, so LFortran
compiles the program in-process and the module loads it with `dlopen` — which is why it is built
`-s MAIN_MODULE=1`. Nothing in the pipeline is threaded, so no `SharedArrayBuffer` and no isolation
headers are involved.

**The compiler is a package in this repository** —
[`packages/lfortran-wasm`](packages/lfortran-wasm), published as `@live-codes/lfortran-wasm`:

```js
import { createCompiler } from '@live-codes/lfortran-wasm';

const compiler = await createCompiler();           // once; each run is milliseconds after this
const { stdout, errors, exitCode } = await compiler.run(source, stdin);
```

## Why this exact LFortran

LFortran is the only real answer for Fortran in a browser — `gfortran` has no wasm target, `flang` has
no maintained wasm build, and a JavaScript interpreter is not a compiler. The question turned out to be
*which* build, and every published one is wrong for this use, in one of two ways. All of the following
was measured, not inferred.

**Every published LFortran wasm build is `-DWITH_LLVM=no`.** LFortran's own wasm backend emits a
module directly, which makes a small, fast, upstream-maintained artifact — and it cannot compile
ordinary modern Fortran. Against release `e8c53fddf` (0.59.0):

| feature | wasm backend (all published builds) | LLVM backend at 0.59.0 |
| --- | --- | --- |
| `print *` inside a `do` loop | works | **works** |
| module + contained procedure | works | works |
| derived-type member access (`q%x`) | **`visit_StructInstanceMember() not implemented`** | works |
| array section (`a(2:3)`) | **`visit_ArraySection() not implemented`** | works |
| allocatable array (`allocate(v(3))`) | **`visit_Allocate() not implemented`** | works |
| `read` / stdin | **aborts with `CodeGenAbort`** | works |
| real `sqrt`, string concatenation | works | works |

Those gaps are **not** fixed on `main` — they are identical at `0.66.0-602-gd981ac1f4`, where the
diagnostics have degraded from named `visit_X() not implemented` to a bare `LCompilersException`.

**And the LLVM backend loses `print *` inside a `do` loop from 0.60.0 onward.** Measured across the
published release ladder, same pipeline, same program, only the build changed:

| release | wasm | `do` loop with `print *` |
| --- | --- | --- |
| 0.52.0 (`b5e05bd3a`) | 22.32 MiB | `1 2 3` |
| **0.59.0 (`e8c53fddf`)** | **11.75 MiB** | **`1 2 3`** |
| 0.60.0 (`2f734343f`) | 12.00 MiB | *nothing* |
| 0.62.0 / 0.63.0 | 13.51 / 13.65 MiB | *nothing* |
| 0.66.0 (`569035a33`) | 16.62 MiB | *nothing* |
| `dev` `d981ac1f4` (0.66.0 + 602) | 17.60 MiB | *nothing* |

"Nothing" means it compiles, runs and exits 0 with empty output, and the emitted module comes out
**smaller than a hello-world's** — 644 bytes against 898 for the working build — so the statement is
dropped at codegen rather than the output being lost. It is reproducible on the LLVM backend too, and
the `| (I0)` formatted write in the same loop still works.

**So 0.59.0 is the newest release where the LLVM backend is both complete and correct**, and the only
artifact that is both is one we build ourselves. Verified natively at that tag (LLVM 21.1.2):

```
=== do loop with print *  (the regression case) ===   1 2 3
=== derived type member access ===                    7.00000000e+00
=== array section ===                                 1.00000000e+00 1.00000000e+00
=== read from stdin ===                               42
```

The wasm build of the same source is in `docker/lfortran-wasm/out-059/` —
`wasm_run.wasm` 57,186,792 bytes, `wasm_run.js` 566,837, `wasm_run.data` 72,569. That is 54.5 MiB raw,
against 63.70 MiB for the `v0.66.0` build this package shipped before, and it carries the stdin fix
(fd 0 plus `clearerr`, below).

## Packages

| package | what it is |
| --- | --- |
| [`packages/lfortran-wasm`](packages/lfortran-wasm) | `@live-codes/lfortran-wasm` — the compiler above, streaming Fortran 2018-ish source to wasm. **The shipping path.** |
| [`packages/fortran-wasm`](packages/fortran-wasm) | `@live-codes/fortran-wasm` — the earlier f2c pipeline (Fortran 77 → C → Clang → WASI). Works and is published, but **superseded**: it rejects free-form source on the first line and compiles `PRINT *, A(2:3)` into a whole-array print that exits 0 and is silently wrong. Kept for reference. |

Only Fortran users pay for the download, and the Clang half of the older package is shared with
LiveCodes' C/C++ toolchain rather than duplicated.

## Demo

```bash
npm start          # → http://localhost:8127/
```

`public/` is two files, and it does **not** use either package's sources. `main.js` imports
`@live-codes/lfortran-wasm` **by URL from jsDelivr** — the published package, currently `0.1.0` — and
the package resolves its own wasm from its own `assets/` there. That is deliberate: it is the same way
a LiveCodes language module would load it, so what the demo exercises is the published artifact rather
than a working tree. As a consequence the demo trails this repository — `0.1.0` is published, `0.2.0`
is in the working tree, and the 0.59.0 artifact below is not vendored yet.

`?baseUrl=` points it at a mirror instead, including the output of a container build. `npm start`
serves `public/` as the root, so a repository-relative path like `?baseUrl=/docker/lfortran-wasm/out/`
needs `node serve.js 8127 .` to resolve.

## Building the artifact

The toolchain lives in a Docker image; only the LFortran build runs in a container, so the long part can
be retried without installing gigabytes again.

```sh
docker build -t lfortran-wasm-build docker/lfortran-wasm
```

The **default** ref builds upstream's source unmodified against LLVM 22:

```sh
docker run -d --name lfortran-wasm-run lfortran-wasm-build
docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.js   docker/lfortran-wasm/out/
docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.wasm docker/lfortran-wasm/out/
docker cp lfortran-wasm-run:/src/build-wasm/src/bin/wasm_run.data docker/lfortran-wasm/out/
```

The **shipping** artifact is 0.59.0, which needs a port — the wasm environments it depends on did not
exist at that ref, and neither did `wasm-build0.sh`. `docker/lfortran-wasm/build-wasm-059.sh` does all
of it, including borrowing the native build's runtime `.mod` files so the expensive step is skipped:

```sh
docker run -d --name lf-wasm059 lfortran-wasm-build sleep infinity
docker cp docker/lfortran-wasm/build-wasm-059.sh lf-wasm059:/port.sh
docker cp docker/lfortran-wasm/wasm-run-main.cpp lf-wasm059:/wasm-run-main.cpp
docker cp docker/lfortran-wasm/build-in-container.sh lf-wasm059:/build.sh
docker exec -d lf-wasm059 bash -c "bash /port.sh > /port.log 2>&1"
```

Then vendor and bundle it:

```sh
npm --prefix packages/lfortran-wasm run copy-assets   # gzips into assets/, prints SHA-256 receipts
npm --prefix packages/lfortran-wasm run build:iife    # dist/lfortran-wasm.global.js
```

## Verifying

The available builds can be compared without building anything, because the toolchain image can be
driven with the same package code the loader uses:

| what | command |
| --- | --- |
| how a published build behaves on one program | `node docker/lfortran-wasm/pipeline.mjs release/e8c53fddf` |
| what a published build supports, feature by feature | `node docker/lfortran-wasm/capabilities.mjs dev/d981ac1f4` |
| the package's own tests | `npm --prefix packages/lfortran-wasm test` |
| the same corpus against another build | `set LFORTRAN_WASM_BUILD=dev/d981ac1f4 && npm --prefix packages/lfortran-wasm test` |

`capabilities.mjs` checks **expected output**, not just the exit code — a build that silently drops the
statement still exits 0, which is exactly the loop regression and would otherwise be reported as
supported.

## Limitations

- **`print *` inside a `do` loop is why the version is pinned.** Upstream regression, present from
  0.60.0 through current `main`, on both backends. Not fileable as "LFortran cannot do this" — it
  works at 0.59.0.
- **The published wasm-backend builds cannot compile** derived types, array sections, allocatables or
  `read`. That is why they are not used, and why the loader that drives them is a tool rather than the
  shipping path.
- **54.5 MiB of wasm**, fetched once per page or worker. Comparable to the `v0.66.0` build it replaces
  and to the Clang toolchain LiveCodes already loads for C/C++.
- **A browser has no linker process.** Programs are compiled in-process and loaded with `dlopen`, which
  is why the module is a `MAIN_MODULE` and carries the export section that implies.
- **LFortran is a young compiler.** Coarrays, submodules, quad precision and parts of I/O are not
  verified here, and a live playground will find things this does not.

## Status

The 0.59.0 LLVM-backend wasm **builds**, and its compiler is verified natively on the four cases above.
**It cannot be made to run programs, because that ref has no wasm run path.** Three independent facts
say so: the only references to `WasmLFortranExecutor` in that tree are in files this work added; the
ref's own wasm target is the emit-only CLI (`--no-entry`, no `MAIN_MODULE`); and `evaluator.cpp` there
contains only the **ORC JIT**, which needs executable memory and so cannot exist in wasm — upstream's
FortranEvaluator tests are all excluded under emscripten for that reason. `evaluate()` with
`interactive = true` therefore reaches for a null run path and traps with `null function or function
signature mismatch`.

The wasm executor arrived later; the loop regression arrived in 0.60.0. **So no published ref both
prints in a loop and runs a program in wasm**, and neither route alone is sufficient:

| | runs a program in wasm | full language | loop print |
| --- | --- | --- | --- |
| 0.59.0 wasm backend | yes | **no** — no derived types, array sections, allocatables, stdin | yes |
| 0.59.0 LLVM backend | **no** — no run path at that ref | yes | yes (natively) |
| 0.66.0 LLVM backend (= `0.2.0`) | yes | yes | **no** — upstream regression |

Getting the 0.59.0 build as far as it went needed three fixes, each an initialisation upstream's
`main()` performs and a browser host must perform itself — the LLVM target registry, a registered
`LocationManager` file before the parse path reads `lm.files.back()`, and the same file pushed *before*
`init_simple` reads it. Those are recorded in FINDINGS.md §14, and the fixes are in
`docker/lfortran-wasm/wasm-run-main.cpp`.

The demo runs on the shipped v0.66.0 build and loads it **from this repository** rather than a CDN
(`serve.js` serves `/packages/`). Verified in a browser: hello world and the derived-types example run
correctly, and the `DO` loop example exits 0 with no output — the regression, reproduced live.

So the remaining work is not in this repository: the loop print is an upstream codegen regression, and
the precise repro is in §11 — `1 2 3` at 0.59.0, nothing from 0.60.0 through current `main`, on both
backends.

## License

MIT. The compiler artifacts keep their own licenses — LFortran under BSD 3-Clause, LLVM and LLD under
Apache-2.0 WITH LLVM-exception, Emscripten under MIT/University of Illinois, and the older `f2c`
pipeline's assets under their netlib notice. See [LICENSE](LICENSE) and each package's
`THIRD-PARTY-NOTICES.md`.
