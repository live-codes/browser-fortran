import { compilerDiagnostics, createToolchain } from '@live-codes/clang-wasm/toolchain';

/**
 * Compiles and runs Fortran in the browser.
 *
 * The pipeline is the real one, and none of it is a subset interpreter:
 *
 *   1. `f2c` (Fortran 77 -> C, compiled to wasm32-wasi) translates the source
 *   2. Clang 22.1.8 (wasm-llvm) compiles that C against a WASI sysroot
 *   3. wasm-ld links it against libf2c and the WASI emulation libraries
 *   4. the resulting WASI module is instantiated and run in this tab
 *
 * Steps 2 to 4 are `@live-codes/clang-wasm`'s runtime, borrowed through its
 * low-level `/toolchain` entry. Fortran is not C, C++ or Objective-C, so it
 * brings its own frontend, its own runtime library and its own link line, and
 * takes only the compiler - and because it takes it from the package's shared
 * runtime, a page that also runs C/C++ pays for one toolchain, not two.
 *
 * Everything is a static file fetched over HTTP. The toolchain is acquired on
 * the first Run and then reused, because it is far heavier than the page.
 *
 * Where the bytes come from:
 *   - Clang, LLD, memfs and the sysroot: `clangBaseUrl`, default `/clang/`,
 *     which is what `npx @live-codes/clang-wasm-copy-assets public/clang` writes.
 *   - f2c and libf2c: `fortranBaseUrl`. They are not part of that package.
 * Both can be overridden by query parameter.
 */

const DEFAULT_FORTRAN_BASE_URL = 'https://seorii.page/wasm-idle/wasm-fortran/';
const DEFAULT_CLANG_BASE_URL = '/clang/';

const MAX_ASSET_BYTES = 64 * 1024 * 1024;

// The mirror names its compiler binaries with a `.gz` suffix; the receipts below
// describe the *decompressed* bytes, so a run either has the exact artifact the
// receipts pin or it stops.
const EXECUTION_ASSET_VERSION = '07632b188983a22f';
const EXECUTION_ASSETS = {
  'f2c.wasm': {
    bytes: 636297,
    sha256: 'c424b41cd1d33ec41878fbb0c2fc2f2fb42aa1586b3e6097390d48125739929f',
  },
  'libf2c.a': {
    bytes: 461120,
    sha256: '06a036b00a77edce8a27f7cf2bf15538ff7ef5d88ba6d764e156d138c3bea225',
  },
  'f2c.h': {
    bytes: 4707,
    sha256: '660cb39d8f39e360186b3343a554a20332a3ec9e0a1b6c4539d54aba8c2fc0ea',
  },
};

/**
 * f2c emits calls that the reference libf2c expects from the host platform:
 * `fiprintf`/`siprintf`/`__small_sprintf` (newlib spellings) and `signal`.
 * Without these the linked module fails to instantiate. `tmpfile` returns NULL
 * because a WASI module has nowhere to put one.
 *
 * `__SIG_IGN` is the other half of that: libf2c's `main.o` passes newlib's
 * signal-ignore sentinel to `signal()`, and records it as a function symbol, so
 * it has to exist as one for the entry point to link at all. WASI has no
 * signals and the `signal` shim above discards the handler, so a no-op is the
 * entire requirement.
 */
const F2C_COMPAT_SOURCE = `#include <stdarg.h>
#include <stdio.h>

typedef void (*sighandler_t)(int);

void __SIG_IGN(int signum) {
    (void)signum;
}

int fiprintf(FILE *stream, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int result = vfprintf(stream, format, ap);
    va_end(ap);
    return result;
}

int siprintf(char *str, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int result = vsprintf(str, format, ap);
    va_end(ap);
    return result;
}

int __small_sprintf(char *str, const char *format, ...) {
    va_list ap;
    va_start(ap, format);
    int result = vsprintf(str, format, ap);
    va_end(ap);
    return result;
}

sighandler_t signal(int signum, sighandler_t handler) {
    (void)signum;
    return handler;
}

FILE *tmpfile(void) {
    return NULL;
}
`;

