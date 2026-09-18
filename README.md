# Browser Fortran

Run **Fortran entirely in the browser** — no server, no upload, no install, and no cross-origin
isolation headers. The compiler itself runs in WebAssembly, so a program typed into the page is
compiled and executed in that tab.

It is a proof of concept for adding a `fortran` language to [LiveCodes](https://livecodes.io), in
the same shape as [`browser-cobol`](https://github.com/live-codes/browser-cobol),
[`browser-haskell`](https://github.com/live-codes/browser-haskell) and
[`browser-elixir`](https://github.com/live-codes/browser-elixir) were for their languages.

```
Fortran 77  →  f2c (wasm)  →  C  →  Clang 22 (wasm)  →  wasm-ld  →  WASI module  →  runs
```

Steps 2–4 are [`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm)'s
Clang, taken through its low-level `/toolchain` entry. Fortran is not C, C++ or Objective-C, so it
brings its own frontend, its own runtime library and its own link line — and borrows only the
compiler, from the runtime that package already shares with its own languages. `f2c` and `libf2c` are
not part of that package and come from a runtime mirror as pinned, hash-checked assets.

## Demo

```bash
npm run assets     # copies the Clang runtime into public/clang/  (once)
npm start          # → http://localhost:8127/
```

Pick an example (or type your own), press **Run** — or `Ctrl`/`Cmd` + `Enter` in the editor.
Program output appears as it is produced; `f2c`, clang and `wasm-ld` diagnostics appear below it;
`READ` reads from the stdin box.

A static server is required, because `file://` cannot run ES modules or fetch the wasm assets — but
it needs no special headers, and `npm start` is a plain file server.

There is no bundler, no build step and no `node_modules`: `public/index.html` uses an import map, and
`serve.js` serves the package's source from the checkout beside this repository because the
`/toolchain` entry is not in the published `0.1.0` yet. Once it is, the mount goes away and the import
map names a CDN.

## What you get

- **Client-side compilation and execution.** Nothing is uploaded; `f2c`, clang and the linked
  program all run in the tab.
- **The real Fortran toolchain.** This is upstream `f2c` (the Fortran 77 → C translator) plus the
  reference `libf2c` runtime, compiled to WebAssembly — not a subset interpreter.
- **One Clang, shared.** The page asks the same runtime pool `createCompiler` uses, so a page that
  also runs C/C++ pays for one toolchain rather than two, and both queue on the same lock.
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

- **Working stdin.** `READ *, A` reads from the stdin box.
- **No cross-origin isolation.** See below — the same trick the COBOL spike needed.
- **Lazy, pinned toolchain.** The page itself is ~20 KB; the compiler is fetched on first use, and
  every asset is checked against a SHA-256 receipt before it is used.

## No cross-origin isolation

Threaded WebAssembly runtimes need `SharedArrayBuffer`, which browsers only expose to
cross-origin-isolated documents — a real obstacle when embedding a playground in someone else's
page, where the top-level headers are not yours to choose.

**This page does not need it.** Served with no isolation headers at all, `crossOriginIsolated` is
`false` and everything still compiles and runs. `@live-codes/clang-wasm` installs the stub itself;
the local copy of that reasoning is in `public/index.html`.

Checked against the shipped bundle: the only occurrence of `SharedArrayBuffer` is one `instanceof`
test in the WASI host's memory-write path — no `new SharedArrayBuffer`, no `new WebAssembly.Memory`,
no worker, no `crossOriginIsolated` read. Full evidence in [FINDINGS.md](FINDINGS.md) §4.

## Verified

Every row below was run through the page in headless Chrome **with isolation off**
(`crossOriginIsolated === false`); outputs are verbatim.

| program | result | f2c | compile + link | run |
| --- | --- | --- | --- | --- |
| Hello world | `Hello from Fortran!` / `Compiled and run in your browser, with no server.` | 22 ms | 932 ms | 6 ms |
| `DO 10 I = 1, 10` loop | ten `n= NN  n squared= NNN` lines, then `Done.` | 6 ms | 211 ms | 8 ms |
| Arrays, `DATA`, `REAL` | `Sum  =   15.` / `Mean =   3.` | 3 ms | 162 ms | 4 ms |
| `READ *, A` with stdin `20` / `22` | `Enter two integers, one per line:` / `Sum =  42` | 4 ms | 169 ms | 7 ms |
| unterminated `DO` loop | `Error on line 7 of main.f: missing statement label 10` | — | — | — |
| `CALL NOSUCHSUB` (never defined) | `wasm-ld: error: main.o: undefined symbol: nosuchsub_` | — | — | — |

Toolchain load: **~6.7 s**, once per page, even from a local origin — it is dominated by
decompressing 44 MB of clang and the 19 MB sysroot, not by the network.

## Limitations

- **Fortran 77 only.** `f2c` is a Fortran 77 translator, so this is fixed-form source (`main.f`)
  with `DO`/`CONTINUE` loops, labelled statements, `DATA`, `CHARACTER`, and `PRINT *`/`READ *`.
  There are no modules, derived types, array sections, `ALLOCATABLE` or free-form F90+ syntax.
  Full modern Fortran needs LFortran — see FINDINGS.md §1, and §7 for why that should decide how
  this ships.
- **Fixed-form layout matters.** Statements must start at column 7, labels in columns 1–5.
- **~28 MB on first run,** plus ~6.7 s to unpack. It works on a laptop; it is not a small download.
- **~0.2–0.9 s to compile**, dominated by clang on the generated C. Fine for a playground;
  noticeable in a tight edit-run loop.
- **stdin is all-or-nothing per run.** The stdin box is read once when the program starts.
- **No `f2c` warnings on success.** `f2c` prints a bare `file: / program-unit:` preamble on every
  run, so the driver surfaces its output only when `f2c` fails.
- **Two asset sources.** The Clang half is self-hosted from the package; `f2c` and `libf2c` are
  fetched from `seorii.page`, a demo mirror. Production should mirror those three too.

## Layout

```
public/index.html     the harness page (examples, stdin, output, diagnostics, shim, import map)
public/main.js        the driver: acquire the toolchain, then f2c → clang → link → run
public/clang/         the Clang runtime, written by `npm run assets` (not committed)
serve.js              static server: MIME types, caching, --isolation, --clang-wasm mount
FINDINGS.md           the spike log: what was verified, what broke, what it means
```

There is no bundler and no `node_modules`.

## Verifying

| what | command |
| --- | --- |
| fetch the Clang runtime | `npm run assets` |
| serve the page | `npm start` → http://localhost:8127/ |
| check syntax | `npm run check` |
| serve with COOP/COEP instead | `npm run start:isolation` |
| use a different package checkout | `npm start -- --clang-wasm=<dir>/src` |

The page exposes `document.documentElement.dataset` (`status`, `runs`, `exitCode`, `toolchainMs`,
`f2cMs`, `compileMs`, `execMs`) and its element ids as globals, so scripted checks can read state and
drive the page without string literals.

## Status

Spike complete. The page compiles and runs Fortran client-side on `@live-codes/clang-wasm`'s runtime,
verified end to end in headless Chrome with no cross-origin isolation. Next: publish the package
entry and drop the dev mount, mirror the three `f2c`/`libf2c` assets, and decide whether `fortran`
ships on `f2c` (Fortran 77) or waits for a published LFortran.

## License

MIT © Hatem Hosny. The compiler artifacts are governed by their own licenses — `f2c` and `libf2c`
(AT&T/USL derived, freely redistributable), and Clang, LLD, memfs and the sysroot under Apache-2.0
WITH LLVM-exception. See [LICENSE](LICENSE).
