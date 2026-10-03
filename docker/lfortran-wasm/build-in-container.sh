#!/usr/bin/env bash
# Runs inside the container built by Dockerfile. Not executable on the host: it needs pixi, emcmake,
# and the emscripten-wasm32 LLVM that only the image has.
#
#   docker run --rm -v "$PWD/out:/out" <image>
#
# The goal is a wasm module that *compiles and runs* a Fortran program, rather than upstream's
# JupyterLite kernel — so this departs from `wasm-build1.sh` in two deliberate places, both noted
# below: it does not build the kernel, and it adds an entry point of its own.
#
# Steps:
#   1. build0.sh      - generate the parser / AST / ASR sources with bison and re2c
#   2. wasm-build0.sh - build a *native* LFortran and use it to emit the runtime `.mod` files
#   3. pin LLVM       - the wasm-host environment has `llvm = "*"`, so solving today gives LLVM 23
#   4. cross-compile  - Emscripten build of `wasm_run`, the entry point in wasm-run-main.cpp
set -euo pipefail

export PREFIX="${PREFIX:-/src/.pixi/envs/wasm-host}"

# The *native* build in step 2 wants a real zlib: `wasm-build0.sh` does not pass `-DWITH_ZLIB=no`,
# unlike `wasm-build1.sh`, so cmake looks for it and fails at CMakeLists.txt:136. The toolchain image
# deliberately does not carry a host zlib — the cross build has `-DWITH_ZLIB=no` and the wasm-host
# environment is for the target — so this is where it is needed, and this is where it is installed.
if ! dpkg -s zlib1g-dev >/dev/null 2>&1; then
    echo "=== installing zlib1g-dev (needed by the native build in step 2) ==="
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends zlib1g-dev
fi

echo "=== 1/4  build0.sh (parser / AST / ASR sources) ==="
# Also skipped when its output is already there: it rewrites generated headers such as asr.h, which
# invalidates nearly every object in the tree and turns a relink into a 20-minute rebuild. Nothing it
# generates depends on the entry point or the CMake target we add, so reusing it is sound for
# iterating (delete the files, or the container, for a from-scratch build).
if [ -f src/libasr/asr.h ] && [ -f src/lfortran/parser/parser.tab.cc ]; then
    echo "generated sources already present, skipping build0.sh"
else
    pixi run -e wasm-build ./build0.sh
fi

