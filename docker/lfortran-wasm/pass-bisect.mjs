// Find which LFortran pass removes `print *` inside a do loop.
//
//   node pass-bisect.mjs <dir with wasm_run.js / wasm_run.wasm / wasm_run.data>
//
// The entry point reads /skip.txt from the wasm filesystem before every run and hands those names to
// PassManager::passes_to_skip_with_llvm — its only public lever for this, folded into _skip_passes by
// parse_pass_arg() and honoured by apply_passes(). So a pass can be dropped without rebuilding: this
// loads the module once, then re-runs the loop program once per pass. A run is milliseconds.
//
// The pass names below are PassManager's own defaults, read from the constructor in pass_manager.h:
// thirty in _passes and nine in _optimization_passes. The suspects come first, because between 0.59.0
// and 0.60.0 only three pass sources changed at all: print_arr, implied_do_loops and array_op. If
// dropping one restores the loop print, that is the culprit.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const dir = resolve(process.argv[2] ?? '.');
const gz = join(dir, 'wasm_run.wasm.gz');
const raw = join(dir, 'wasm_run.wasm');
const wasmBinary = new Uint8Array(
	existsSync(gz) ? gunzipSync(readFileSync(gz)) : readFileSync(raw),
);
console.log(`dir: ${dir}`);
console.log(`wasm: ${wasmBinary.length.toLocaleString()} bytes`);

const LOOP = `program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
`;
const CONTROL = `program p
print *, 'hello'
end program
`;

// Suspects first: the only pass sources that differ between 0.59.0 and 0.60.0.
const PASSES = [
	'print_arr',
	'implied_do_loops',
	'array_op',
	'print_list_tuple',
	'print_struct_type',
	'array_struct_temporary',
	'array_passed_in_function_call',
	'pass_array_by_data',
	'array_dim_intrinsics_update',
	'pass_list_expr',
	'do_loops',
	'while_else',
	'select_case',
	'global_stmts',
	'init_expr',
	'function_call_in_declaration',
	'openmp',
	'transform_optional_argument_functions',
	'nested_vars',
	'forall',
	'class_constructor',
	'where',
	'symbolic',
	'intrinsic_function',
	'intrinsic_subroutine',
	'subroutine_from_function',
	'unused_functions',
	'unique_symbols',
	'insert_deallocate',
	'replace_with_compile_time_values',
	'loop_vectorise',
	'dead_code_removal',
	'sign_from_value',
	'div_to_mul',
	'fma',
	'inline_function_calls',
	'promote_allocatable_to_nonallocatable',
];

const out = [];
const err = [];
const glue = await import(pathToFileURL(join(dir, 'wasm_run.js')).href);
const factory = glue.default ?? glue.createLFortran;
if (typeof factory !== 'function') throw new Error('the glue did not export a factory');

const module = await factory({
	locateFile: (file) => join(dir, file),
	wasmBinary,
	print: (line) => out.push(line),
	printErr: (line) => err.push(line),
});
const run = module.cwrap('run_fortran', 'string', ['string']);
if (!module.FS) throw new Error('FS is not exported, so /skip.txt cannot be written');
console.log('module ready\n');

const call = (program, skip) => {
	out.length = 0;
	err.length = 0;
	try {
		module.FS.unlink('/skip.txt');
	} catch {
		// No skip list in place.
	}
	if (skip && skip.length) {
		module.FS.writeFile('/skip.txt', new TextEncoder().encode(`${skip.join('\n')}\n`));
	}
	let status = null;
	let threw = null;
	try {
		status = run(program);
	} catch (error) {
		threw = String(error?.message ?? error);
	}
	return { status, threw, stdout: out.join('\n'), stderr: err.join('\n') };
};

const flat = (s) => s.replace(/\s+/g, ' ').trim();

const defaults = call(LOOP, null);
console.log(`defaults: status=${JSON.stringify(defaults.status)} threw=${defaults.threw ?? '-'}`);
console.log(`  control (hello, defaults):   ${JSON.stringify(flat(call(CONTROL, null).stdout))}`);
console.log(`  loop with no passes skipped: ${JSON.stringify(flat(defaults.stdout))}`);

console.log('\n=== skipping one pass at a time ===');
let wins = 0;
for (const pass of PASSES) {
	const result = call(LOOP, [pass]);
	const fixed = flat(result.stdout) === '1 2 3';
	const note = result.threw ? ` threw=${result.threw}` : '';
	if (fixed) wins += 1;
	console.log(
		`${fixed ? 'FIXED   ' : 'still no'}  skip ${pass.padEnd(40)} stdout=${JSON.stringify(flat(result.stdout))}${note}`,
	);
}
console.log(`\n${wins} pass(es) restored the loop print.`);
if (wins > 0) {
	console.log('Follow up: check the control still prints, then try skipping exactly that pass');
	console.log('in a package build and re-run the corpus.');
}
