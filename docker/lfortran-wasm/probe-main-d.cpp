// Stage D: the fixed entry point, but with interactive mode off.
//
//   docker cp probe-main-d.cpp <container>:/wasm-run-main.cpp
//   docker exec ... cp /wasm-run-main.cpp src/bin/wasm_run_main.cpp && ninja wasm_run
//
// Registering the LLVM targets removed the trap that stage B found (deep in LLVM, in the evaluator's
// constructor). What is left happens later, after the constructor, so it is inside evaluate() — three
// frames in, at a much shallower code offset than the LLVM one was.
//
// Interactive mode is what makes evaluate() *run* the program in-process, through WasmLFortranExecutor
// and dlopen, rather than stopping at "here is a module". Turning it off is therefore a one-flag split
// of evaluate():
//
//   traps  -> parsing / semantics / codegen, before anything is run
//   works  -> the run itself: the executor, the wasm link, or dlopen
#include <cstdio>
#include <string>

#include <llvm/Support/TargetSelect.h>
#include <emscripten.h>
#include <lfortran/fortran_evaluator.h>
#include <lfortran/utils.h>
#include <libasr/diagnostics.h>
#include <libasr/pass/pass_manager.h>
#include <libasr/utils.h>

#ifndef LFORTRAN_BUILD_RUNTIME_DIR
#define LFORTRAN_BUILD_RUNTIME_DIR "/lib"
#endif

namespace {
std::string result;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE char *run_fortran(char *input) {
    clearerr(stdin);

    LCompilers::CompilerOptions compiler_options;
    compiler_options.use_colors = false;
    compiler_options.indent = true;
    compiler_options.po.runtime_library_dir = LFORTRAN_BUILD_RUNTIME_DIR;
    // The one difference from the real entry point.
    compiler_options.interactive = false;

    static const bool targets_registered = [] {
        llvm::InitializeAllTargetInfos();
        llvm::InitializeAllTargets();
        llvm::InitializeAllTargetMCs();
        llvm::InitializeAllAsmParsers();
        llvm::InitializeAllAsmPrinters();
        return true;
    }();
    (void)targets_registered;

    LCompilers::FortranEvaluator fe(compiler_options);

    LCompilers::LocationManager lm;
    LCompilers::PassManager lpm;
    lpm.use_default_passes();
    LCompilers::diag::Diagnostics diagnostics;

    LCompilers::Result<LCompilers::FortranEvaluator::EvalResult> r =
        fe.evaluate(std::string(input), false, lm, lpm, diagnostics);

    if (r.ok) {
        result = "0";
        return &result[0];
    }

    std::string rendered;
    if (!lm.files.empty()) {
        rendered = diagnostics.render(lm, compiler_options);
    }
    if (rendered.empty()) {
        rendered = "compilation failed, with no diagnostic text";
    }
    result = "1," + rendered;
    return &result[0];
}

}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;
    return 0;
}
