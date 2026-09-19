This package's own code is **MIT** (see `LICENSE`), and that is what the `license` field says. This
file is not a second license on it: it is the notice the third-party binaries in `assets/` require,
and the record of where each one came from.

Three files are not ours:

| Asset | What it is | License |
| --- | --- | --- |
| `f2c.wasm` | The `f2c` Fortran 77 → C translator, compiled to `wasm32-wasi` | The f2c notice below |
| `libf2c.a` | The `libf2c` runtime library the translated C links against - `main.o`, the I/O library, and the arithmetic and intrinsic routines | The f2c notice below |
| `f2c.h` | The header the translated C includes | The f2c notice below |

Each file's SHA-256 is pinned in `src/asset-receipts.js`, and `scripts/fetch-assets.mjs` refuses to
write one that does not match.

## The f2c notice

`f2c` and `libf2c` are distributed by [netlib](https://www.netlib.org/f2c/) under this notice, which
the three files carry by reference:

> Copyright 1990 - 1997 by AT&T, Lucent Technologies and Bellcore.
>
> Permission to use, copy, modify, and distribute this software and its documentation for any purpose
> and without fee is hereby granted, provided that the above copyright notice appear in all copies and
> that both that the copyright notice and this permission notice and warranty disclaimer appear in
> supporting documentation, and that the names of AT&T, Bell Laboratories, Lucent or Bellcore or any
> of their entities not be used in advertising or publicity pertaining to distribution of the software
> without specific, written prior permission.
>
> AT&T, Lucent and Bellcore disclaim all warranties with regard to this software, including all
> implied warranties of merchantability and fitness. In no event shall AT&T, Lucent or Bellcore be
> liable for any special, indirect or consequential damages or any damages whatsoever resulting from
> loss of use, data or profits, whether in an action of contract, negligence or other tortious action,
> arising out of or in connection with the use or performance of this software.

That is a permissive notice with an attribution condition, and the table above plus this reproduction
is that attribution.

## Provenance

The three files are **not** built by this package. They are the `wasm32-wasi` build produced by the
[`seo-rii/wasm-llvm`](https://github.com/seo-rii/wasm-llvm) project, fetched from the
`wasm-idle` mirror at `https://seorii.page/wasm-idle/wasm-fortran/` and pinned by the receipts in
`src/asset-receipts.js`. `scripts/fetch-assets.mjs` re-fetches exactly those bytes.

The upstream source is `f2c`'s current release (`f2c` 2020, `libf2c` from the same distribution), not
a fork. What the producer added is the toolchain, not the translator: the archive is a straight
`wasm32-wasi` build, which is why `f2c`'s own version banner reports `f2c (version 20200916)` in the
C it generates.

## The Clang half

This package compiles *through* Clang but does not contain it. The compiler, the linker, the in-memory
filesystem and the WASI sysroot belong to
[`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm), which ships them and
carries its own `THIRD-PARTY-NOTICES.md` for them - Apache-2.0 WITH LLVM-exception, Apache-2.0, MIT,
BSD-2-Clause, BSD-3-Clause and CC0. Nothing about this package changes those terms.

`dist/fortran-wasm.global.js` is the IIFE build, and it embeds that package's runtime together with
`@wasm-idle/llvm-core`, `@bjorn3/browser_wasi_shim` and `fflate`, all permissive (MIT, Apache-2.0, and
MIT OR Apache-2.0). Its banner is a three-line attribution and the detailed notices travel with
`@live-codes/clang-wasm`.

**Nothing copyleft is in this package or in that bundle**, so a consumer never has to think about it.
