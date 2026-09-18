# Taste

## Workflow

- Prototypes new language/tooling support as a standalone, self-contained proof of concept (e.g. a minimal HTML page) before integrating it into the main project. Confidence: 0.6
- Proactively asks whether existing in-house packages can be reused (e.g. `@live-codes/clang-wasm` for a Fortran pipeline) rather than accepting duplicated toolchain/runtime code. Confidence: 0.6

## Packaging

- When extending an existing package: never change its current public API and avoid growing its bundle size. If a size increase would be significant, ship a separate additional bundle and leave the existing bundle untouched. Confidence: 0.9
