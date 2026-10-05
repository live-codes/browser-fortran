#!/usr/bin/env bash
# Test whether binaryen's -Oz miscompiles the 0.59.0 parser.
#
#   docker cp build-o0.sh lf-wasm059:/build-o0.sh
#   docker exec -d lf-wasm059 bash -c "bash /build-o0.sh > /o0.log 2>&1"
#
# The evidence: the trap is input-independent (empty string, "end program", a comment and a hello-world
# all trap at the same address 0xb5a3a8), in a function shared by get_asr and evaluate, i.e. in the
# parser's own preamble — before any program text is examined. A 0.59 native build parses fine, and a
# 0.66 wasm build parses fine, so it is specific to this source compiled to wasm.
#
# bison's generated parser is one enormous function, which is exactly the shape an optimiser gets wrong.
# -Oz runs binaryen; -O0 does not. If this links and the trap goes away, binaryen was miscompiling it;
# if it still traps, the optimiser is not the cause and the parser's own code is.
#
# Only the link options change, so this is a relink rather than a rebuild.
set -euo pipefail

cd /src
sed -i 's|SHELL:-Oz |SHELL:-O0 |' src/bin/CMakeLists.txt
echo "=== link optimisation now ==="
grep -n -- 'SHELL:-O' src/bin/CMakeLists.txt

export PREFIX="${PREFIX:-/src/.pixi/envs/wasm-host}"

echo "=== reconfigure and relink ==="
pixi run -e wasm-build bash -c "PREFIX=$PREFIX emcmake cmake -S . -B build-wasm -DCMAKE_CXX_FLAGS='-DHAVE_BUILD_TO_WASM'"
pixi run -e wasm-build bash -c "PREFIX=$PREFIX emmake cmake --build build-wasm --target wasm_run"

echo "=== done ==="
ls -l build-wasm/src/bin/wasm_run.wasm
