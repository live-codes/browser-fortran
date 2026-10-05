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

The browser host is `@live-codes/clang-wasm`'s runtime, through the low-level `/toolchain` entry added
to that package for this spike (§8). It is the same Clang/LLD/WASI half that
`@wasm-idle/llvm-core/clang` provides — that package is built on it — but taking it from the package
means one runtime shared with C, C++ and Objective-C instead of a second one beside them, and it is
where the self-hosted assets and their receipts live.

The Fortran half is now a package too, `@live-codes/fortran-wasm` — in `packages/fortran-wasm`, and
published. It holds the frontend, the runtime library, the compat shim and the link line; the page in
`public/` is a harness around it and loads it from jsDelivr.

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
| `PRINT *, 'Hello from Fortran!'` | `Hello from Fortran!` / `Compiled and run in your browser, with no server.` | 26 ms | 1525 ms | 5 ms |
| `DO 10 I = 1, 10` + `SQ = I * I` | ten `n= N  n squared= N` lines, then `Done.` | 7 ms | 479 ms | 4 ms |
| `REAL X(5)` + `DATA X /…/` + mean | `Sum  =   15.` / `Mean =   3.` | 26 ms | 417 ms | 6 ms |
| a `SUBROUTINE` and an `INTEGER FUNCTION` in the same file | `doubled: 42` / `tripled: 42` | 5 ms | 316 ms | 4 ms |
| `READ *, A` / `READ *, B`, stdin `20\n22` | `Sum =  42` | 4 ms | 257 ms | 8 ms |
| `DO 10` with no `10 CONTINUE` | `Error on line 7 of main.f: missing statement label 10` (f2c) | — | — | — |
| `CALL NOSUCHSUB`, never defined | `wasm-ld: error: main.o: undefined symbol: nosuchsub_` | — | — | — |

The two failure rows are deliberately different shapes: a bad *program* is `f2c`'s to report, a bad
*link* is `wasm-ld`'s, and both arrive in the tool's own words.

`READ` is genuinely wired to stdin, which matters for competitive-programming-shaped programs. File
I/O works too, including a round trip — `OPEN`/`WRITE`/`CLOSE`, then `OPEN`/`READ` — which was
checked while mapping the surface below, as were subroutines and functions in either order.

### What does not work, and why

Three things were probed and fail, all for the same root cause:

| probe | result |
| --- | --- |
| `CALL GETARG(1, VALUE)` — argv | trap: `signature_mismatch:getarg_` |
| `CALL EXIT(3)` — a non-zero exit code | trap: `signature_mismatch:exit_` |
| `OPEN` a file that does not exist | trap: `signature_mismatch:err_` (after libf2c prints its own message) |

All three are calls *into* the runtime library. `f2c` knows those routines by name only, so it cannot
emit the interface `libf2c` was compiled with, and `wasm-ld` answers with a stub that traps instead of
failing the link. It is the same class of failure as §3b's `undefined_weak:main`, one level up: there
the linker stubbed a *missing* symbol, here it stubs a *mismatched* one.

Two consequences worth stating plainly, because they shape the package's API:

- **A Fortran program cannot read its own argv.** `GETARG` is the only way in, so `args` would be an
  option that changes nothing a program can observe — except `IARGC()`, which does work (it takes no
  arguments, so there is no signature to get wrong). There is deliberately no `args` option.
- **`STOP n` exits 0**, with `STOP n statement executed` on stderr. That is libf2c's behaviour, not a
  bug here, and it means a Fortran program has no easy way to report a failure status.

A trap like this used to escape the driver as a rejection. It does not any more: it comes back as a
result with `exitCode: null`, whatever the program managed to print, and a message that names the
routine where it can (§8).

### Where the wall between F77 and modern Fortran actually is

Measured, not assumed, by running each of these through the package. The boundary is not where "it is
Fortran 77" suggests — several Fortran 90 spellings work, and one of them is worse than a failure.

**Accepted and correct:** lowercase keywords; `!` comments; `IMPLICIT NONE`; `END DO` instead of a
labelled `CONTINUE`; `DO WHILE`. Those are F90-isms that f2c happens to take.

