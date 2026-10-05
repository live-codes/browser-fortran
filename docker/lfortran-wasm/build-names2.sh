#!/usr/bin/env bash
# Rebuild so the wasm keeps function names, after finding why the first attempt did not.
#
#   docker cp build-names2.sh lf-wasm059:/build-names2.sh
#   docker exec -d lf-wasm059 bash -c "bash /build-names2.sh > /names2.log 2>&1"
#
# Adding -g2 to CMAKE_CXX_FLAGS changed the artifact hash but produced no name section, because the
# CMake target sets -g0 in two more specific places that override it:
#
#   target_compile_options(wasm_run PRIVATE -g0 -fexceptions)
#   target_link_options(wasm_run PRIVATE "SHELL:-Oz -g0 -fexceptions -Wall -Wextra" ...)
#
# The second is the decisive one: -g0 at link strips the name section even when the objects carry
# debug info. Both become -g2, so a trapped frame reports a function name instead of an index.
# Recompiling is required because the compile flags change.
set -euo pipefail

cd /src
sed -i 's/-g0/-g2/g' src/bin/CMakeLists.txt
echo "=== -g2 now set here ==="
grep -n -- '-g2' src/bin/CMakeLists.txt

export PREFIX="${PREFIX:-/src/.pixi/envs/wasm-host}"

echo "=== configure ==="
pixi run -e wasm-build bash -c "PREFIX=$PREFIX emcmake cmake -S . -B build-wasm -DCMAKE_CXX_FLAGS='-DHAVE_BUILD_TO_WASM'"

echo "=== rebuild ==="
pixi run -e wasm-build bash -c "PREFIX=$PREFIX emmake cmake --build build-wasm --target wasm_run"

echo "=== done ==="
ls -l build-wasm/src/bin/wasm_run.wasm
echo "=== name section present? (a big count means yes) ==="
strings -a build-wasm/src/bin/wasm_run.wasm 2>/dev/null | grep -c 'LCompilers' || echo "strings unavailable"
