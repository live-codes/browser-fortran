# Browser Fortran

Run **Fortran entirely in the browser** — no server, no upload, no install, and no cross-origin
isolation headers. The compiler runs in WebAssembly, so a program typed into the page is compiled and
executed in that tab.

It is a proof of concept for adding a `fortran` language to [LiveCodes](https://livecodes.io), in the
same shape as [`browser-cobol`](https://github.com/live-codes/browser-cobol) and
[`browser-elixir`](https://github.com/live-codes/browser-elixir) were for their languages.

```
modern Fortran  →  LFortran + LLVM (wasm)  →  compiled and run in-place
```

There is no separate link step: a browser has no linker subprocess to hand a binary to, so LFortran
compiles the program in-process and the module loads it with `dlopen` — which is why it is built
`-s MAIN_MODULE=1`. Nothing in the pipeline is threaded, so no `SharedArrayBuffer` and no isolation
headers are involved.

**The compiler is a package in this repository** —
[`packages/lfortran-wasm`](packages/lfortran-wasm), published as `@live-codes/lfortran-wasm` — and this
page is a harness around it:

```js
import { createCompiler } from '@live-codes/lfortran-wasm';

const compiler = await createCompiler({ baseUrl });   // 19 MiB compressed, fetched once, then reused
const { stdout, errors, exitCode } = await compiler.run(source, stdin);
```

It ships **19 MiB compressed** (70.75 MiB of wasm) — less than the ~28.5 MiB Clang toolchain LiveCodes
already loads for C and C++, and only Fortran users pay it.

`packages/fortran-wasm` is the earlier f2c pipeline (Fortran 77 → C → Clang → WASI). It works and it is
published, but it is **superseded**: it rejects free-form source on the first line, and it compiles
`PRINT *, A(2:3)` into a whole-array print that exits 0 and is silently wrong. It is kept for
reference rather than removed.

## Demo

```bash
npm start          # → http://localhost:8127/
```

There is nothing to install and nothing to copy: the compiler is a published package, its Clang is a
published package, and both ship their wasm. `public/` is two files — an `index.html` with a one-entry
import map and a `main.js` that drives the compiler — and everything else is fetched from jsDelivr on
first use. ~29 MB, once, in about 21 seconds cold.

Pick an example (or type your own), press **Run** — or `Ctrl`/`Cmd` + `Enter` in the editor. Program
output appears in the right pane, diagnostics below it, and `READ` takes what is in the stdin box.

A static server is required, because `file://` cannot run ES modules — but it needs no special
headers, and `npm start` is a plain file server.

The Clang half arrives through `@live-codes/fortran-wasm`'s own dependency on `@live-codes/clang-wasm`,
which jsDelivr rewrites to an absolute URL — the same URL a page would map by hand, so anything else
using that entry shares one module instance, one runtime and one lock with it. Nothing under `public/`
mentions `@live-codes/clang-wasm` at all.

Point either half somewhere else — a mirror we control, or a directory `*-copy-assets` wrote — with
`?fortranBaseUrl=` and `?clangBaseUrl=`.

## What you get

- **Client-side compilation and execution.** Nothing is uploaded; `f2c`, clang and the linked program
  all run in the tab.
- **The real Fortran toolchain.** Upstream `f2c` (the Fortran 77 → C translator) plus the reference
  `libf2c` runtime, compiled to WebAssembly — not a subset interpreter.
- **Programs, subroutines and functions.** `DO`/`CONTINUE`, labelled statements, arrays, `DATA`,
  `COMPLEX`, formatted and list-directed file I/O, and `READ` from stdin.
- **One Clang, shared.** The page asks the same runtime pool `createCompiler` uses, so a page that also
  runs C/C++ pays for one toolchain rather than two, and both queue on the same lock.
- **Genuine compiler diagnostics**, each from the tool that produced it:

  ```
  main.f:
     MAIN broken:
  Error on line 7 of main.f: DO loop or BLOCK IF not closed
  Error on line 7 of main.f: missing statement label 10
  ```

  ```
  wasm-ld: error: main.o: undefined symbol: nosuchsub_
  ```

- **No cross-origin isolation.** See below — the same trick the COBOL spike needed.
- **Pinned toolchain.** Every asset, in both halves, is checked against a SHA-256 receipt before it is
  used.

## No cross-origin isolation

Threaded WebAssembly runtimes need `SharedArrayBuffer`, which browsers only expose to
cross-origin-isolated documents — a real obstacle when embedding a playground in someone else's page,
where the top-level headers are not yours to choose.

**This page does not need it.** Served with no isolation headers at all, `crossOriginIsolated` is
`false` and everything still compiles and runs. `@live-codes/clang-wasm` installs the stub itself; the
evidence behind that, checked against the shipped bundle, is in FINDINGS.md §4.

## Verified

Every row below was run through the page in headless Chrome **with isolation off**
(`crossOriginIsolated === false`); outputs are verbatim.

| program | result | f2c | compile + link | run |
| --- | --- | --- | --- | --- |
| Hello world | `Hello from Fortran!` / `Compiled and run in your browser, with no server.` | 14 ms | 781 ms | 3 ms |
| `DO 10 I = 1, 10` loop | ten `n= NN  n squared= NNN` lines, then `Done.` | 4 ms | 291 ms | 2 ms |
| Arrays, `DATA`, `REAL` | `Sum  =   15.` / `Mean =   3.` | 3 ms | 189 ms | 4 ms |
| A subroutine and a function | `doubled: 42` / `tripled: 42` | 3 ms | 180 ms | 3 ms |
| `READ *, A` with stdin `20` / `22` | `Enter two integers, one per line:` / `Sum =  42` | 3 ms | 177 ms | 5 ms |
| unterminated `DO` loop | `Error on line 7 of main.f: missing statement label 10` | — | — | — |

The package's own suite covers more of that surface in Node — a file round-trip, a program that trips
a trap, the result shape, and the shared toolchain — with `npm --prefix packages/fortran-wasm test`.

Toolchain load: **~21 s cold** — ~29 MB over the wire from jsDelivr, then 44 MB of clang and the 19 MB
sysroot to decompress. On a repeat visit it is a few seconds, and that remainder is the decompression
rather than the network: with the same assets served from localhost it measured ~7 s. It happens once
per page.

## Limitations

- **Fortran 77 only.** `f2c` is a Fortran 77 translator, so this is fixed-form source (`main.f`) with
  statements starting at column 7 and labels in columns 1–5. There are no modules, derived types,
  array sections, `ALLOCATABLE` or free-form F90+ syntax. Full modern Fortran needs LFortran — see
  FINDINGS.md §1, and §7 for why that should decide how this ships.
- **Calling the runtime library's own routines traps.** `GETARG`, `EXIT`, and libf2c's own error paths
  (a missing file on `OPEN`, say) end the program with a WebAssembly trap, because `f2c` cannot pass
  the interface `libf2c` was compiled with. It is reported rather than thrown. One consequence is that
  **a Fortran program cannot read its own argv**, so there is deliberately no `args` option.
- **~29 MB on first run,** and ~21 s to fetch and unpack it. It works on a laptop; it is not a small
  download.
- **~0.3–1.5 s to compile**, dominated by clang on the generated C. Fine for a playground; noticeable
  in a tight edit-run loop.
- **stdin is all-or-nothing per run.** The stdin box is read once when the program starts.
- **No `f2c` warnings on success.** `f2c` prints a bare `file: / program-unit:` preamble on every run,
  so the driver surfaces its output only when `f2c` fails.

## Layout

```
packages/fortran-wasm/   @live-codes/fortran-wasm — the published compiler, its tests, its own README
public/index.html        the harness page (examples, stdin, output, diagnostics, import map)
public/main.js           the harness: create a compiler, render a result, expose the timings
serve.js                 static server: MIME types, caching, --isolation
FINDINGS.md              the spike log: what was verified, what broke, what it means
```

`public/` is the whole demo. The wasm it runs on is in the packages, on jsDelivr, and
`packages/fortran-wasm/node_modules` exists only for that package's tests.

## Verifying

| what | command |
| --- | --- |
| serve the page | `npm start` → http://localhost:8127/ |
| check syntax | `npm run check` |
| serve with COOP/COEP instead | `npm run start:isolation` |
| the package's own tests | `npm --prefix packages/fortran-wasm test` |

The page exposes `document.documentElement.dataset` (`status`, `runs`, `exitCode`, `toolchainMs`,
`translateMs`, `compileMs`, `runMs`) and its element ids as globals, so scripted checks can read state
and drive the page without string literals.

## Status

Spike complete. `@live-codes/clang-wasm@0.2.0` and `@live-codes/fortran-wasm@0.1.0` are both
published, and this page loads the compiler from jsDelivr with no vendor mount and no build step —
what is left is to mirror the wasm assets somewhere we control rather than copying them from npm on
demand, and to decide whether `fortran` ships on `f2c` (Fortran 77) or waits for a published LFortran.

## License

MIT © Hatem Hosny. The compiler artifacts keep their own licenses — `f2c` and `libf2c` under their
netlib notice, reproduced in
[packages/fortran-wasm/THIRD-PARTY-NOTICES.md](packages/fortran-wasm/THIRD-PARTY-NOTICES.md), and
Clang, LLD, memfs and the sysroot under Apache-2.0 WITH LLVM-exception. See [LICENSE](LICENSE).