echo "=== 2/4  wasm-build0.sh (native LFortran -> runtime .mod files) ==="
# Skipped when the .mod files are already installed, which they are when a previous run got as far
# as this step: it rebuilds a whole native LFortran, and nothing about it depends on our changes.
if ls "$PREFIX"/lib/*.mod >/dev/null 2>&1; then
    echo "runtime .mod files already present in $PREFIX/lib, skipping the native build"
else
    pixi run -e wasm-build bash -c "PREFIX=$PREFIX ./wasm-build0.sh"
fi

echo "=== 3/4  pinning llvm to the 22.x line LFortran v0.65.0 targets ==="
# `llvm = "*"` in pixi.toml resolves to 23.1.2 as of today, and LLVM's C++ API breaks between major
# versions, so LFortran v0.65.0 — whose own pixi.toml pins llvmdev 22.x — would not compile against
# it. 22.1.8 is the newest 22.x the emscripten-forge channel publishes.
pixi add -e wasm-host "llvm==22.1.8"

echo "=== 4/4  adding the entry point and cross-compiling ==="
cp /wasm-run-main.cpp src/bin/wasm_run_main.cpp

# Restore the pristine file first, so that re-running this in a container from an earlier attempt
# cannot stack two copies of the block below.
git checkout -- src/bin/CMakeLists.txt

# Appended to src/bin, which src/CMakeLists.txt adds *after* src/lfortran, so lfortran_lib exists by
# the time this is read.
if ! grep -q "browser-fortran: wasm_run" src/bin/CMakeLists.txt; then
    cat >> src/bin/CMakeLists.txt <<'CMAKE'

# --- browser-fortran: wasm_run -------------------------------------------------------------
# A target that compiles *and runs* a program in the module, unlike the emit-only `lfortran` target
# and the JupyterLite kernel. Built only under Emscripten and only when the kernel is not being
# built, because the kernel needs xeus, whose CMake config declares shared libraries — and wasm has
# no dynamic linking, so cmake refuses it.
if (EMSCRIPTEN AND NOT XEUS_LFORTRAN_WASM_BUILD)
    # No find_package(LLD) here: LLD's imported targets are needed by *src/libasr* (which links
    # `lldWasm lldCommon` by name), and imported targets are directory-scoped, so importing them from
    # this directory would not help a sibling. They are imported at the top level instead, below.

    add_executable(wasm_run wasm_run_main.cpp)
    target_include_directories(wasm_run PRIVATE
        ${CMAKE_SOURCE_DIR}/src
        ${CMAKE_BINARY_DIR}/src
        ${CMAKE_SOURCE_DIR}/src/lfortran
        ${CMAKE_BINARY_DIR}/src/lfortran
    )
    target_link_libraries(wasm_run PRIVATE lfortran_lib)
    # LFortran links LLD's archives *by name* (src/libasr/CMakeLists.txt: `target_link_libraries(asr
    # lldWasm lldCommon)`), so the linker needs a search path for them. Upstream gets one from the
    # JupyterLite kernel's xeus link options, and we are not building the kernel — without this the
    # link dies with "unable to find library -llldWasm".
    target_link_directories(wasm_run PRIVATE "${CMAKE_INSTALL_PREFIX}/lib")
    # Under Emscripten the runtime .mod files are preloaded at /lib, the same place xlfortran reads
    # them from; the evaluator resolves intrinsic modules through this.
    target_compile_definitions(wasm_run PRIVATE LFORTRAN_BUILD_RUNTIME_DIR="/lib")

    target_compile_options(wasm_run PRIVATE -g0 -fexceptions)
    # `WasmLFortranExecutor uses dlopen`, so the module has to be a MAIN_MODULE.
    # Nothing here is threaded: no -pthread, no USE_PTHREADS, so the host needs neither
    # SharedArrayBuffer nor cross-origin isolation.
    target_link_options(wasm_run PRIVATE
        "SHELL:-Oz -g0 -fexceptions -Wall -Wextra"
        "SHELL:-fwasm-exceptions"
        "SHELL:-s MAIN_MODULE=1"
        "SHELL:-s ALLOW_MEMORY_GROWTH=1"
        "SHELL:-s MAXIMUM_MEMORY=4GB"
        "SHELL:-s WASM_BIGINT"
        "SHELL:-s STACK_SIZE=32mb"
        "SHELL:-s INITIAL_MEMORY=128mb"
        # No EXIT_RUNTIME: the host calls run_fortran *after* main has returned, so the runtime has to
        # stay alive. The kernel can set it because the kernel *is* main.
        "SHELL:-s MODULARIZE=1"
        "SHELL:-s EXPORT_NAME=createLFortran"
        "SHELL:-s EXPORTED_FUNCTIONS=['_run_fortran','_main','_malloc','_free']"
        "SHELL:-s EXPORTED_RUNTIME_METHODS=['cwrap','FS']"
        "SHELL:-s FORCE_FILESYSTEM=1"
    )

    # Preload the runtime .mod files, so `use iso_c_binding` and friends resolve.
    file(GLOB LFORTRAN_MOD_FILES CONFIGURE_DEPENDS "${CMAKE_INSTALL_PREFIX}/lib/*.mod")
    if (NOT LFORTRAN_MOD_FILES)
        message(FATAL_ERROR "wasm_run: no runtime .mod files found in ${CMAKE_INSTALL_PREFIX}/lib")
    endif()
    foreach (MOD_FILE ${LFORTRAN_MOD_FILES})
        get_filename_component(MOD_NAME ${MOD_FILE} NAME)
        target_link_options(wasm_run PRIVATE "SHELL:--preload-file \"${MOD_FILE}@/lib/${MOD_NAME}\"")
    endforeach()
endif()
CMAKE
fi

# --- LFortran v0.65.0 + modern LLVM: `getTerminator()` no longer means "or null" -----------------
#
# LFortran's two `start_new_block` helpers use getTerminator() as a test:
#
#     llvm::Instruction *block_terminator = last_bb->getTerminator();
#     if (block_terminator == nullptr) { builder->CreateBr(bb); }   // terminate the previous block
#
# That relied on the old LLVM semantics, where getTerminator() returned null when the block was not
# well formed. Modern LLVM moved that check into hasTerminator()/getTerminatorOrNull(), and its
# getTerminator() now *assumes* a well-formed block:
#
#     assert(hasTerminator() && "cannot get terminator of non-well-formed block");
#     return &InstList.back();
#
# With NDEBUG the assert vanishes, so for a block ending in, say, a call, getTerminator() returns
# that call as if it were a terminator. LFortran concludes the block is already terminated and never
# emits the branch — and the generated module is invalid:
#
#     Basic Block in function '__lfortran_evaluate_1_program' does not have terminator!
#
# Every `br` in the failing IR was missing while every call was present, which is what identified
# this. getTerminatorOrNull() is the same test with the semantics LFortran was written against.
#
# The two remaining uses live in llvm_utils.h and are deliberately left alone: one sits inside
# LCOMPILERS_ASSERT, which NDEBUG removes, and the other (check_all_caches_done_properly) only
# becomes *less* strict, so it cannot cause a failure. Not touching that header also keeps the
# rebuild to two object files instead of most of the tree.
git checkout -- src/libasr/codegen/asr_to_llvm.cpp src/libasr/codegen/llvm_utils.cpp
sed -i 's|llvm::Instruction \*block_terminator = last_bb->getTerminator();|llvm::Instruction *block_terminator = last_bb->getTerminatorOrNull();|' \
    src/libasr/codegen/asr_to_llvm.cpp src/libasr/codegen/llvm_utils.cpp
for f in src/libasr/codegen/asr_to_llvm.cpp src/libasr/codegen/llvm_utils.cpp; do
    if ! grep -q "getTerminatorOrNull" "$f"; then
        echo "FATAL: the getTerminator patch did not apply to $f"
        exit 1
    fi
done
echo "patched getTerminator() -> getTerminatorOrNull() in both start_new_block helpers"

# Make LLD's imported targets visible to src/libasr, which links `lldWasm lldCommon` by name. They are
# directory-scoped, so importing them from src/bin — or from anywhere below the top level — leaves the
# sibling src/libasr directory unable to see them, and the link falls back to `-llldWasm -llldCommon`
# with no transitive dependencies. LLVMLTO is one of those dependencies, and its absence is a wall of
# `undefined symbol: llvm::lto::...`. Upstream gets this right by calling find_package(LLD) at the top
# level, inside its kernel block; we need the same thing without the kernel.
#
# sed rather than a script: the image has no python outside the pixi environments.
if ! grep -q "browser-fortran: LLD for wasm_run" CMakeLists.txt; then
    sed -i 's|^add_subdirectory(src)$|# browser-fortran: LLD for wasm_run\nif (EMSCRIPTEN)\n    find_package(LLD REQUIRED CONFIG HINTS "${CMAKE_PREFIX_PATH}/lib/cmake/lld")\nendif()\n\nadd_subdirectory(src)|' CMakeLists.txt
    grep -n "browser-fortran: LLD for wasm_run" CMakeLists.txt
fi

# The flags from wasm-build1.sh, minus the kernel: XEUS_LFORTRAN_WASM_BUILD off so xeus is never
# looked for, and LFORTRAN_BUILD_TO_WASM off so the emit-only CLI is not built either.
pixi run -e wasm-build bash -c "PREFIX=$PREFIX emcmake cmake -S . -B build-wasm -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DLFORTRAN_BUILD_ALL=no \
    -DWITH_LLVM=yes \
    -DXEUS_LFORTRAN_WASM_BUILD=no \
    -DWITH_XEUS=no \
    -DWITH_ZSTD=no \
    -DWITH_RUNTIME_LIBRARY=no \
    -DWITH_STACKTRACE=no \
    -DWITH_WHEREAMI=no \
    -DWITH_ZLIB=no \
    -DCMAKE_INSTALL_PREFIX=$PREFIX \
    -DCMAKE_FIND_ROOT_PATH=$PREFIX \
    -DCMAKE_PREFIX_PATH=$PREFIX \
    -DLLVM_DIR=$PREFIX/lib/cmake/llvm \
    -DLLD_DIR=$PREFIX/lib/cmake/lld"

echo "=== linking wasm_run (the slow one) ==="
pixi run -e wasm-build bash -c "PREFIX=$PREFIX emmake cmake --build build-wasm --target wasm_run"

echo "=== artifacts ==="
ls -l build-wasm/src/bin/wasm_run.* 2>/dev/null || true

if [ -d /out ]; then
    mkdir -p /out
    cp -v build-wasm/src/bin/wasm_run.js /out/ 2>/dev/null || true
    cp -v build-wasm/src/bin/wasm_run.wasm /out/ 2>/dev/null || true
    cp -v build-wasm/src/bin/wasm_run.data /out/ 2>/dev/null || true
fi

echo "=== done ==="
