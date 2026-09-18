# Spike findings — Fortran in the browser

**Status: spike complete.** The page compiles and runs Fortran typed into it, in the tab, with no
server-side compilation and **no cross-origin isolation**. Everything below was **run**, in
headless Chrome — not inferred from docs.

## 1. The pipeline, and why it is this one

```
Fortran 77 source
  → f2c 2020        translates to C            (wasm32-wasi command)
  → Clang 22.1.8    compiles that C            (wasm-llvm + WASI sysroot)
  → wasm-ld         links libf2c, libc, -lm, compiler-rt
  → WASI preview 1 module                    instantiated and run in this tab
```

The browser host is `@live-codes/clang-wasm`'s runtime, through the low-level `/toolchain` entry
added to that package for this spike (§8). It is the same Clang/LLD/WASI half that
`@wasm-idle/llvm-core/clang` provides — the package is built on it — but taking it from the package
means one runtime shared with C, C++ and Objective-C instead of a second one beside them, and it is
where the self-hosted assets and their receipts live.

Every cheaper-looking alternative fails for a browser playground:

| Candidate | Why it does not work here |
| --- | --- |
| **LFortran** (real, modern Fortran) | The one genuinely better compiler, and the one we would prefer. No usable artifact exists today: the emscripten-forge build ships `bin/lfortran.js` but **not** `lfortran.wasm` (checked `info/paths.json` for 0.42.0 and the 0.44.0 tarball — the CLI's loader is packaged, its 13–80 MB wasm module is not); `seo-rii/wasm-llvm`'s `producer/lfortran-browser` builds one, but its README states it "does not register a language in `wasm-idle`" and that unvalidated artifacts "must not be published"; and the consumer's own `WASM_LFORTRAN_PROFILE` points at `wasm-lfortran/lfortran.js`, which **404s** on the live mirror. |
| `llvm-project/flang` to wasm | No maintained wasm build of the flang frontend. |
| gfortran | No wasm target. |
| A JavaScript Fortran interpreter | Not a compiler. The ecosystem's policy forbids subset executors as language support, and `browser-cobol` rejected the same shortcut for COBOL. |

`f2c` is a **Fortran 77** translator, not Fortran 2018. That is the honest cost of shipping
something that actually runs in a tab today; see §7 for what it means for LiveCodes.

## 2. The assets are deployed gzipped, and the receipts describe the inflated bytes

First surprise. The consumer config resolves `…/wasm-fortran/f2c.wasm`, and that URL is a
**GitHub Pages 404** — as is `libf2c.a`. But the same names with `.gz` are 200, and gunzip to
exactly the bytes the consumer's receipts pin:

| asset | served | inflated | receipt | check |
| --- | --- | --- | --- | --- |
| `f2c.wasm` | `f2c.wasm.gz` 225,632 | 636,297 | 636,297 / `c424b41c…29929f` | **size + SHA-256 OK** |
| `libf2c.a` | `libf2c.a.gz` 155,956 | 461,120 | 461,120 / `06a036b0…bea225` | **size + SHA-256 OK** |
| `f2c.h` | `f2c.h` 4,707 | — | 4,707 / `660cb39d…c0ea` | **size + SHA-256 OK** |

So the driver tries the plain name first and falls back to `.gz`, inflating with
`DecompressionStream('gzip')` and then verifying against the receipt. Both the plain and gzipped
paths are exercised by the same code; only the gzipped one is live upstream.

## 3. The linker silently stubs the C entry point — this was the real blocker

With the assets in place, `f2c` translated (7–26 ms) and clang compiled and linked (0.3–1.3 s) —
and then **every** program, including `PROGRAM P / END`, died instantly:

```
RuntimeError: unreachable
    at main.wasm.undefined_weak:main (wasm://…:wasm-function[18]:0x51e)
    at main.wasm.__main_void (…)
    at main.wasm._start (…)
```

Three separate facts, each found by running rather than reading:

**a. `f2c` never emits a C `main`.** The generated C defines `MAIN__(void)` and nothing else; the
real entry point — the one that initialises the runtime and then calls `MAIN__` — lives in
libf2c's archive member `main.o`. Confirmed by parsing `libf2c.a` (154 members) and inspecting
`main.o`: it imports `signal`, `__SIG_IGN`, `f_init`, `f_exit`, `atexit`, `MAIN__`, `exit`,
`sig_die`, and it is `main.o` that resolves the symbol.

**b. `wasm-ld` will not extract an archive member for a weak undefined symbol.** The WASI crt
references `main` *weakly*, so instead of searching `libf2c.a` the linker synthesises
`undefined_weak:main` — a stub whose body is `unreachable`. Two attempted fixes, both run:

| attempt | result |
| --- | --- |
| `-u main` before the archive | **no change** — still `undefined_weak:main` |
| `--whole-archive libf2c.a --no-whole-archive` | **link failure**, exit 1 |

The fix that works is to stop asking the linker to find it: the driver parses the `ar` archive,
extracts `main.o`, writes it into the memory filesystem and passes it on the link line as an
ordinary object file.

**c. `main.o` needs `__SIG_IGN`, which WASI libc does not define.** With `main.o` linked, `wasm-ld`
reported:

```
wasm-ld: error: libf2c_main.o: undefined symbol: __SIG_IGN
```

Supplying it as a *data* symbol was rejected — the object records it as a **function**:

```
wasm-ld: error: symbol type mismatch: __SIG_IGN
>>> defined as WASM_SYMBOL_TYPE_DATA in f2c_compat.o
>>> defined as WASM_SYMBOL_TYPE_FUNCTION in libf2c_main.o
```

so the compat shim declares `void __SIG_IGN(int)` — a no-op. WASI has no signals and the shim's
`signal()` already discards its handler, so a no-op is the entire requirement. `f2c`'s generated C
also calls `fiprintf`/`siprintf`/`__small_sprintf` (newlib spellings) and `tmpfile`, which the same
shim provides.

Whether the consumer's own Fortran module hits this is unknown — it is not published, so it cannot
be run. What is certain is that the published `@wasm-idle/llvm-core@1.0.0` Clang runtime plus the
published `f2c`/`libf2c` assets do **not** produce a runnable program without §3a–c.

## 4. Cross-origin isolation is NOT required — the requirement is the same upstream bug

`browser-cobol` found a single `instanceof SharedArrayBuffer` test in the WASI host that throws
`ReferenceError` in a non-isolated document. The Clang bundle used here has the same one, and the
whole bundle was re-checked rather than assumed:

| probe over `@wasm-idle/llvm-core@1.0.0/clang/+esm` | count |
| --- | --- |
| occurrences of `SharedArrayBuffer` | **1** — the `instanceof` test in `write()` |
| `new SharedArrayBuffer` | 0 |
| `new WebAssembly.Memory` | 0 |
| `new Worker(` | 0 |
| `crossOriginIsolated` | 0 |

The fix is unchanged: define a throwing `SharedArrayBuffer` constructor so the check has something
to compare against. Every row in §5 was run with `crossOriginIsolated === false`.

## 5. Verified working

Each row was run through the page (select the example, click Run) and the output pane read back —
under **no** cross-origin isolation.

| snippet | result | f2c | compile + link | run |
| --- | --- | --- | --- | --- |
| `PRINT *, 'Hello from Fortran!'` | `Hello from Fortran!` / `Compiled and run in your browser, with no server.` | 22 ms | 932 ms | 6 ms |
| `DO 10 I = 1, 10` + `SQ = I * I` | ten `n= N  n squared= N` lines, then `Done.` | 6 ms | 211 ms | 8 ms |
| `REAL X(5)` + `DATA X /…/` + mean | `Sum  =   15.` / `Mean =   3.` | 3 ms | 162 ms | 4 ms |
| `READ *, A` / `READ *, B`, stdin `20\n22` | `Sum =  42` | 4 ms | 169 ms | 7 ms |
| `DO 10` with no `10 CONTINUE` | `Error on line 7 of main.f: missing statement label 10` (f2c) | — | — | — |
| `CALL NOSUCHSUB`, never defined | `wasm-ld: error: main.o: undefined symbol: nosuchsub_` | — | — | — |
| `PROGRAM P` / `END` (minimal) | exit 0, no output | 22 ms | 1703 ms | 9 ms |

The two failure rows are deliberately different shapes: a bad *program* is `f2c`'s to report, a bad
*link* is `wasm-ld`'s, and both arrive in the tool's own words.

`READ` is genuinely wired to stdin, which matters for competitive-programming-shaped programs.

## 6. Payload

The Clang set now comes from `@live-codes/clang-wasm`'s own assets (§8) rather than from the demo
mirror, so two of these differ from what the mirror serves — and both differences matter:

| asset | bytes | from |
| --- | --- | --- |
| `bin/clang.wasm.gz` | 15,721,977 | the package |
| `bin/lld.wasm.gz` | 7,837,837 | the package |
| `bin/sysroot.tar.gz` | **5,334,358** | the package — full libc++, not the pruned tree the mirror serves (5,059,892) |
| `bin/memfs.wasm.gz` | **38,702** | the package — rebuilt, 4091 usable nodes, not the stock 1019 (18,974 bytes) |
| `wasm-fortran/f2c.wasm.gz` | 225,632 | `seorii.page` |
| `wasm-fortran/libf2c.a.gz` | 155,956 | `seorii.page` |
| `wasm-fortran/f2c.h` | 4,707 | `seorii.page` |
| `runtime-manifest.v1.json` | 876 | the package |
| host JS (`@live-codes/clang-wasm` + `@wasm-idle/llvm-core/clang`) | ~239,459 | npm |
| **total** | **~29.6 MB** | |

The memfs difference is not cosmetic for Fortran. The stock memfs has 1019 usable nodes and the stock
sysroot already consumes 978 of them, so this pipeline — `f2c.h`, `libf2c.a`, `libf2c_main.o`, the
source, the generated C, two objects and the linked module — is squeezing into about 41 free nodes. It
fits, but a second Fortran source file or a larger program could plausibly exhaust it. The package's
rebuilt memfs removes that ceiling.

Unlike the COBOL pipeline, the Clang runtime's own `sysroot.tar.gz` **is** downloaded here — COBOL
overrides it with its own `c-sysroot.tar.gz`, and Fortran has no such override.

Measured toolchain load: **~6.7 s** from a local origin, and **~23 s** on a warm HTTP cache from the
CDN, **~143 s** in a freshly launched browser on a slow connection. Most of the local figure is
decompressing 44 MB of clang and the 19 MB sysroot rather than the network — it is dominated by the
unpack, not the fetch, and it happens once per page.

## 7. Recommendation for LiveCodes

- **Fortran 77 is what this buys you.** Fixed-form source, `DO`/`CONTINUE`, labelled statements,
  `DATA`, `CHARACTER`, `PRINT *`/`READ *`, `COMPLEX`, intrinsics — real semantics, real
  diagnostics, working stdin. It is not Fortran 2018: no modules, derived types, array sections,
  `ALLOCATABLE` or free-form F90+ source.
- **Therefore: do not ship `fortran` on `f2c` alone.** Labelling Fortran 77 as "Fortran" in a
  playground that advertises the language would misrepresent it. Either ship it explicitly as
  **Fortran 77** (its own language id, its own formatter/highlighter rules, fixed-form defaults),
  or wait for a published LFortran.
- **If we wait, the blocker is packaging, not feasibility.** LFortran compiles Fortran 2018-ish
  source to wasm in the browser today via JupyterLite; what is missing is a *published* Emscripten
  artifact we can point a URL at. The `seo-rii/wasm-llvm` producer already builds one; the ask is
  an immutable, receipt-pinned release directory.
- **Shape:** a `lang-fortran` compiler factory with `scripts: [baseUrl + '{{hash:lang-fortran-script.js}}']`
  and `scriptType: 'text/fortran'`. Unlike `lang-elixir`, there is no worker/bundle sibling to keep
  in step.
- **The isolation blocker is gone,** so a Fortran result document can be served from an ordinary
  CDN with no special headers. `@live-codes/clang-wasm` installs the `SharedArrayBuffer` stub itself;
  a language module on that package inherits it.
- **`largeDownload: true`.** ~29 MB on first run.
- **The `main.o` extraction (§3b) belongs in the language module** — it is ~25 lines of `ar` parsing
  that exist solely because of this toolchain's linking behaviour, and it must travel with the pinned
  assets it understands.
- **Take the compiler from `@live-codes/clang-wasm/toolchain`, not from `@wasm-idle/llvm-core`
  directly** (§8). A second `BrowserClangRuntime` is a second ~28 MB asset load and a second ~84 MB
  resident, and LiveCodes already has the first one for C/C++/Objective-C.
- **Assets:** the Clang half is the package's problem solved — it ships the graph and pins the
  receipts. The three `f2c`/`libf2c` files still come from `seorii.page`, a demo mirror, and belong
  in `browser-compilers` (or a mirror we control) referenced from `vendors.ts`, pinned by hash.
  Depending on `seorii.page` is fine for a spike and wrong for a product.

## 8. What the package needed, and what it cost

`@live-codes/clang-wasm` runs C, C++ and Objective-C through `createCompiler(language).run(code, stdin)`.
That API cannot express this pipeline: the entry point and the link line are decided inside its
drivers, and Fortran needs both to be its own — `MAIN__` plus libf2c's `main.o` instead of `main`, and
`libf2c.a` on the link line. Its own `linkObjectiveC()` exists for exactly this reason ("the runtime's
link line cannot carry libobjc.a"), so Fortran is the same problem a second time.

So the package got a second, low-level entry rather than a change to the first one:
`@live-codes/clang-wasm/toolchain`, exporting `createToolchain` and `compilerDiagnostics` and nothing
else. It hands back the runtime plus `addFile`, `lock`, `captureCompilerOutput`, `runCommand` and
`execute` — the plumbing, with no policy about which objects to link.

**It shares the runtime with `createCompiler`.** Both acquire from one pool keyed by asset source, so
a page running C/C++ *and* Fortran pays for one ~28 MB load and one ~84 MB resident copy, and both
queue on the same lock. Two `createToolchain()` calls return objects whose `.runtime` is the same
object; that identity is asserted in the package's tests.

**Nothing existing changed.** `createCompiler`, `LANGUAGE_IDS` and `standardsFor` are untouched. The
only edits to existing files were moving one private helper (`captureCompilerOutput`) from
`compile.js` to `runtime.js` so that both entries could use it, and adding `compilerDiagnostics` to
the new entry.

**Bundle size.** The language bundle `dist/clang-wasm.global.js` is **unchanged at 302,713 bytes**: the
new entry is a separate subpath, so a consumer that does not import it does not pay for it. The
low-level entry gets its own IIFE, `dist/clang-wasm-toolchain.global.js` (290.8 KB), exposed as
`@live-codes/clang-wasm/iife/toolchain` for the classic workers LiveCodes' language modules run in.
`npm run build:iife` writes both.

Verified in the package's own suite: **32 tests pass**, seven of them new — two translation units
compiled and linked with a hand-written link line, a WASI command run through `runCommand` that reads
an input file and writes an output file, a failing command reporting its exit code and stderr rather
than throwing, and the shared-runtime identity above.

One bug found on the way: the documented way to fetch the assets,
`npx @live-codes/clang-wasm-copy-assets`, does not work — `npx` reads that as a *package* name, and
the package is `@live-codes/clang-wasm`. It is
`npx --package @live-codes/clang-wasm clang-wasm-copy-assets <dir>`. Fixed in the package's README,
in the error message that tells users the same thing, and used by this repo's `npm run assets`.

## 9. Reproducing the verification

```bash
npm run assets              # copies the Clang runtime into public/clang/  (once)
npm start                   # → http://localhost:8127/   (no isolation — the default)
npm run check               # syntax-check serve.js and public/main.js
npm run start:isolation     # same page with COOP/COEP, to compare
npm start -- --clang-wasm=<dir>/src   # use a different @live-codes/clang-wasm checkout
```

`public/clang/` is generated and not committed; without it the page fails at the manifest fetch with
the URL it tried. The package's `/toolchain` entry is not in the published `0.1.0`, so `serve.js`
serves the package source from the checkout beside this repository at `/vendor/clang-wasm/`, which
the import map names. Once the entry is published that mount and that import-map line both go away.

Driven here with the `agent-browser` CLI against headless Chrome: select the example, click Run,
and read `document.documentElement.dataset` (`status` / `runs` / `exitCode` / `toolchainMs` /
`f2cMs` / `compileMs` / `execMs`) plus the `#output` and `#diagnostics` panes. Element ids are
exposed as globals (`editor`, `run`, `stdin`, `output`, `diagnostics`, `examples`) so probes can
avoid string literals — shells mangle quotes in native-command arguments.

Note that `run` is the Run **button** element, not the driver function; probes click it and poll
`dataset.runs`, because the driver's `run()` is module-scoped and not a global.

Asset inspection (§2, §3, §6) used a small `ar` parser and SHA-256 comparison over the downloaded
bytes, plus `WebAssembly.Module.imports`/`exports` over the extracted `main.o`. The bundle probe in
§4 was a substring/occurrence count over the minified host source.
