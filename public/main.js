import { createCompiler } from '/packages/lfortran-wasm/src/index.js';

/**
 * A page around `@live-codes/lfortran-wasm`.
 *
 * The compiler is the package in this repository — `packages/lfortran-wasm` — imported by path, so
 * what this page exercises is the working tree rather than whatever is on the CDN. `serve.js` maps
 * `/packages/` onto the repository, and the package resolves its own wasm from its `assets/` beside
 * it, so nothing here has to say where the assets are.
 *
 * This file is only the harness: examples, a Run button, two output panes, and the timings the
 * browser probes read back. Everything about compiling Fortran lives in the package, and a LiveCodes
 * language module would use the same package the same way.
 *
 * `?baseUrl=` points the loader somewhere else — a CDN build, or `docker/lfortran-wasm/out-059/`.
 */

const EXAMPLES = [
  {
    name: 'Hello world',
    code: `program hello
print *, 'Hello from Fortran!'
print *, 'Compiled and run in your browser, with no server.'
end program
`,
  },
  {
    name: 'DO loop',
    code: `program squares
integer :: i, sq
do i = 1, 10
   sq = i * i
   print *, 'n =', i, '  n squared =', sq
end do
end program
`,
  },
  {
    name: 'Whole-array arithmetic',
    code: `program arrays
real :: a(5), b(5)
a = [1.0, 2.0, 3.0, 4.0, 5.0]
b = a * 2.0
print *, 'a      =', a
print *, 'a * 2  =', b
print *, 'sum(a) =', sum(a)
print *, 'size(a)=', size(a)
end program
`,
  },
  {
    name: 'Array sections (what f2c got wrong)',
    code: `program slicing
real :: a(4)
a = [10.0, 20.0, 30.0, 40.0]
print *, 'whole  =', a
print *, 'A(2:3) =', a(2:3)
print *, 'reversed=', a(4:1:-1)
end program
`,
  },
  {
    name: 'Modules and derived types',
    code: `module geometry
implicit none
type :: point
   real :: x, y
end type
contains
real function norm(p)
   type(point), intent(in) :: p
   norm = sqrt(p%x**2 + p%y**2)
end function
end module

program main
use geometry
type(point) :: p
p%x = 3.0
p%y = 4.0
print *, 'distance from the origin =', norm(p)
end program
`,
  },
  {
    name: 'Allocatable arrays',
    code: `program dynamic
integer :: n, i
integer, allocatable :: squares(:)
n = 5
allocate(squares(n))
do i = 1, n
   squares(i) = i * i
end do
print *, 'squares  =', squares
print *, 'maxval   =', maxval(squares)
print *, 'sum      =', sum(squares)
deallocate(squares)
end program
`,
  },
  {
    name: 'READ from stdin',
    code: `program adder
integer :: a, b
print *, 'Enter two integers, one per line:'
read *, a
read *, b
print *, 'Sum =', a + b
end program
`,
  },
  {
    name: 'A compile error (shown as diagnostics)',
    code: `program broken
integer :: i, total
total = 0
do i = 1, 3
   total = total + i
print *, 'Total =', total
end program
`,
  },
];

function resolveBaseUrl() {
  const override = (new URLSearchParams(location.search).get('baseUrl') ?? '').trim();
  if (override === '') {
    // No option: the package uses the assets beside it, in this repository.
    return { baseUrl: undefined, isOverride: false, label: 'packages/lfortran-wasm/assets/ (default)' };
  }
  // The loader needs an absolute URL for its assets, so a relative override is resolved against the
  // page — which is what makes a same-origin directory like /docker/lfortran-wasm/out-059/ work.
  return {
    baseUrl: new URL(override.endsWith('/') ? override : `${override}/`, location.href).href,
    isOverride: true,
    label: override,
  };
}

const mirror = resolveBaseUrl();

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
  baseUrl: document.getElementById('base-url'),
  baseOverride: document.getElementById('base-override'),
};

// The browser probes drive the page by element id rather than by evaluating string literals, which
// some shells mangle when passing arguments.
Object.assign(window, el);

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

function clearOutput() {
  el.output.replaceChildren();
  el.diagnostics.replaceChildren();
  el.duration.textContent = '';
}

function loadExample(index) {
  el.editor.value = EXAMPLES[index].code;
  el.examples.value = String(index);
}

/**
 * The compiler is 16 MiB compressed, so it is created on first use and then reused. Programs are per
 * run; the loaded module is not.
 */
async function ensureCompiler() {
  if (compiler) return compiler;

  setStatus('loading', 'loading compiler…', 'busy');
  setProgress('Downloading the LFortran compiler (about 16 MiB compressed)…');
  const started = performance.now();

  compiler = await createCompiler({ baseUrl: mirror.baseUrl });

  document.documentElement.dataset.toolchainMs = String(Math.round(performance.now() - started));
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
  for (const key of ['runMs', 'exitCode']) {
    delete document.documentElement.dataset[key];
  }

  const started = performance.now();
  try {
    await ensureCompiler();

    setStatus('compiling', 'compiling…', 'busy');
    const result = await compiler.run(source, el.stdin.value.replace(/\r\n/g, '\n'));

    append(el.output, result.stdout);
    append(el.diagnostics, result.errors);

    document.documentElement.dataset.runMs = String(Math.round(result.runMs));
    document.documentElement.dataset.exitCode = String(result.exitCode ?? 'null');

    // The compiler never rejects: a compile error, a program that stops, and a tripwire all arrive as
    // a result with exitCode null and the reason in `errors`.
    const didFail = result.exitCode == null;
    setStatus(didFail ? 'error' : 'done', didFail ? 'failed' : 'exit 0', didFail ? 'err' : 'ok');
    el.duration.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (error) {
    // Only this page's own problems land here, such as the compiler failing to download.
    setProgress(null);
    append(el.diagnostics, error instanceof Error ? error.message : String(error));
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

el.baseUrl.textContent = mirror.label;
el.baseOverride.textContent = mirror.isOverride ? '(from ?baseUrl)' : '(default)';
document.documentElement.dataset.status = 'ready';
loadExample(0);