**Rejected, cleanly, with a line number:** free-form source (`illegal continuation card …`), which is
the first wall anyone pasting modern code hits; `INTEGER :: X` and `REAL(8) :: X` and
`CHARACTER(LEN=10)` (`syntax error`); whole-array arithmetic `B = A + 1.0` (`wrong number of
subscripts`); `MODULE`/`USE`, derived types, `ALLOCATABLE`, `CONTAINS` (`unclassifiable statement`).

**Accepted, and wrong.** `PRINT *, A(2:3)` on a `REAL A(4)` compiles, links, runs, exits 0, and prints
**all four elements**. f2c reads `x(a:b)` as a character-substring reference, does not reject it for a
numeric array, and generates the whole-array print without so much as a warning — its output for that
case is byte-identical to its output for a clean compile, so `errors` cannot see it and there is
nothing to surface. Assigning a section, `B(1:2) = A(3:4)`, is rejected (`substring of noncharacter b`),
so it is the read that goes quiet.

That is the single worst behaviour found in the whole spike, and it is not cheaply guardable: `S(1:3)`
on a `CHARACTER` is *valid* Fortran 77, so `x(a:b)` cannot be rejected wholesale without type
analysis. A playground that calls this entry plain `fortran` is inviting exactly this paste.

`SUM(A)` is a different flavour: f2c accepts the name, and the *link* fails with
`undefined symbol: sum_` — confusing, but at least loud.

## 6. Payload

Both halves ship inside their packages (§8), and both packages are published, so every byte now comes
from jsDelivr out of an `assets/` directory we control — nothing from a third party at run time, and
nothing to copy first. Two of the Clang assets differ from what the old demo mirror served, and both
differences matter:

| asset | bytes | from |
| --- | --- | --- |
| `clang/bin/clang.wasm.gz` | 15,721,977 | `@live-codes/clang-wasm` |
| `clang/bin/lld.wasm.gz` | 7,837,837 | `@live-codes/clang-wasm` |
| `clang/bin/sysroot.tar.gz` | **5,334,358** | `@live-codes/clang-wasm` — full libc++, not the pruned tree the mirror serves (5,059,892) |
| `clang/bin/memfs.wasm.gz` | **38,702** | `@live-codes/clang-wasm` — rebuilt, 4091 usable nodes, not the stock 1019 (18,974 bytes) |
| `fortran/f2c.wasm` | 636,297 | `@live-codes/fortran-wasm` (shipped raw; the mirror serves it gzipped at 225,632) |
| `fortran/libf2c.a` | 461,120 | `@live-codes/fortran-wasm` (155,956 gzipped on the mirror) |
| `fortran/f2c.h` | 4,707 | `@live-codes/fortran-wasm` |
| `clang/runtime-manifest.v1.json` | 876 | `@live-codes/clang-wasm` |
| host JS (both packages + `@wasm-idle/llvm-core` + the WASI shim) | ~245,000 | npm |
| **total** | **~29.8 MB** | |

The memfs difference is not cosmetic for Fortran. The stock memfs has 1019 usable nodes and the stock
sysroot already consumes 978 of them, so this pipeline — `f2c.h`, `libf2c.a`, `libf2c_main.o`, the
source, the generated C, two objects and the linked module — is squeezing into about 41 free nodes. It
fits, but a second Fortran source file or a larger program could plausibly exhaust it. The package's
rebuilt memfs removes that ceiling.

Unlike the COBOL pipeline, the Clang runtime's own `sysroot.tar.gz` **is** downloaded here — COBOL
overrides it with its own `c-sysroot.tar.gz`, and Fortran has no such override.

Measured toolchain load: **~21 s** cold from jsDelivr — the ~29 MB above over the wire, then 44 MB of
clang and the 19 MB sysroot to decompress — and a few seconds on a repeat visit. That remainder is the
unpack rather than the fetch: with the same assets served from localhost it measured ~7 s. It happens
once per page.

### Serving the `.gz` assets from a CDN works, and it is not obvious why

Four of the nine assets are *named* `.gz`, and the runtimes inflate them themselves. A CDN that decides
to serve one with `Content-Encoding: gzip` would have the client transparently decompress it, and the
loader would then try to inflate plain wasm — a failure that looks like a corrupt asset rather than a
hosting configuration. So it was checked rather than assumed, on every asset either half fetches:

| asset | in transit | gzip magic intact |
| --- | --- | --- |
| `bin/clang.wasm.gz` (15.7 MB) | `Content-Encoding: (none)` | yes |
| `bin/lld.wasm.gz` (7.8 MB) | `(none)` | yes |
| `bin/sysroot.tar.gz` (5.1 MB) | `(none)` | yes |
| `bin/memfs.wasm.gz` (38 KB) | `(none)` | yes |
| `runtime-manifest.v1.json` | `br` | n/a |
| `f2c.wasm`, `libf2c.a`, `f2c.h` | `br` | n/a |

jsDelivr compresses the files that are not already compressed and leaves the `.gz` ones alone, which is
exactly what both loaders need. Every response also carries `Access-Control-Allow-Origin: *`, so a page
on another origin can fetch them.

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
- **The `main.o` extraction (§3b) lives in `@live-codes/fortran-wasm`** — it is ~25 lines of `ar`
  parsing that exist solely because of this toolchain's linking behaviour, and it travels with the
  pinned assets it understands. The same goes for the compat shim (§3c) and the link line.
- **Take the compiler from `@live-codes/clang-wasm/toolchain`, not from `@wasm-idle/llvm-core`
  directly** (§8). A second `BrowserClangRuntime` is a second ~28 MB asset load and a second ~84 MB
  resident, and LiveCodes already has the first one for C/C++/Objective-C.
- **Ship the Fortran half as `@live-codes/fortran-wasm`**, which is what this repository now does —
  `createCompiler(options).run(code, stdin)`, the same shape as `@live-codes/clang-wasm`'s language
  API, with the three assets and their receipts inside the package.
- **Assets:** both halves are now packages that ship their own and pin the receipts, so the remaining
  work is to publish them rather than to mirror `seorii.page`. A CDN copy is still worth doing —
  `fortran-wasm-copy-assets` and `clang-wasm-copy-assets` write an `asset-receipts.json` beside the
  copy for whoever serves it.

## 8. The two packages, and what they cost

### `@live-codes/clang-wasm` gained a low-level entry

