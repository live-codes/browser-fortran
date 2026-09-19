import { createCompiler } from '@live-codes/fortran-wasm';

/**
 * A page around `@live-codes/fortran-wasm`.
 *
 * The compiler is the package's. This file is the harness - examples, a Run button, two output panes,
 * and the timings the browser probes read back - so everything about compiling Fortran lives in one
 * place, and a LiveCodes language module would use the same package.
 *
 * The toolchain has two halves, and each package ships its own wasm. Both are fetched from jsDelivr,
 * straight out of the package that publishes them:
 *   - `@live-codes/fortran-wasm@0.1.0/assets/` - f2c, libf2c and the header
 *   - `@live-codes/clang-wasm@0.2.0/assets/`   - Clang, LLD, memfs and the sysroot
 * Each can be pointed somewhere else with `?fortranBaseUrl=` and `?clangBaseUrl=` - at a mirror of
 * our own, say, or a directory `*-copy-assets` wrote.
 */

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
    name: 'Subroutines and functions',
    code: `      PROGRAM CALLS
      INTEGER TRIPLE, N
      CALL DOUBLE(21, N)
      PRINT *, 'doubled:', N
      PRINT *, 'tripled:', TRIPLE(14)
      END
      SUBROUTINE DOUBLE(V, OUT)
      INTEGER V, OUT
      OUT = V * 2
      END
      INTEGER FUNCTION TRIPLE(V)
      INTEGER V
      TRIPLE = V * 3
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
  // The compiler requires an absolute http(s) asset URL, so a relative one is resolved against the
  // page - which is what makes the same-origin defaults work.
  const absolute = new URL(base.endsWith('/') ? base : `${base}/`, location.href).href;
  return { baseUrl: absolute, isOverride: override !== '' };
}

const fortranMirror = resolveBaseUrl(
  'fortranBaseUrl',
  'https://cdn.jsdelivr.net/npm/@live-codes/fortran-wasm@0.1.0/assets/',
);
const clangMirror = resolveBaseUrl(
  'clangBaseUrl',
  'https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@0.2.0/assets/',
);

const el = {
  editor: document.getElementById('editor'),
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

const ANSI = /\x1B\[[0-9;]*m/g;

let compiler = null;
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

/** The compiler colours its diagnostics; the pane renders plain text, so strip it. */
function appendDiagnostics(text) {
  append(el.diagnostics, String(text).replace(ANSI, ''));
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

/** The toolchain is large, so it is created on first use and then reused. */
async function ensureCompiler() {
  if (compiler) return compiler;

  setStatus('loading', 'loading toolchain…', 'busy');
  setProgress('Downloading f2c, Clang and the WASI sysroot…');
  const started = performance.now();

  compiler = await createCompiler({
    baseUrl: fortranMirror.baseUrl,
    clangBaseUrl: clangMirror.baseUrl,
    onProgress: (value) =>
      setProgress(`Downloading the Clang runtime… ${Math.round(value * 100)}%`),
  });

  document.documentElement.dataset.toolchainMs = String(
    Math.round(performance.now() - started),
  );
  setProgress(null);
  return compiler;
}

async function run() {
  if (running) return;

  const source = el.editor.value;
  if (source.trim() === '') return;

  running = true;
  el.run.disabled = true;
  clearOutput();
  // Per-run metrics are read by the browser probes; stale values would lie.
  for (const key of ['translateMs', 'compileMs', 'runMs', 'exitCode']) {
    delete document.documentElement.dataset[key];
  }

  const started = performance.now();
  try {
    await ensureCompiler();

    setStatus('compiling', 'compiling…', 'busy');
    const result = await compiler.run(source, el.stdin.value.replace(/\r\n/g, '\n'));

    append(el.output, result.stdout);
    appendDiagnostics(result.stderr);
    if (result.errors.length) appendDiagnostics(result.errors.join('\n'));

    document.documentElement.dataset.translateMs = String(result.translateMs);
    document.documentElement.dataset.compileMs = String(result.compileMs);
    document.documentElement.dataset.runMs = String(result.runMs ?? 'null');
    document.documentElement.dataset.exitCode = String(result.exitCode ?? 'null');

    const didFail = result.errors.length > 0 || result.exitCode == null;
    const label = result.errors.length
      ? 'failed'
      : result.exitCode == null
        ? 'stopped'
        : `exit ${result.exitCode}`;
    setStatus(didFail ? 'error' : 'done', label, didFail ? 'err' : 'ok');
    el.duration.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (error) {
    // Only this page's own problems land here: a compiler failure or a program fault comes back in
    // the result rather than as a rejection.
    setProgress(null);
    appendDiagnostics(error instanceof Error ? error.message : String(error));
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
