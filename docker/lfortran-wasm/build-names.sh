#!/usr/bin/env bash
# Rebuild the 0.59.0 wasm with debug info, so trapped frames can be named.
#
#   docker cp build-names.sh lf-wasm059:/build-names.sh
#   docker exec -d lf-wasm059 bash -c "bash /build-names.sh > /names.log 2>&1"
#
# The trap is "memory access out of bounds" in a function the loader cannot name, because the build
# uses -g0. Bisecting it blinded has cost several rebuilds; one build with -g2 makes every future trap
# self-describing. This is the same configure line as /build.sh, with -g2 added to CMAKE_CXX_FLAGS, so
# the object files carry names and wasm-ld can keep them.
set -euo pipefail

cd /src
export PREFIX="${PREFIX:-/src/.pixi/envs/wasm-host}"

echo "=== configure with -g2 ==="
pixi run -e wasm-build bash -c "PREFIX=$PREFIX emcmake cmake -S . -B build-wasm -DCMAKE_CXX_FLAGS='-DHAVE_BUILD_TO_WASM -g2'"

echo "=== rebuild (full recompile) ==="
pixi run -e wasm-build bash -c "PREFIX=$PREFIX emmake cmake --build build-wasm --target wasm_run"

echo "=== done ==="
ls -l build-wasm/src/bin/wasm_run.wasm
echo "=== does it carry a name section? ==="
strings -a build-wasm/src/bin/wasm_run.wasm 2>/dev/null | grep -c "start_new_block" || echo "strings unavailable"