`@live-codes/clang-wasm` runs C, C++ and Objective-C through `createCompiler(language).run(code, stdin)`.
That API cannot express this pipeline: the entry point and the link line are decided inside its
drivers, and Fortran needs both to be its own — `MAIN__` plus libf2c's `main.o` instead of `main`, and
`libf2c.a` on the link line. Its own `linkObjectiveC()` exists for exactly this reason ("the runtime's
link line cannot carry libobjc.a"), so Fortran is the same problem a second time.

So the package got a second, low-level entry rather than a change to the first one:
`@live-codes/clang-wasm/toolchain`, exporting `createToolchain`, `compilerDiagnostics` and — added
afterwards, when a driver needed them — `CLANG_DRIVER_DEFAULT_ARGS`. It hands back the runtime plus
`addFile`, `lock`, `captureCompilerOutput`, `runCommand` and `execute`: the plumbing, with no policy
about which objects to link.

**It shares the runtime with `createCompiler`.** Both acquire from one pool keyed by asset source, so
a page running C/C++ *and* Fortran pays for one ~28 MB load and one ~84 MB resident copy, and both
queue on the same lock. Two `createToolchain()` calls return objects whose `.runtime` is the same
object; that identity is asserted in the package's tests.

**Nothing existing changed.** `createCompiler`, `LANGUAGE_IDS` and `standardsFor` are untouched. The
only edits to existing files were moving one private helper (`captureCompilerOutput`) from
`compile.js` to `runtime.js` so that both entries could use it, and adding the new exports.

**Bundle size.** The language bundle `dist/clang-wasm.global.js` is **unchanged at 302,713 bytes**: the
new entry is a separate subpath, so a consumer that does not import it does not pay for it. The
low-level entry gets its own IIFE, `dist/clang-wasm-toolchain.global.js` (290.8 KB), exposed as
`@live-codes/clang-wasm/iife/toolchain` for the classic workers LiveCodes' language modules run in.
`npm run build:iife` writes both.

**One bug found here, in someone else's later change.** `CLANG_DRIVER_DEFAULT_ARGS` was added to the
`browser` entry of `/toolchain` and not to the `node` one, so a Node consumer importing it got
`SyntaxError: does not provide an export named` — which is exactly what happened to this package. The
Node entry now exports it, a test asserts that both entries export the same names (a driver only ever
sees the one its environment resolves, so nothing else would catch the drift), and both fixes went out
in the published `0.2.0`. This package depends on `@live-codes/clang-wasm@^0.2.0` from the registry
and its 17 tests pass against it with no dev link.

### `@live-codes/fortran-wasm` is new

The Fortran half is now its own package, `packages/fortran-wasm`, in the same shape as
`packages/clang-wasm` beside it: `createCompiler(options)` returning `{ language, dialect, run,
dispose }`, assets and their receipts inside the package, a `fortran-wasm-copy-assets` bin for
browsers, a Node and a browser entry, and an IIFE bundle at 299.3 KB for classic workers.

It carries everything §3 taught: the compat shim for `fiprintf`/`__SIG_IGN`/`signal`/`tmpfile`, the
`ar` extraction of libf2c's `main.o`, and the hand-written `wasm-ld` line that uses it. That knowledge
was in the demo's driver; it belongs with the pinned assets it depends on, and the demo is now a
harness that only renders what the package returns.

Two things the package does that the demo's driver did not:

- **A trap comes back as a result, not a rejection.** Calling `GETARG` used to throw out of `run()` and
  out of the caller's `await`. It now returns `exitCode: null`, whatever the program printed, and a
  message naming the trapping routine where the stack allows (§5).
- **There is no `args` option.** §5 explains why: a program cannot read its argv, so passing one would
  be an option with no observable effect. The probe that established this is the reason the option was
  removed rather than shipped and documented.

Verified in its own suite: **17 tests**, all real compiles in Node with no server — a program,
subroutines and functions, a file round-trip, stdin, all three failure modes, the result shape, the
shared toolchain, and that each shipped asset hashes to its receipt.

### The other bug found on the way

The documented way to fetch the assets, `npx @live-codes/clang-wasm-copy-assets`, does not work —
`npx` reads that as a *package* name, and the package is `@live-codes/clang-wasm`. It is
`npx --package @live-codes/clang-wasm clang-wasm-copy-assets <dir>`. Fixed in the package's README, in
the error message that tells users the same thing, and used by this repository's `npm run assets`.

## 9. Reproducing the verification

```bash
npm start                   # → http://localhost:8127/   (no isolation — the default)
npm run check               # syntax-check serve.js and public/main.js
npm run start:isolation     # same page with COOP/COEP, to compare
npm --prefix packages/fortran-wasm test           # 17 real compiles, no server
```

There is nothing to fetch or copy first. `public/` is two files — an import map with one entry, naming
`@live-codes/fortran-wasm@0.1.0` on jsDelivr, and a `main.js` that drives it — and the ~29 MB of wasm
comes from that package's `assets/` and `@live-codes/clang-wasm`'s, both published, both on the same
CDN. Point either half elsewhere with `?fortranBaseUrl=` and `?clangBaseUrl=`.

The Clang half is worth spelling out because it is invisible here: it arrives through
`@live-codes/fortran-wasm`'s own `^0.2.0` dependency, which jsDelivr rewrites to an absolute URL — the
same URL a page would map by hand, so the two share one module instance and one runtime. Nothing under
`public/` mentions `@live-codes/clang-wasm` at all.

**One gotcha in the no-bundler setup**, worth knowing before debugging it as a toolchain fault:

- The runtime insists on absolute http(s) for its asset URLs, so a relative `baseUrl` is rejected —
  which is why `serve.js`'s defaults are turned into absolute ones against the page before the page
  ever sees them.

And one that is now history, kept because it cost an hour and would cost the next person the same:
for a while `/toolchain` re-exported `CLANG_DRIVER_DEFAULT_ARGS` from clang-wasm's `compile.js`, which
imports `@wasm-idle/llvm-core/core/clang-profile`. That put a deep, easily-unmapped specifier on the
path of *every* toolchain consumer, so a page that resolves its own specifiers had to map it or
nothing ran at all — the failure mode was `Failed to resolve module specifier` at import time, with no
compiler involved and no hint of the toolchain. 0.2.0 moved the constant into `clang-flags.js`, a leaf
module with no imports, so the entry no longer reaches the four-language drivers: the bundle went from
mentioning `clang-profile` to not containing the string at all, and it is 6.5 KB where the package's
main entry is still 11.5 KB with the drivers in it.

Driven here with the `agent-browser` CLI against headless Chrome: select the example, click Run, and
read `document.documentElement.dataset` (`status` / `runs` / `exitCode` / `toolchainMs` /
`translateMs` / `compileMs` / `runMs`) plus the `#output` and `#diagnostics` panes. Element ids are
exposed as globals (`editor`, `run`, `stdin`, `output`, `diagnostics`, `examples`) so probes can avoid
string literals — shells mangle quotes in native-command arguments.

Note that `run` is the Run **button** element, not a function; probes click it and poll `dataset.runs`,
because the driver's `run()` is module-scoped and not a global. One more probe hazard: an `eval` whose
expression is object-literal-heavy is easy to get subtly wrong, and the failure is a bare
`SyntaxError` rather than anything about the page.

Asset inspection (§2, §3, §6) used a small `ar` parser and SHA-256 comparison over the downloaded
bytes, plus `WebAssembly.Module.imports`/`exports` over the extracted `main.o`. The bundle probe in
§4 was a substring/occurrence count over the minified host source. When the page looked broken and the
server looked fine, walking the module graph over HTTP from the page's own entry — fetching each
module and resolving its specifiers through the import map — found the unmapped one immediately.

---

# Part two — LFortran, measured

Everything in §1–§9 is the f2c spike. This part is the LFortran replacement, and like the first it is
all run, not inferred: the compiler was built, the published builds were driven, and the four cases
that decide the question were executed.

## 10. No published LFortran build can be shipped

`lfortran.github.io/wasm_builds` publishes a build of every commit, indexed by `data.json`, and that is
what dev.lfortran.org runs. **Every one of them is `-DWITH_LLVM=no`**: LFortran's own wasm backend emits
a module directly, with no LLVM, no LLD and no `dlopen`. The artifacts are small and current — and they
cannot compile ordinary modern Fortran. Against release `e8c53fddf` (0.59.0):

| feature | wasm backend | LLVM backend @ 0.59.0 |
| --- | --- | --- |
| `print *` in a `do` loop | works | works |
| module + contained procedure | works | works |
| derived-type member access (`q%x`) | `visit_StructInstanceMember() not implemented` | works |
| array section (`a(2:3)`) | `visit_ArraySection() not implemented` | works |
| allocatable array (`allocate(v(3))`) | `visit_Allocate() not implemented` | works |
| `read` / stdin | aborts with `CodeGenAbort` | works |
| real `sqrt`, string concatenation | works | works |

None of it is fixed on `main`. At `0.66.0-602-gd981ac1f4` the same four features fail, and the
diagnostics have *degraded* from named `visit_X() not implemented` to a bare `LCompilersException`.
`read` aborts on every published build from 0.52.0 through 0.66.0, so it is a long-standing limitation
rather than a regression.

That ruled out the wasm backend for a playground — no derived types, no array sections, no
allocatables, no stdin — which left the LLVM backend, which is where the published set has nothing for
us at all.

## 11. The regression, and how narrow it is

The LLVM backend has one problem of its own. Same pipeline, same program, only the build changed:

| release | wasm | `do` loop with `print *` |
| --- | --- | --- |
| 0.52.0 (`b5e05bd3a`) | 22.32 MiB | `1 2 3` |
| **0.59.0 (`e8c53fddf`)** | **11.75 MiB** | **`1 2 3`** |
| 0.60.0 (`2f734343f`) | 12.00 MiB | nothing |
| 0.62.0 (`b84f57bb4`) | 13.51 MiB | nothing |
| 0.63.0 (`8f4dab985`) | 13.65 MiB | nothing |
| 0.66.0 (`569035a33`) | 16.62 MiB | nothing |
| `dev` (`d981ac1f4`, 0.66.0+602) | 17.60 MiB | nothing |

The regression is between **0.59.0 and 0.60.0** and it is still present on `main`. The mechanism is
visible in the artifact rather than guessed: the broken build emits a module of **644 bytes** for that
program against **898** for the working one — smaller than a hello-world's 701 — so the statement is
dropped at codegen, not misdirected at runtime.

Its scope is narrow, which is what makes it worth working around rather than reporting as "LFortran
cannot do this". On 0.60.0 the *only* failing case out of five was the loop print: declaration and
assignment work, a loop whose body does arithmetic works, and `print *` after an empty loop works. Only
the combination fails, and `write (*, '(I0)') i` in the same loop prints correctly.

Nothing about this was concluded from reading source. **0.59.0 was built natively** — an x86 Linux
build against its own LLVM line, using the ref's own `llvm21` pixi environment, which sidesteps the
missing wasm environments entirely — and run:

```
=== version ===                LFortran version: 0.59.0   LLVM: 21.1.2
=== do loop with print * ===   1 2 3
=== derived type access ===    7.00000000e+00
=== array section ===          1.00000000e+00    1.00000000e+00
=== read from stdin ===        42
```

`--linker=gcc` there because LFortran links by invoking clang and the image has gcc; the compiler says
so itself.

## 12. What an official build's API actually is

Driving one of those builds directly took four corrections, each from an error rather than
documentation:

- **`callMain` is not exported.** The glue is a *classic* script that runs `main()` itself at load,
  taking its command line from `Module.arguments`. So a module can only be *evaluated* once per realm —
  its script-scope bindings (`ExitStatus` among them) cannot be redeclared — and `noInitialRun`
  without `callMain` leaves no way to start it.
- **The compile entry point is `emit_wasm_from_source`**, reachable with `cwrap`, because the heap
  helpers are not exported but `cwrap` marshals strings for you:
  `cwrap('emit_wasm_from_source', 'string', ['string'])`. It returns **`"<status>,<byte>,<byte>,…"`** —
  a status, then the module as decimal bytes; `nonzero` status carries LFortran's rendered diagnostic.
  `_emit_wat_from_source` returns readable WAT.
- **The filesystem is only partly reachable.** `FS`, `HEAPU8`, `UTF8ToString` and `stringToUTF8` all
  abort with "wasm not exported"; what *is* exported is the file packager's helper set —
  `FS_createDataFile`, `FS_createLazyFile`, `FS_createPreloadedFile`, `FS_createPath`,
  `FS_createDevice`, `FS_unlink`. There is no exported way to read a file back.
- **The CLI route compiles by emitting `p.out.js` and loading it.** Under Node that fails with
  `Cannot find module '…p.out.js'`, because the file lands in the virtual filesystem — and the
  "Compilation time / Execution time" lines dev.lfortran.org shows are printed by that generated
  harness, which is why they appear at all.

**And the run side is a fresh wasm instance per program**, which is the part worth copying: the
playground's own page chunk instantiates the compiled module against a WASI import object and calls
`_start()` between two `performance.now()` readings.

```js
{ wasi_snapshot_preview1: { fd_write (fd, iovs, count, written) { … } } }
instance.exports._start()
```

That is why a *published* build cannot have the shared-state problems our own long-lived module had,
and it is the design to prefer wherever it is available. It also reproduced the playground's timing to
the digit — `0.3 ms` against their `0.29999999701976765 ms` — which is how we know the harness matches
theirs rather than merely resembling it.

Building a module per compile is affordable because compiling many programs through one *loaded*
compiler is what `emit_wasm_from_source` allows; it is the *module evaluation* that cannot repeat.

## 13. Building 0.59.0 took six things

The port is `docker/lfortran-wasm/build-wasm-059.sh`. Every item below was found by running it, and
each one fails in a way that looks like something else:

1. **Its `[environments]` table had to be narrowed.** 0.59.0 lists `llvm7`…`llvm21` and `test`.
   `wasm-host` has to add the emscripten-wasm32 platform to the workspace, and pixi then validates
   *every* environment against it: `failed to solve requirements of environment 'test' for platform
   'emscripten-wasm32'`.
2. **The wasm features do not exist at that ref** and were appended from a later manifest — toolchain
   definitions, independent of LFortran's sources. The prefixed channel mirrors alone were not enough
   to resolve python; plain `conda-forge` had to be listed too.
3. **`python = "==3.12"` pins had to be loosened.** Pins in the *default* feature resolve for every
   environment, wasm32 included, where 3.12 is not published: `No candidates were found for python`.
   The same applies to the default feature's other native dependencies, which is why its tables are
   renamed out of the way — an implicit default environment is solved for every workspace platform, so
   it has to be empty.
4. **`HAVE_BUILD_TO_WASM` had to be defined** — the most interesting one, and upstream's own answer:

   ```cpp
   #if !defined(HAVE_BUILD_TO_WASM) && !defined(__ppc__)
   static_assert(sizeof(YYSTYPE) == sizeof(Vec<AST::ast_t*>));
   #endif
   ```

   The equality holds on a 64-bit host and not on wasm32. The `$__ppc__` clause gives it away: this is
   a known portability boundary, guarded, and the guard only needed the macro. Defining it rather than
   enabling `LFORTRAN_BUILD_TO_WASM` keeps the emit-only CLI out of the build.
5. **LLVM 21 had to be specified as a range, and installed separately.** `llvm==21.1.2` has no candidate
   on the wasm channel where `llvm>=21,<22` resolves — and `pixi add` only edits the manifest, so
   without a following `pixi install -e wasm-host --platform emscripten-wasm32` the build silently
   links the *image's* LLVM. It did, and the failure looked like a Fortran problem:
   `no member named 'CreateGlobalStringPtr' in 'llvm::IRBuilder<>'`, which is LLVM 22's API.
6. **The terminator patch had to be switched off.** `getTerminatorOrNull()` and `hasTerminator()` both
   arrived in **LLVM 22**, so against 21 neither exists to patch in — and neither is needed, because
   the behaviour change that motivated the patch is also LLVM 22's.

Two smaller traps: `git fetch --tags` in the image's shallow clone tries to fetch every tag in the
repository and looks like a hang (`git fetch --depth 1 origin tag v0.59.0` is the fix), and `pixi add`
has no `--dry-run` — it prints what it resolves, which is the useful part.

The runtime `.mod` files come from the native build of the same commit rather than from
`wasm-build0.sh`, which does not exist at this ref. They are generated by an *unpatched* native build
and so say `0.59.0`, which is why the build script's `-dirty` strip matters: a compiler that reports
`0.59.0-dirty` refuses to load them, and every program that touches `use iso_fortran_env` or `open`
dies with `Incompatible format`.

## 14. The artifact, and what is left

`docker/lfortran-wasm/out-059/`, built from v0.59.0 against LLVM 21:

| asset | bytes |
| --- | --- |
| `wasm_run.wasm` | 57,186,792 (54.5 MiB) |
| `wasm_run.js` | 566,837 |
| `wasm_run.data` | 72,569 |

54.5 MiB against 63.70 MiB for the `v0.66.0` build this package shipped before — and, unlike the
published wasm-backend builds, complete. It carries the `clearerr(stdin)` fix in
`wasm-run-main.cpp`, so the stdin poisoning described in the package README is fixed in the artifact
rather than worked around in the host.

Verified so far: the compiler, natively, on the four cases above. **Not yet verified: the wasm module
itself** — "linked cleanly" is not "runs correctly", and the four cases still have to be run through
it. After that the assets get vendored, the loader goes back to the `run_fortran` shape (the artifact
is the LLVM backend with our own entry point, not an official build's `emit_wasm_from_source`), and the
package is republished.

The loader written to drive the *official* builds — `cwrap` plus the WASI runner — is kept as a tool
rather than deleted: it is how the ladder in §11 was measured, and how any future published build can
be assessed without building anything. `docker/lfortran-wasm/capabilities.mjs` reports a build's
feature support one case at a time, and `pipeline.mjs` runs a single program through any build in
`<type>/<commit>` form.

One methodological note, because it cost real time and would cost the next person the same: **check
output, not exit codes.** Two of the corpus cases this repository runs with only `exitCode === 0`
passed while printing nothing at all, and the loop regression was found only after every assertion was
tightened to compare stdout. A silent compiler and a working one are indistinguishable by exit code,
and the silent one is the harder bug.
