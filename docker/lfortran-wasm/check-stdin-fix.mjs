// Is the piece needed to clear stdin's end-of-file flag reachable from JavaScript?
//
//   node check-stdin-fix.mjs
//
// Once a run reads stdin at end-of-file, the C library's EOF flag stays set and every later run fails
// with "Failed to read input." even when input is supplied. The cure is clearerr(stdin), so this asks
// whether _clearerr and the stdin FILE* are reachable from the module — if they are, the host can fix
// it without rebuilding the wasm.
import { createCompiler } from '../../packages/lfortran-wasm/src/index.js';

const compiler = await createCompiler({ baseUrl: new URL('./out/', import.meta.url) });
const module = compiler.module;

const interesting = Object.keys(module).filter((key) =>
	/clearerr|stdin|fflush|rewind|getc|FILE/i.test(key),
);
console.log('module members matching clearerr/stdin/fflush/rewind:', interesting);
console.log('typeof module._clearerr:', typeof module._clearerr);
console.log('typeof module._stdin:', typeof module._stdin, 'value:', module._stdin);
console.log('typeof module._fflush:', typeof module._fflush);
console.log('typeof module._rewind:', typeof module._rewind);

// Exported data symbols live in the wasm instance's export table as globals holding their address.
const exports = module.wasmExports ?? module.asm?.exports ?? null;
console.log('wasm exports reachable:', exports ? typeof exports : 'no handle');
if (exports) {
	const data = Object.keys(exports).filter((key) => /stdin|clearerr|__heap_base/.test(key));
	console.log('exports matching stdin/clearerr/__heap_base:', data);
	if (exports._stdin) {
		const address = exports._stdin.value ?? exports._stdin;
		const filePointer = module.HEAP32[address >> 2];
		console.log('_stdin variable address:', address, 'FILE* value:', filePointer);
	}
}
