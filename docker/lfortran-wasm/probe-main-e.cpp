// Stage E: parse and semantics only — get_asr(), no LLVM, no run.
//
//   docker cp probe-main-e.cpp <container>:/wasm-run-main.cpp
//   docker exec ... cp /wasm-run-main.cpp src/bin/wasm_run_main.cpp && ninja wasm_run
//
// What is established so far, each by a rebuild rather than by reasoning:
//
//   stage A  the prologue is innocent: clearerr(stdin) and the CompilerOptions setup return "0"
//   stage B  constructing the FortranEvaluator trapped — deep in LLVM
//   fix      registering the LLVM targets in the entry point removed that trap
//   stage C  with the fix, the trap moved later — shallower, after the constructor
//   stage D  interactive = false changed the artifact (35ef7d65 -> d34970f2) but not the trap, so
//            the fault is in the *compile* path rather than in running
//
// v0.59.0's FortranEvaluator exposes the ladder this needs:
//
//   get_ast   parse
//   get_asr   parse + semantics
//   get_llvm  + LLVM IR, which is where the target machine is used
//   evaluate  + run
//
// This calls get_asr, so:
//
//   traps  -> parsing or semantics
//   works  -> the LLVM IR stage, i.e. the codegen that needs the target machine
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

    // The one difference from the real entry point: stop at ASR.
    LCompilers::Result<std::string> r = fe.get_asr(std::string(input), lm, diagnostics);

    if (r.ok) {
        // PrintErr is captured by the host, so this is visible evidence that it got this far.
        std::fprintf(stderr, "stage E: get_asr ok, %zu bytes of ASR\n", r.result.size());
        result = "0";
        return &result[0];
    }

    std::string rendered;
    if (!lm.files.empty()) {
        rendered = diagnostics.render(lm, compiler_options);
    }
    if (rendered.empty()) {
        rendered = "get_asr failed, with no diagnostic text";
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
