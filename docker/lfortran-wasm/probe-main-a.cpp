// Stage A: the prologue, and nothing else.
//
//   docker cp probe-main-a.cpp <container>:/wasm-run-main.cpp
//   docker exec ... cp /wasm-run-main.cpp src/bin/wasm_run_main.cpp && ninja wasm_run
//
// The 0.59.0 build traps three frames into run_fortran with no output, while malloc/free work and
// there is no emscripten abort text — so the fault is in this function's body. This runs the prologue
// exactly as the real entry point does, including clearerr(stdin) and the CompilerOptions setup, and
// then returns without constructing the FortranEvaluator. That splits the body in one place:
//
//   traps here  -> clearerr, CompilerOptions, or something before them
//   works       -> the FortranEvaluator: construction, or the evaluate() call
//
// `main` is kept because the link exports `_main` (EXPORTED_FUNCTIONS in the CMake target) and omitting
// it fails the link rather than the run.
#include <cstdio>
#include <string>

#include <emscripten.h>
#include <lfortran/fortran_evaluator.h>

#ifndef LFORTRAN_BUILD_RUNTIME_DIR
#define LFORTRAN_BUILD_RUNTIME_DIR "/lib"
#endif

extern "C" {

EMSCRIPTEN_KEEPALIVE char *run_fortran(char *input) {
    (void)input;
    clearerr(stdin);

    LCompilers::CompilerOptions compiler_options;
    compiler_options.use_colors = false;
    compiler_options.indent = true;
    compiler_options.po.runtime_library_dir = LFORTRAN_BUILD_RUNTIME_DIR;
    compiler_options.interactive = true;

    // Stage A stops here.
    return const_cast<char *>("0");
}

}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;
    return 0;
}
