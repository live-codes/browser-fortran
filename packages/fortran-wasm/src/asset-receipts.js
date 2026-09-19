// Receipts for the three wasm-side Fortran assets this package ships in `assets/`.
//
// They are pinned here because a consumer only has the package: there is nothing to read a lock file
// from. Every one of them is checked before the bytes are used - in packaged mode for all three, and
// in hosted mode too, which is what lets a mirror be trusted.
//
// The Clang half of the toolchain is not here. It belongs to `@live-codes/clang-wasm`, which ships
// and pins its own assets, and this package only asks it for a runtime.

/** Where `scripts/fetch-assets.mjs` gets them, and the version pin that script uses. */
export const ASSET_SOURCE = Object.freeze({
	mirror: 'https://seorii.page/wasm-idle/wasm-fortran/',
	version: '07632b188983a22f',
	producer: 'seo-rii/wasm-llvm'
});

// `bytes` and `sha256` describe the asset as the compiler reads it, i.e. after inflation: the mirror
// publishes the two binaries gzipped and a mirror is verified on the inflated bytes, not the wire.
export const ASSET_RECEIPTS = Object.freeze({
	'f2c.wasm': Object.freeze({
		bytes: 636297,
		sha256: 'c424b41cd1d33ec41878fbb0c2fc2f2fb42aa1586b3e6097390d48125739929f'
	}),
	'libf2c.a': Object.freeze({
		bytes: 461120,
		sha256: '06a036b00a77edce8a27f7cf2bf15538ff7ef5d88ba6d764e156d138c3bea225'
	}),
	'f2c.h': Object.freeze({
		bytes: 4707,
		sha256: '660cb39d8f39e360186b3343a554a20332a3ec9e0a1b6c4539d54aba8c2fc0ea'
	})
});
