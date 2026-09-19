# @live-codes/fortran-wasm

Run **Fortran** in the browser or in Node, on `f2c` and Clang compiled to WebAssembly. No native
toolchain, and no host to set up: the assets ship inside the package.

```js
import { createCompiler } from '@live-codes/fortran-wasm';

const compiler = await createCompiler();

const { stdout, stderr, errors, exitCode } = await compiler.run(`
      PROGRAM HELLO
      PRINT *, 'Hello from Fortran!'
      END
`);

console.log(stdout);   // " Hello from Fortran!\n"
console.log(exitCode); // 0
```

That is Node, where the packaged assets can be read off disk. **In a browser there is no filesystem**,
so a page has to be given a URL - two of them, because this toolchain has two halves:

```bash
npx --package @live-codes/fortran-wasm fortran-wasm-copy-assets public/fortran
npx --package @live-codes/clang-wasm  clang-wasm-copy-assets  public/clang
```

```js
const compiler = await createCompiler({
    baseUrl: new URL('/fortran/', location.href),
    clangBaseUrl: new URL('/clang/', location.href)
});
```

Either way the package is bundled like any other npm package, because it imports its dependencies by
name.

## What it is

```
Fortran 77  →  f2c (wasm)  →  C  →  Clang 22 (wasm)  →  wasm-ld  →  WASI module  →  runs
```

`f2c` is the real translator, not a subset interpreter, and Clang is the real compiler. This package
is the pipeline that holds them together: it runs `f2c` as a WASI command, compiles what comes out,
links it against `libf2c`, and runs the result.

Because it compiles that C itself rather than through `createCompiler`, it passes
`CLANG_DRIVER_DEFAULT_ARGS` from `@live-codes/clang-wasm/toolchain` first in every `compileArgs` —
clang's frontend does not apply every default its driver does, and a driver is the one that has to
supply them. It also mounts libf2c's `main.o` by hand: `f2c` emits `MAIN__` and nothing else, and the
WASI crt references `main` weakly, so the linker would otherwise stub it with a trap.

