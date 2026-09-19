// Where the three Fortran assets come from, and how they are read.
//
// Two sources behind one shape, because everything downstream only needs "give me this asset":
//
//   hosted   - a base URL, fetched. A page needs this, and so does any Node process that would
//              rather not read the files the package ships.
//   packaged - the assets that ship inside this package, on disk. Only something with a filesystem
//              can read those, which is why the browser entry requires a `baseUrl` and the Node one
//              does not.
//
// The Clang half is not resolved here at all. `@live-codes/clang-wasm` owns its own assets and its
// own `baseUrl`, and a `clangBaseUrl` is passed straight through to it.
import { ASSET_RECEIPTS } from './asset-receipts.js';

export function resolveFortranAssets(options, packaged) {
	if (options.baseUrl != null && options.baseUrl !== '') {
		return createHostedSource(options);
	}
	if (!packaged) {
		throw new Error(
			'baseUrl is required here. The assets that ship in this package can only be read where ' +
				'there is a filesystem, and a browser cannot reach a file inside an npm package - copy ' +
				'them somewhere your page can fetch with `npx --package @live-codes/fortran-wasm ' +
				'fortran-wasm-copy-assets <dir>` and pass that directory as baseUrl.'
		);
	}
	return createPackagedSource(packaged);
}

function createHostedSource(options) {
	const baseUrl = resolveBaseUrl(options.baseUrl);
	return {
		kind: 'hosted',
		key: `hosted\u0000${baseUrl}`,
		description: baseUrl,
		async read(name) {
			const url = new URL(name, baseUrl);
			// A verbatim mirror of the producer carries the two binaries gzipped at `<name>.gz`, so
			// both spellings are accepted. The receipt is over the inflated bytes either way.
			let response = await fetch(url);
			if (!response.ok) {
				response = await fetch(`${url}.gz`);
				if (!response.ok) {
					throw new Error(`Failed to load the Fortran asset ${url}: ${response.status}`);
				}
			}
			const raw = new Uint8Array(await response.arrayBuffer());
			return verifyReceipt(name, isGzip(raw) ? await inflateGzip(raw, name) : raw);
		}
	};
}

function createPackagedSource(packaged) {
	const source = {
		kind: 'packaged',
		key: `packaged\u0000${packaged.root.href}`,
		description: `the assets packaged with this library (${packaged.root.href})`,
		async read(name) {
			let bytes;
			try {
				bytes = await packaged.readFile(name);
			} catch (error) {
				throw new Error(
					`Failed to read the packaged asset ${name} from ${packaged.root.href}: ${error.message}`,
					{ cause: error }
				);
			}
			return verifyReceipt(name, bytes);
		}
	};
	return source;
}

// A page can resolve a relative URL against itself, which is what makes `/clang/` work as a baseUrl.
// Anything without a location - Node, most likely - has to be given an absolute one, because
// resolving `/clang/` there would quietly mean a path on a host that does not exist.
function resolveBaseUrl(value) {
	const normalized = value.endsWith('/') ? value : `${value}/`;
	const href = typeof globalThis.location === 'object' ? globalThis.location?.href : undefined;
	let url;
	try {
		url = href ? new URL(normalized, href) : new URL(normalized);
	} catch (cause) {
		throw new Error(
			`baseUrl must be an absolute http(s) URL, or relative to the page in a browser: ${cause.message}`,
			{ cause }
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`baseUrl must be http(s), got ${JSON.stringify(value)}`);
	}
	return url.href;
}

async function verifyReceipt(name, bytes) {
	const receipt = ASSET_RECEIPTS[name];
	if (!receipt) throw new Error(`No pinned receipt for the Fortran asset ${name}`);
	if (bytes.byteLength !== receipt.bytes) {
		throw new Error(`The Fortran asset ${name} is ${bytes.byteLength} bytes, expected ${receipt.bytes}`);
	}
	const digest = await sha256Hex(bytes);
	if (digest !== receipt.sha256) {
		throw new Error(
			`The Fortran asset ${name} failed SHA-256 verification: expected ${receipt.sha256}, got ${digest}`
		);
	}
	return bytes;
}

const isGzip = (bytes) => bytes.byteLength > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

async function inflateGzip(bytes, label) {
	if (typeof DecompressionStream !== 'function') {
		throw new Error(`Inflating the Fortran asset ${label} needs DecompressionStream`);
	}
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(bytes) {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new Error(
			'Verifying the Fortran assets needs crypto.subtle: a secure context in the browser, or ' +
				'Node 20 and later.'
		);
	}
	const digest = await subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