const EXAMPLES = [
  {
    name: 'Hello world',
    code: `      PROGRAM HELLO
      PRINT *, 'Hello from Fortran!'
      PRINT *, 'Compiled and run in your browser, with no server.'
      END
`,
  },
  {
    name: 'DO loop',
    code: `      PROGRAM SQUARES
      INTEGER I, SQ
      DO 10 I = 1, 10
         SQ = I * I
         PRINT *, 'n=', I, '  n squared=', SQ
   10 CONTINUE
      PRINT *, 'Done.'
      END
`,
  },
  {
    name: 'Arrays, DATA and REAL arithmetic',
    code: `      PROGRAM STATS
      REAL X(5), TOTAL, AVG
      INTEGER I
      DATA X /1.0, 2.0, 3.0, 4.0, 5.0/
      TOTAL = 0.0
      DO 20 I = 1, 5
         TOTAL = TOTAL + X(I)
   20 CONTINUE
      AVG = TOTAL / 5.0
      PRINT *, 'Sum  = ', TOTAL
      PRINT *, 'Mean = ', AVG
      END
`,
  },
  {
    name: 'READ from stdin',
    code: `      PROGRAM ADDER
      INTEGER A, B
      PRINT *, 'Enter two integers, one per line:'
      READ *, A
      READ *, B
      PRINT *, 'Sum = ', A + B
      END
`,
  },
  {
    name: 'A compile error (shown as diagnostics)',
    code: `      PROGRAM BROKEN
      INTEGER I, TOTAL
      TOTAL = 0
      DO 10 I = 1, 3
         TOTAL = TOTAL + I
      PRINT *, 'Total = ', TOTAL
      END
`,
  },
];

function resolveBaseUrl(param, fallback) {
  const override = (new URLSearchParams(location.search).get(param) ?? '').trim();
  const base = override === '' ? fallback : override;
  // The runtime requires an absolute http(s) asset URL, so a relative override
  // is resolved against the page - that is what lets the same-origin
  // `?clangBaseUrl=/clang/` work when the assets are served alongside the page.
  const absolute = new URL(base.endsWith('/') ? base : `${base}/`, location.href).href;
  return { baseUrl: absolute, isOverride: override !== '' };
}

const fortranMirror = resolveBaseUrl('fortranBaseUrl', DEFAULT_FORTRAN_BASE_URL);
const clangMirror = resolveBaseUrl('clangBaseUrl', DEFAULT_CLANG_BASE_URL);

