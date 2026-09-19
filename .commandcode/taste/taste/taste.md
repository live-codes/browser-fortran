# Taste
- Prototypes new language/tooling support as a standalone, self-contained proof of concept (e.g. a minimal HTML page) before integrating it into the main project. Confidence: 0.6
- Proactively asks whether existing in-house packages can be reused (e.g. `@live-codes/clang-wasm` for a Fortran pipeline) rather than accepting duplicated toolchain/runtime code. Confidence: 0.6
- Tidies up before reporting a task done: stops background dev servers, closes browser/test sessions, and re-checks the final state (git status, ignored/generated paths, `npm run check`) instead of leaving processes running. Confidence: 0.6
- Maintains a running findings/log document that records what was verified and the evidence for it (verbatim outputs, exact byte sizes, test counts), not just a changelog of edits. Confidence: 0.6
- Documents root causes and deliberately unsupported behaviour explicitly — including why an option/feature was intentionally left out — rather than shipping it undocumented. Confidence: 0.6
- Keeps README/docs in sync with architectural changes (e.g. rewriting them when the code moves into a package) so docs never describe the previous structure. Confidence: 0.6
- When extending an existing package: never change its current public API and avoid growing its bundle size. If a size increase would be significant, ship a separate additional bundle and leave the existing bundle untouched. Confidence: 0.9
- Once a real published release exists, swaps local dev links / `file:` checkouts and `--<pkg>=<dir>` flags for the registry version and deletes the surrounding scaffolding, rather than keeping the workaround around. Confidence: 0.6
- Does not trust a version bump blindly: inspects what a newly published package actually ships (tarball contents, exports of each node/browser entry, whether a CDN serves the subpath) before depending on it, and keeps repeated version pins (import map, asset-copy script) in agreement. Confidence: 0.5
