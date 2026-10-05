#!/usr/bin/env bash
# Build LFortran 0.59.0 to WebAssembly with its LLVM backend.
#
#   docker run -d --name lf-wasm059 lfortran-wasm-build sleep infinity
#   docker cp build-wasm-059.sh   lf-wasm059:/port.sh
#   docker cp wasm-run-main.cpp   lf-wasm059:/wasm-run-main.cpp
#   (pipe the native build's runtime .mod files into /mods)
#   docker exec -d lf-wasm059 bash -c "bash /port.sh > /port.log 2>&1"
#
# Why this exists: 0.59.0 is the newest release where the LLVM backend both prints inside a do loop
# and supports derived types, array sections and stdin — verified by building it natively first. No
# published wasm build can stand in, because every published build is `-DWITH_LLVM=no`.
#
# Four things this ref needs that a later ref has out of the box. Each was found by running it:
#
#  1. The environments table. 0.59.0 lists llvm7..llvm21 and test. `wasm-host` has to add the
#     emscripten-wasm32 platform to the workspace, and pixi then validates *every* environment
#     against it, which those cannot do: "failed to solve requirements of environment 'test' for
#     platform 'emscripten-wasm32'". This container only builds wasm, so the table is narrowed to
#     the two environments that are used.
#
#  2. The wasm features themselves, which this ref predates. They are *toolchain* features —
#     Emscripten plus LLVM/LLD for emscripten-wasm32 — and independent of LFortran's sources, so
#     they are taken from a later ref's manifest.
#
#  3. python. This ref pins `python = "==3.12"` in several tables, and pins in the default feature
#     have to resolve for every environment, emscripten-wasm32 included, where python 3.12 is not
#     published. Loosening the pin leaves the wasm-build feature's own `python = "*"` (the Emscripten
#     toolchain needs >=3.13) to choose.
#
#  4. wasm-build0.sh, which builds a native compiler to emit the runtime .mod files. It does not exist
#     at this ref, and it is the expensive step. The native build of the same commit already produced
#     those files, so they are supplied and the build script's guard skips it. They come from an
#     *unpatched* native build and so say "0.59.0", which is why the -dirty strip in the build script
#     matters.
set -euo pipefail

# 0.59.0 targets LLVM 21, and the wasm channel publishes a 21.x for emscripten-wasm32 but not 21.1.2
# exactly, so the pin is a range: an exact one fails to solve. LLVM 22 is not an option — 0.59.0 calls
# CreateGlobalStringPtr, which LLVM 22 removed.
export LLVM_SPEC="${LLVM_SPEC:-llvm>=21,<22}"
# 0.59.0's sources are already correct against LLVM 21: the getTerminator() behaviour change, and the
# replacement functions the other build patches in, only arrived with LLVM 22.
export TERMINATOR_PATCH="${TERMINATOR_PATCH:-0}"
export PREFIX="${PREFIX:-/src/.pixi/envs/wasm-host}"

cd /src
echo "=== fetching v0.59.0 ==="
# Only this tag: the image's clone is shallow, and `git fetch --tags` there pulls every tag in the
# repository, which for LFortran is thousands and looks like a hang.
git fetch --depth 1 origin tag v0.59.0
git checkout --force v0.59.0
git --no-pager log -1 --oneline || true
echo "version file: $(cat version 2>/dev/null || echo none)"

echo "=== narrowing the environments table ==="
# Everything from [environments] to the end of the file is replaced, which is also where previously
# appended features live. They are appended next, so a re-run lands in the same state.
sed -i '/^\[environments\]/,$c\[environments]\nwasm-build = {features = ["wasm-build"]}\nwasm-host = {features = ["wasm-host"]}' pixi.toml
grep -A3 '^\[environments\]' pixi.toml

echo "=== appending the wasm features (absent at this ref) ==="
cat >> pixi.toml <<'PIXI'

# Appended: this ref predates the wasm features. Definitions taken from a later ref's manifest; they
# are toolchain-only and do not depend on LFortran's sources. conda-forge is listed plainly as well as
# through the prefixed mirror, because the plain channel is the one that resolves python here.
[feature.wasm-build]
platforms = ["osx-arm64", "linux-64"]
channels = ["conda-forge", "https://prefix.dev/emscripten-forge-4x", "https://prefix.dev/conda-forge"]

[feature.wasm-build.dependencies]
cmake = "*"
ninja = "==1.11.1"
emscripten_emscripten-wasm32 = "==4.0.9"
python = "*"
re2c = "==3.1"

[feature.wasm-build.target.unix.dependencies]
bison = "==3.4"

[feature.wasm-host]
platforms = ["emscripten-wasm32"]
channels = ["conda-forge", "https://prefix.dev/emscripten-forge-4x", "https://prefix.dev/conda-forge"]

[feature.wasm-host.dependencies]
llvm = "*"
PIXI
grep -n '^\[feature.wasm' pixi.toml

echo "=== loosening the native python pin ==="
sed -i 's|python = "==3.12"|python = "*"|g' pixi.toml
grep -n 'python' pixi.toml | head -6

echo "=== taking the default feature's dependencies out of the default ==="
# This ref also keeps its default dependencies in bare top-level tables, and pixi solves the implicit
# `default` environment for every workspace platform — emscripten-wasm32 included — so those native
# pins fail there:
#
#   failed to solve requirements of environment 'default' for platform 'emscripten-wasm32'
#
# Renaming the tables empties the default feature while keeping the definitions in the file. The wasm
# features carry everything this build needs.
sed -i 's|^\[dependencies\]$|[feature.legacy-default.dependencies]|' pixi.toml
sed -i 's|^\[build-dependencies\]$|[feature.legacy-default-build.dependencies]|' pixi.toml
sed -i 's|^\[host-dependencies\]$|[feature.legacy-default-host.dependencies]|' pixi.toml
echo "renamed tables: $(grep -c 'legacy-default' pixi.toml || true)"
echo "remaining bare tables: $(grep -c '^\[dependencies\]$\|^\[build-dependencies\]$\|^\[host-dependencies\]$' pixi.toml || true)"

echo "=== installing the wasm-build toolchain ==="
pixi install -e wasm-build --platform linux-64

echo "=== installing the wasm-host target libraries (emscripten-wasm32) ==="
pixi install -e wasm-host --platform emscripten-wasm32

echo "=== placing the runtime .mod files, so the native-mod step is skipped ==="
mkdir -p "$PREFIX/lib"
if ls /mods/*.mod >/dev/null 2>&1; then
	cp /mods/*.mod "$PREFIX/lib/"
	echo "placed $(ls "$PREFIX/lib"/*.mod | wc -l) runtime modules"
else
	echo "FATAL: no .mod files in /mods, and wasm-build0.sh does not exist at this ref"
	exit 1
fi

echo "=== handing over to the shared build script (LLVM_VERSION=$LLVM_VERSION) ==="
exec bash /build.sh
