/**
 * A static server for this demo.
 *
 * It exists because `file://` cannot run ES modules or fetch the wasm assets. Nothing else is needed:
 * the page runs with NO cross-origin isolation.
 *
 *   node serve.js [port] [root] [--isolation]
 *
 * `root` defaults to `public/` and is resolved against this file.
 *
 * Requests under `/packages/` are served from the repository root instead, so that the demo can
 * import the package from this repository rather than from a CDN. That is the only reason this server
 * understands two roots: the package's `src/` and its vendored `assets/` live there, and the package
 * resolves its wasm relative to itself, so nothing else has to be configured.
 *
 * `--isolation` adds COOP/COEP, which is what a threaded WebAssembly runtime would need. This
 * pipeline is not threaded, so the headers are unnecessary; see FINDINGS.md for why. The flag is kept
 * so the difference can be shown.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const argv = process.argv.slice(2);
const isolation = argv.includes('--isolation');
const positional = argv.filter((arg) => !arg.startsWith('-'));

const PORT = Number(positional[0] ?? 8127);
const PUBLIC_ROOT = resolve(HERE, positional[1] ?? 'public');
const REPO_ROOT = resolve(HERE);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

function resolveRequest(urlPath) {
  // The package the demo imports, out of this repository instead of a CDN.
  const root = urlPath === '/packages' || urlPath.startsWith('/packages/') ? REPO_ROOT : PUBLIC_ROOT;
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = normalize(join(root, rel));
  if (!filePath.startsWith(normalize(root))) {
    return { error: 'Forbidden' };
  }
  return { filePath };
}

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const { filePath, error } = resolveRequest(urlPath);
  if (error) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end(error);
    return;
  }

  let body;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${urlPath}`);
    return;
  }

  const headers = {
    'Content-Type': TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // The package's assets are content-addressed by their receipts, and a rebuild replaces them, so
    // serve everything fresh rather than risking a stale cached module during development.
    'Cache-Control': 'no-store',
  };

  if (isolation) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }

  res.writeHead(200, headers).end(body);
});

server.listen(PORT, () => {
  console.log(`browser-fortran: http://localhost:${PORT}/`);
  console.log(
    `serving ${PUBLIC_ROOT} + /packages/ — cross-origin isolation ${isolation ? 'ON (--isolation)' : 'off (not needed)'}`,
  );
  console.log('the compiler and its wasm come from packages/lfortran-wasm in this repository');
  console.log('press Ctrl+C to stop');
});
