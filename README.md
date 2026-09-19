# Browser Fortran

Run **Fortran entirely in the browser** — no server, no upload, no install, and no cross-origin
isolation headers. The compiler runs in WebAssembly, so a program typed into the page is compiled and
executed in that tab.

It is a proof of concept for adding a `fortran` language to [LiveCodes](https://livecodes.io), in the
same shape as [`browser-cobol`](https://github.com/live-codes/browser-cobol) and
[`browser-elixir`](https://github.com/live-codes/browser-elixir) were for their languages.

```
Fortran 77  →  f2c (wasm)  →  C  →  Clang 22 (wasm)  →  wasm-ld  →  WASI module  →  runs
```

**The compiler is a package in this repository** — [`packages/fortran-wasm`](packages/fortran-wasm),
published as `@live-codes/fortran-wasm` — and this page is a harness around it:

```js
import { createCompiler } from '@live-codes/fortran-wasm';

const compiler = await createCompiler({ baseUrl, clangBaseUrl });
const { stdout, errors, exitCode } = await compiler.run(source, stdin);
```

The Clang half is [`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm)'s
runtime, taken through that package's low-level `/toolchain` entry and **shared** with the C, C++ and
Objective-C languages it already runs — one ~28 MB load, one ~84 MB resident, one lock.

## Demo

```bash
npm run assets     # copies both asset trees into public/  (once, ~29 MB)
npm start          # → http://localhost:8127/
```

Pick an example (or type your own), press **Run** — or `Ctrl`/`Cmd` + `Enter` in the editor. Program
output appears in the right pane, diagnostics below it, and `READ` takes what is in the stdin box.

A static server is required, because `file://` cannot run ES modules or fetch the wasm assets — but it
needs no special headers, and `npm start` is a plain file server.

There is no bundler and no build step. `public/index.html` uses an import map: `@live-codes/clang-wasm`
comes from jsDelivr, and `@live-codes/fortran-wasm` is mounted from `packages/` by `serve.js` because it
is not published yet. That mount, and one import-map line, go away when it is.

The two `0.2.0` pins — in the import map and in `npm run assets` — have to agree: the runtime comes
from the CDN and the assets from the copy, and the receipts are that version's.

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
| Hello world | `Hello from Fortran!` / `Compiled and run in your browser, with no server.` | 10 ms | 796 ms | 3 ms |
| `DO 10 I = 1, 10` loop | ten `n= NN  n squared= NNN` lines, then `Done.` | 4 ms | 346 ms | 2 ms |
| Arrays, `DATA`, `REAL` | `Sum  =   15.` / `Mean =   3.` | 4 ms | 207 ms | 6 ms |
| A subroutine and a function | `doubled: 42` / `tripled: 42` | 3 ms | 129 ms | 1 ms |
| `READ *, A` with stdin `20` / `22` | `Enter two integers, one per line:` / `Sum =  42` | 1 ms | 77 ms | 3 ms |
| unterminated `DO` loop | `Error on line 7 of main.f: missing statement label 10` | — | — | — |

The package's own suite covers more of that surface in Node — a file round-trip, a program that trips
a trap, the result shape, and the shared toolchain — with `npm --prefix packages/fortran-wasm test`.

Toolchain load: **~7 s**, once per page, even from a local origin — it is dominated by decompressing
44 MB of clang and the 19 MB sysroot, not by the network.

## Limitations

- **Fortran 77 only.** `f2c` is a Fortran 77 translator, so this is fixed-form source (`main.f`) with
  statements starting at column 7 and labels in columns 1–5. There are no modules, derived types,
  array sections, `ALLOCATABLE` or free-form F90+ syntax. Full modern Fortran needs LFortran — see
  FINDINGS.md §1, and §7 for why that should decide how this ships.
- **Calling the runtime library's own routines traps.** `GETARG`, `EXIT`, and libf2c's own error paths
  (a missing file on `OPEN`, say) end the program with a WebAssembly trap, because `f2c` cannot pass
  the interface `libf2c` was compiled with. It is reported rather than thrown. One consequence is that
  **a Fortran program cannot read its own argv**, so there is deliberately no `args` option.
- **~29 MB on first run,** plus ~7 s to unpack. It works on a laptop; it is not a small download.
- **~0.3–1.5 s to compile**, dominated by clang on the generated C. Fine for a playground; noticeable
  in a tight edit-run loop.
- **stdin is all-or-nothing per run.** The stdin box is read once when the program starts.
- **No `f2c` warnings on success.** `f2c` prints a bare `file: / program-unit:` preamble on every run,
  so the driver surfaces its output only when `f2c` fails.

## Layout

```
packages/fortran-wasm/   @live-codes/fortran-wasm — the compiler, its tests, its own README
public/index.html        the harness page (examples, stdin, output, diagnostics, import map)
public/main.js           the harness: create a compiler, render a result, expose the timings
public/fortran/          f2c, libf2c and the header, written by `fortran-wasm-copy-assets`
public/clang/            Clang, LLD, memfs and the sysroot, written by `clang-wasm-copy-assets`
serve.js                 static server: MIME types, caching, --isolation, the /vendor mount
FINDINGS.md              the spike log: what was verified, what broke, what it means
```

There is no bundler. `packages/fortran-wasm/node_modules` exists only for that package's tests, and is
ignored.

## Verifying

| what | command |
| --- | --- |
| fetch both asset trees | `npm run assets` |
| serve the page | `npm start` → http://localhost:8127/ |
| check syntax | `npm run check` |
| serve with COOP/COEP instead | `npm run start:isolation` |
| the package's own tests | `npm --prefix packages/fortran-wasm test` |
| use a different fortran-wasm checkout | `npm start -- --fortran-wasm=<dir>/src` |

The page exposes `document.documentElement.dataset` (`status`, `runs`, `exitCode`, `toolchainMs`,
`translateMs`, `compileMs`, `runMs`) and its element ids as globals, so scripted checks can read state
and drive the page without string literals.

## Status

Spike complete, and now shaped as the package LiveCodes would consume. `@live-codes/clang-wasm@0.2.0`
is published and this page loads its runtime from jsDelivr; what is left is to publish
`@live-codes/fortran-wasm`, drop the one remaining dev mount, mirror the three `f2c`/`libf2c` assets
rather than depending on a demo host, and decide whether `fortran` ships on `f2c` (Fortran 77) or waits
for a published LFortran.

## License

MIT © Hatem Hosny. The compiler artifacts keep their own licenses — `f2c` and `libf2c` under their
netlib notice, reproduced in
[packages/fortran-wasm/THIRD-PARTY-NOTICES.md](packages/fortran-wasm/THIRD-PARTY-NOTICES.md), and
Clang, LLD, memfs and the sysroot under Apache-2.0 WITH LLVM-exception. See [LICENSE](LICENSE).