const el = {
  editor: document.getElementById('editor'),
  filename: document.getElementById('filename'),
  examples: document.getElementById('examples'),
  run: document.getElementById('run'),
  clear: document.getElementById('clear'),
  status: document.getElementById('status'),
  duration: document.getElementById('duration'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  stdin: document.getElementById('stdin'),
  output: document.getElementById('output'),
  diagnostics: document.getElementById('diagnostics'),
  fortranUrl: document.getElementById('fortran-url'),
  fortranOverride: document.getElementById('fortran-override'),
  clangUrl: document.getElementById('clang-url'),
  clangOverride: document.getElementById('clang-override'),
};

// The browser probes drive the page by element id rather than by evaluating
// string literals, which some shells mangle when passing arguments.
Object.assign(window, el);

let toolchain = null;
let f2cModule = null;
let running = false;

function setStatus(token, label, kind = '') {
  el.status.textContent = label;
  el.status.className = `badge ${kind}`;
  document.documentElement.dataset.status = token;
}

function setProgress(text) {
  el.progress.hidden = text === null;
  if (text !== null) el.progressText.textContent = text;
}

function append(node, text) {
  if (!text) return;
  node.appendChild(document.createTextNode(text));
  node.scrollTop = node.scrollHeight;
}

const ANSI = /\x1B\[[0-9;]*m/g;

/** Compilers colour their output; the pane renders plain text, so strip it. */
function appendDiagnostics(text) {
  append(el.diagnostics, text.replace(ANSI, ''));
}

function clearOutput() {
  el.output.replaceChildren();
  el.diagnostics.replaceChildren();
  el.duration.textContent = '';
}

function loadExample(index) {
  el.editor.value = EXAMPLES[index].code;
  el.examples.value = String(index);
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser has no DecompressionStream; cannot inflate the gzip asset.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Fetches one pinned compiler asset and refuses to return anything that is not
 * byte-identical to its receipt, so a moved or tampered mirror fails loudly
 * instead of producing a wrong answer.
 */
async function fetchVerifiedAsset(name) {
  const receipt = EXECUTION_ASSETS[name];
  const url = (path) => `${fortranMirror.baseUrl}${path}?v=${EXECUTION_ASSET_VERSION}`;

  let response = await fetch(url(name), { cache: 'force-cache' });
  let bytes;
  if (response.ok) {
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    // The mirror stores the compiled binaries gzipped, under the same name plus
    // `.gz`; the plain name is only there for mirrors that ship it raw.
    response = await fetch(url(`${name}.gz`), { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error(`could not load ${name} (HTTP ${response.status})`);
    }
    bytes = await gunzip(new Uint8Array(await response.arrayBuffer()));
  }

  if (bytes.byteLength !== receipt.bytes) {
    throw new Error(`${name} is ${bytes.byteLength} bytes, expected ${receipt.bytes}`);
  }
  const digest = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== receipt.sha256) {
    throw new Error(`${name} failed its SHA-256 check`);
  }
  return bytes;
}

/** The toolchain is large, so it is acquired on first use and then reused. */
async function ensureToolchain() {
  if (toolchain) return toolchain;

  setStatus('loading', 'loading toolchain…', 'busy');
  setProgress('Downloading f2c, Clang and the WASI sysroot…');
  const started = performance.now();

  const [f2cBytes, libf2cBytes, f2cHeaderBytes] = await Promise.all([
    fetchVerifiedAsset('f2c.wasm'),
    fetchVerifiedAsset('libf2c.a'),
    fetchVerifiedAsset('f2c.h'),
  ]);
  const f2cHeader = new TextDecoder().decode(f2cHeaderBytes);

  // `createToolchain` acquires the same runtime `createCompiler` uses, so this
  // shares the Clang that C, C++ and Objective-C would use rather than loading
  // a second copy of it.
  const acquired = await createToolchain({
    baseUrl: clangMirror.baseUrl,
    maxAssetBytes: MAX_ASSET_BYTES,
  });

  // The generated C includes "f2c.h" and is linked against libf2c, both from the
  // directory the compiler works in.
  acquired.addFile('f2c.h', f2cHeader);
  acquired.addFile('libf2c.a', libf2cBytes);
  acquired.addFile('libf2c_main.o', extractArchiveMember(libf2cBytes, 'main.o'));

  f2cModule = await WebAssembly.compile(f2cBytes);
  toolchain = acquired;
  document.documentElement.dataset.toolchainMs = String(
    Math.round(performance.now() - started),
  );
  setProgress(null);
  return toolchain;
}

/**
 * Pulls one member out of a `!<arch>` archive. libf2c's C entry point only
 * exists as an archive member, and the linker will not extract it on its own
 * (see the `libf2c_main.o` link argument), so the bytes are handed over
 * directly. Handles both short names and GNU long-name references.
 */
function extractArchiveMember(archive, wanted) {
  const text = (start, length) => new TextDecoder().decode(archive.subarray(start, start + length));
  if (text(0, 8) !== '!<arch>\n') throw new Error('libf2c.a is not an ar archive');

  let longNames = '';
  for (let pos = 8; pos + 60 <= archive.byteLength; ) {
    const rawName = text(pos, 16).trim();
    const size = Number(text(pos + 48, 10).trim());
    const body = archive.subarray(pos + 60, pos + 60 + size);
    pos += 60 + size + (size % 2);

    if (rawName === '//') {
      longNames = new TextDecoder().decode(body);
      continue;
    }
    if (rawName === '/' || rawName === '/SYM64/') continue;

    const name = /^\/\d+$/.test(rawName)
      ? longNames.slice(Number(rawName.slice(1))).split('\n')[0].replace(/\/$/, '')
      : rawName.replace(/\/$/, '');

    if (name === wanted) return new Uint8Array(body);
  }
  throw new Error(`libf2c.a has no member named ${wanted}`);
}

function stem(value) {
  const base = value.split('/').pop() || 'main';
  return base.replace(/\.[^.]+$/, '') || 'main';
}

/** Step 1: Fortran -> C, by running `f2c` as a WASI command. */
async function translateToC(code, inputPath) {
  const command = await toolchain.runCommand(f2cModule, {
    args: [inputPath],
    env: { TMPDIR: '/tmp' },
    files: [{ path: inputPath, contents: code }],
    programName: 'f2c.wasm',
  });

  // f2c prefixes its messages with the input file and program unit, and emits
  // that preamble even when it has nothing further to say, so its output is
  // surfaced only when it actually fails.
  if (command.exitCode) {
    const messages = `${command.stderr}${command.stdout}`;
    if (messages) appendDiagnostics(messages);
    throw new Error(`f2c exited with ${command.exitCode}`);
  }

  const cPath = `${stem(inputPath)}.c`;
  const generated = command.readFile(cPath);
  if (!generated) throw new Error(`f2c did not produce ${cPath}`);
  return { cPath, cSource: new TextDecoder().decode(generated) };
}

/** Steps 2 and 3: compile the generated C and link it into a WASI module. */
async function compileAndLink(cPath, cSource) {
  const { runtime } = toolchain;
  const mainObj = `${stem(cPath)}.o`;
  const compatObj = 'f2c_compat.o';
  const wasmPath = `${stem(cPath)}.wasm`;

  // The generated C includes "f2c.h", which is mounted at the filesystem root;
  // `-w` keeps f2c's own warnings out of a playground's diagnostic pane.
  await runtime.compile({
    input: cPath,
    code: cSource,
    obj: mainObj,
    language: 'C',
    compileArgs: ['-I.', '-w'],
  });
  await runtime.compile({
    input: 'f2c_compat.c',
    code: F2C_COMPAT_SOURCE,
    obj: compatObj,
    language: 'C',
    compileArgs: ['-w'],
  });

  const stackSize = 1024 * 1024;
  const libdir = 'lib/wasm32-wasi';
  const compilerRuntimeLibDir =
    runtime.compilerConfig?.compilerRuntimeLibDir || 'lib/clang/8.0.1/lib/wasi';
  const lld = await runtime.getModule(runtime.assetUrls.lld);
  await runtime.run(
    lld,
    runtime.log,
    'wasm-ld',
    '--export-dynamic',
    '-z',
    `stack-size=${stackSize}`,
    `-L${libdir}/noeh`,
    `-L${libdir}`,
    `${libdir}/crt1.o`,
    mainObj,
    compatObj,
    // f2c never emits a C `main`: it emits `MAIN__` and expects libf2c to supply
    // the entry point that initialises the runtime and then calls `MAIN__`. That
    // entry point is the archive member `main.o`, but the WASI crt references
    // `main` weakly, so wasm-ld is content to synthesise a trapping stub for it
    // rather than search the archive. Handing the member over as an object file
    // is what actually pulls it in; without it every program dies with
    // `unreachable` inside `undefined_weak:main`.
    'libf2c_main.o',
    'libf2c.a',
    '-lc',
    '-lm',
    `-L${compilerRuntimeLibDir}`,
    '-lclang_rt.builtins-wasm32',
    '-o',
    wasmPath,
  );

  const bytes = Uint8Array.from(runtime.memfs.getFileContents(wasmPath));
  return {
    bytes,
    wasm: await WebAssembly.compile(bytes),
    target: 'wasm32-wasi',
    format: 'wasi-core-wasm',
    fileName: wasmPath,
    language: 'C',
  };
}

/**
 * The runtime refills stdin by calling this repeatedly while the buffer is
 * empty, so it must yield the text once and then report end-of-input rather
 * than returning an empty string forever.
 */
function oneShotStdin(text) {
  let sent = false;
  return () => {
    if (sent || text === '') return null;
    sent = true;
    return text.endsWith('\n') ? text : `${text}\n`;
  };
}

async function run() {
  if (running) return;

  const source = el.editor.value;
  if (source.trim() === '') return;
  const code = source.endsWith('\n') ? source : `${source}\n`;

  running = true;
  el.run.disabled = true;
  clearOutput();
  // Per-run metrics are read by the browser probes; stale values would lie.
  for (const key of ['stage', 'f2cMs', 'compileMs', 'execMs', 'exitCode']) {
    delete document.documentElement.dataset[key];
  }

  const started = performance.now();
  try {
    await ensureToolchain();

    // The runtime owns one filesystem and one compiler process, and the
    // toolchain shares its lock with anything else using it, so a run holds it
    // from translation until the program has finished. Reading the artifact back
    // out of the filesystem has to be inside it for the same reason.
    const execution = await toolchain.lock(async () => {
      setStatus('compiling', 'translating…', 'busy');
      const f2cStarted = performance.now();
      const { cPath, cSource } = await translateToC(code, 'main.f');
      document.documentElement.dataset.f2cMs = String(Math.round(performance.now() - f2cStarted));

      setStatus('compiling', 'compiling…', 'busy');
      const compileStarted = performance.now();
      const built = await toolchain.captureCompilerOutput(() => compileAndLink(cPath, cSource));
      document.documentElement.dataset.compileMs = String(
        Math.round(performance.now() - compileStarted),
      );

      if (built.error) {
        // clang's and wasm-ld's own words, once the runtime's log lines and colour
        // are taken out of them.
        const diagnostics = compilerDiagnostics(built.raw).join('\n');
        appendDiagnostics(diagnostics || String(built.error?.message ?? built.error));
        throw new Error('compile or link failed');
      }

      setStatus('running', 'running…', 'busy');
      const execStarted = performance.now();
      const result = await toolchain.execute(built.result, {
        args: [],
        stdin: oneShotStdin(el.stdin.value.replace(/\r\n/g, '\n')),
        stdout: (chunk) => append(el.output, chunk),
        stderr: appendDiagnostics,
      });
      document.documentElement.dataset.execMs = String(Math.round(performance.now() - execStarted));
      return result;
    });

    document.documentElement.dataset.exitCode = String(execution.exitCode ?? 'null');

    setStatus(
      execution.exitCode ? 'error' : 'done',
      `exit ${execution.exitCode}`,
      execution.exitCode ? 'err' : 'ok',
    );
    el.duration.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (error) {
    setProgress(null);
    const message = error instanceof Error ? error.message : String(error);
    // Whatever the compiler already said stays, and this goes on its own line.
    appendDiagnostics(el.diagnostics.textContent ? `\n${message}` : message);
    setStatus('error', 'failed', 'err');
    el.duration.textContent = `${Math.round(performance.now() - started)} ms`;
  } finally {
    running = false;
    el.run.disabled = false;
    document.documentElement.dataset.runs = String(
      Number(document.documentElement.dataset.runs ?? 0) + 1,
    );
  }
}

EXAMPLES.forEach((example, index) => {
  el.examples.append(new Option(example.name, String(index)));
});

el.examples.addEventListener('change', () => loadExample(Number(el.examples.value)));
el.run.addEventListener('click', run);
el.clear.addEventListener('click', clearOutput);
el.editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    run();
  }
});

el.fortranUrl.textContent = fortranMirror.baseUrl;
el.fortranOverride.textContent = fortranMirror.isOverride ? '(from ?fortranBaseUrl)' : '(default)';
el.clangUrl.textContent = clangMirror.baseUrl;
el.clangOverride.textContent = clangMirror.isOverride ? '(from ?clangBaseUrl)' : '(default)';
document.documentElement.dataset.status = 'ready';
loadExample(0);
