// Map wasm function indices to names, from the module's own name section.
//
//   node wasm-names.mjs <wasm-file> <index> [index...]
//
// A trap in Node reports `wasm-function[3924]:0xb5a381`, and V8 does not resolve that index through
// the name section even when the module carries one — which is why the -g2 build still showed indices.
// The name section is a custom section ("name") whose first subsection maps function indices to
// names, so it can be read straight from the bytes and the index named.
//
// This is what turns a bisect into a lookup.
import { readFileSync } from 'node:fs';

const bytes = new Uint8Array(readFileSync(process.argv[2]));
const wanted = process.argv.slice(3).map(Number);

let at = 8; // magic + version
const readU32 = () => {
	let result = 0;
	let shift = 0;
	for (;;) {
		const byte = bytes[at++];
		result |= (byte & 0x7f) << shift;
		if (!(byte & 0x80)) return result >>> 0;
		shift += 7;
	}
};
const readName = () => {
	const length = readU32();
	const text = new TextDecoder().decode(bytes.subarray(at, at + length));
	at += length;
	return text;
};

const names = new Map();
while (at < bytes.length) {
	const id = bytes[at++];
	const size = readU32();
	const end = at + size;
	if (id === 0) {
		const sectionName = readName();
		if (sectionName === 'name') {
			while (at < end) {
				const subId = bytes[at++];
				const subSize = readU32();
				const subEnd = at + subSize;
				if (subId === 1) {
					const count = readU32();
					for (let i = 0; i < count; i += 1) {
						const index = readU32();
						names.set(index, readName());
					}
				}
				at = subEnd;
			}
		}
	}
	at = end;
}

console.log(`function names in the module: ${names.size}`);
for (const index of wanted) {
	console.log(`  ${index}: ${names.get(index) ?? '(no name for this index)'}`);
}
