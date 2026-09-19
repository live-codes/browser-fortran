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
