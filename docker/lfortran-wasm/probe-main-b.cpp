// Stage B: the prologue plus the evaluator's construction, and no evaluate() call.
//
//   docker cp probe-main-b.cpp <container>:/wasm-run-main.cpp
//   docker exec ... cp /wasm-run-main.cpp src/bin/wasm_run_main.cpp && ninja wasm_run
//
// Stage A proved the prologue is innocent: clearerr(stdin) and the CompilerOptions setup run and the
// call returns "0". This adds exactly one thing — constructing the FortranEvaluator — which is where
// the LLVM target is resolved:
//
//   evaluator.cpp:235  target_triple = LLVMGetDefaultTargetTriple();
//   evaluator.cpp:238  const llvm::Target *target = llvm::TargetRegistry::lookupTarget(target_triple, Error);
//   evaluator.cpp:247  TM = target->createTargetMachine(target_triple, CPU, features, opt, RM);
//
// with no null check on `target` in this release, where 0.66.0 has an error argument and a whole
// is_host_target/validate_cpu family. So:
//
//   traps here  -> the evaluator's construction, and the target lookup is the place to look
//   works       -> the evaluate() call, i.e. actually compiling something
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

    LCompilers::FortranEvaluator fe(compiler_options);
    (void)fe;

    // Stage B stops here.
    return const_cast<char *>("0");
}

}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;
    return 0;
}