**The Clang half is not this package's.** It is
[`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm)'s runtime, taken
through that package's low-level `/toolchain` entry, and it is *shared*: a page that already runs C,
C++ or Objective-C through that package pays for one Clang, not two, and a Fortran run queues on the
same lock as a C run rather than overwriting its files.

## API

### `createCompiler(options)`

Returns a promise for a compiler. The heavy part - roughly 28 MB of Clang, plus 1.1 MB of `f2c` and
`libf2c` - is fetched here, so a bad URL fails at this point rather than at the first `run`.

| Option | Meaning |
| --- | --- |
| `baseUrl` | Where `f2c.wasm`, `libf2c.a` and `f2c.h` are served from. **Optional in Node**, where the packaged assets are the default; required anywhere else, and absolute http(s) except in a browser, where it may be relative to the page. |
| `clangBaseUrl` | Where the Clang half is served from. Same rule - optional in Node, required in a browser. |
| `fileName` | The name the source is compiled under, and so the stem of everything derived from it. Defaults to `main.f`, which is fixed-form. |
| `onProgress` | `(value) => {}`, called with 0 to 1 while the Clang assets download. The Fortran assets are small and are not reported. |
| `maxAssetBytes` | Ceiling for a decompressed Clang asset. Defaults to 128 MB. |

### `compiler.run(code, input, runOptions?)`

Compiles and runs. `input` is stdin as a string or `Uint8Array`, handed to the program once and then
closed. `runOptions` may override `fileName` for that run.

| Field | Meaning |
| --- | --- |
| `stdout` | Everything the program wrote to fd 1 - which is Fortran unit 6, where `PRINT` goes. |
| `stderr` | Everything it wrote to fd 2 - Fortran unit 0. |
| `output` | Both, in the order the program wrote them. |
| `errors` | The compiler's diagnostics, one string per line, ANSI colour and the runtime's own log lines removed. **Empty when the program compiled and ran.** |
| `exitCode` | The program's exit status, or `null` if it never ran - a compile or link failure, or a run-time trap. |
| `compileMs` | Wall clock for translation, compilation and linking. |
| `translateMs` | The Fortran-to-C part of `compileMs`, which is the part `f2c` spent. |
| `runMs` | Wall clock for the run, or `null` if it did not run. |

Three kinds of failure, each reported by whichever tool owns it, and none of them thrown:

```js
// f2c           Error on line 7 of main.f: missing statement label 10
// wasm-ld       wasm-ld: error: main.o: undefined symbol: nosuchsub_
// at run time   The program stopped at run time: it called the runtime library routine `getarg_`, …
```

`errors` is empty on success so that `errors.length` is a reliable failure test. That means warnings
from a successful compile are not surfaced.

### `compiler.dispose()`

The toolchain is shared between every compiler created against the same assets, so C, C++,
Objective-C (through `@live-codes/clang-wasm`) and Fortran together cost one asset load rather than
four. Each compiler holds a reference; `dispose()` drops it, and the runtime is released when the last
one goes. Further runs on a disposed compiler throw.

### `compiler.language` and `compiler.dialect`

`'fortran'` and `'fortran77'`. The dialect is on the object because it is the thing a caller needs to
know to write source that will compile - see below.

## Fortran 77, and what that means

`f2c` translates **Fortran 77**. That is not a detail to bury: it is fixed-form source where
statements start at column 7 and labels sit in columns 1-5. Working today, each of these verified:

- Programs with their own **subroutines and functions**, in any order.
- `DO`/`CONTINUE` loops, labelled statements, arrays, `DATA`, `COMPLEX`, `REAL` and `INTEGER`
  arithmetic, and the `FUNCTION` intrinsics.
- **`PRINT`** to stdout and `WRITE` to unit 0 for stderr, in write order.
- **`READ` from stdin**, and formatted and list-directed **file I/O** - a program can write a file
  and read it back within a run.
- `STOP`.

Not working, and not fixable from here:

- **Calling the runtime library's own routines traps.** `GETARG`, `EXIT`, and the library's own error
  paths (a missing file on `OPEN`, for instance) all end the program with a WebAssembly trap. `f2c`
  knows those routines by name only, so the generated C cannot pass the interface `libf2c` was
  compiled with, and `wasm-ld` answers with a stub that traps instead of failing the link. The result
  reports it rather than throwing, and names the routine where it can.
- **A Fortran program cannot read its own argv**, because `GETARG` is the only way in and it is one of
  those routines. There is deliberately no `args` option here; passing one would change nothing a
  program could observe except `IARGC()`.
- **`STOP n` exits 0**, with `STOP n statement executed` on stderr - that is `libf2c`'s behaviour, not
  a bug here.
- Nothing from Fortran 90 and later: **no modules, derived types, array sections, `ALLOCATABLE`, or
  free-form source**. For those, the toolchain you want is LFortran, and no usable browser build of it
  is published yet.

## Loading it without a bundler

`dist/fortran-wasm.global.js` is a **minified IIFE bundle** - one classic script, 299 KB - for
anywhere an ES module cannot go: a classic worker, a plain `<script>`, a CDN URL handed to
`importScripts()`. It is self-contained, so it needs no bundler and no import map.

```js
// worker.js - a classic worker: no { type: 'module' }, no imports
importScripts('fortran-wasm.global.js');

const compiler = await self.fortranWasm.createCompiler({
    baseUrl: '/fortran/',
    clangBaseUrl: '/clang/'
});
const { stdout, errors, exitCode } = await compiler.run(source);
```

It is reachable as `@live-codes/fortran-wasm/iife`, and it is committed rather than built on install,
so a consumer never needs esbuild. Rebuild it with `npm run build:iife` after changing anything under
`src/`. It carries the whole Clang runtime, which is where its size comes from - a consumer that only
needs the ES module never pays for it.

**A worker still has no filesystem**, so this bundle always needs both base URLs.

## Where the assets come from

**In Node, nothing.** Omit the base URLs and both halves read the files they ship with.

**In a browser, two commands** - one per half, since they are different trees:

```bash
npx --package @live-codes/fortran-wasm fortran-wasm-copy-assets public/fortran
npx --package @live-codes/clang-wasm  clang-wasm-copy-assets  public/clang
```

The Fortran half is ~1.1 MB; the Clang half is ~28 MB. Both write an `asset-receipts.json` next to
what they copy, so whoever serves it can verify it at the CDN or in a build.

**Or nothing at all.** Both packages ship their assets, so any CDN that serves the package serves the
wasm with it, and a base URL can point straight at them:

```js
const compiler = await createCompiler({
    baseUrl: 'https://cdn.jsdelivr.net/npm/@live-codes/fortran-wasm@0.1.0/assets/',
    clangBaseUrl: 'https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@0.2.0/assets/'
});
```

That is what the `browser-fortran` demo does — two files, no install, ~29 MB fetched on first run. The
loaders still verify every byte against their receipts, so a CDN that mangles one (by serving a `.gz`
file with `Content-Encoding: gzip` and letting the client decompress it, say) fails loudly instead of
quietly.

Every asset either half reads is checked against a pinned SHA-256 receipt before it is used. The
Fortran receipts are in `src/asset-receipts.js`; the Clang ones are `@live-codes/clang-wasm`'s.

## Verified

`npm test` runs real compiles for every row of the table above - a program, subroutines and functions,
a file round-trip, stdin, and all three failure modes - plus the shape of the result, the shared
toolchain across two compilers, `dispose`, `fileName`, and that each shipped asset hashes to its
receipt. 17 tests, all against the packaged assets with no server.

## Development

```bash
npm install                 # @live-codes/clang-wasm, plus esbuild for the IIFE build
npm test                    # real compiles; no server needed
npm run fetch:assets        # re-fetch the three Fortran assets and verify them
npm run build:iife          # rebuild dist/fortran-wasm.global.js
```

`npm test` needs no server and no checkout: the Clang half is `@live-codes/clang-wasm` from the
registry, and the Fortran half is in `assets/`. If `npm install` reports no packages added, this
machine is probably setting `omit=dev` — use `npm install --include=dev` to get esbuild.

## License

**MIT** for the code. The three binaries in `assets/` are a third-party build of `f2c` and `libf2c`
under their own permissive notice, reproduced in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
along with where they came from. The Clang half is `@live-codes/clang-wasm`'s and carries its own
notices. Nothing here is copyleft, so nothing restricts what you can do with the programs you compile.
