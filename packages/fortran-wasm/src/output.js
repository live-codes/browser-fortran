// The two small things both drivers need. Compiler diagnostics are not here: the filter that turns
// clang's and wasm-ld's output into lines lives with the runtime that produces it, and is imported
// from `@live-codes/clang-wasm/toolchain` rather than copied.

// The runtime compiles with `-fcolor-diagnostics`, so anything a program prints goes through here.
// Program output keeps its formatting, so only the escapes go.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export const cleanProgramOutput = (text) => String(text ?? '').replace(ANSI, '');

// stdin is read in chunks: whatever is handed over is consumed before the next read, and `null` means
// EOF. The whole input is offered once, so a program that reads more than it was given sees EOF
// rather than a repeat of its own input.
export const makeStdin = (input) => {
	if (input == null || input.length === 0) return () => null;
	if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
		throw new Error('stdin must be a string, a Uint8Array, or nothing at all.');
	}
	let sent = false;
	return () => {
		if (sent) return null;
		sent = true;
		return input;
	};
};
