// A minimal entry point that compiles *and runs* a Fortran program inside the wasm module.
//
// LFortran's own wasm build only ever *emits* things (AST, ASR, WAT, C, C++, wasm bytes) — see the
// `emit_*` functions in `src/bin/lfortran.cpp`. There is no "run this program" entry point, because
// in the browser there is no linker subprocess to hand a binary to. Execution instead goes through
// `FortranEvaluator`, which compiles in-process and hands the result to `WasmLFortranExecutor` to be
// loaded with `dlopen` — which is why the module must be linked `-s MAIN_MODULE=1`.
//
// This is the execution path upstream's own tests use: `src/lfortran/tests/test_llvm.cpp` says the
// FortranEvaluator tests are "WASM-compatible via WasmLFortranExecutor dispatch", and every one of
// them sits outside the `#ifndef __EMSCRIPTEN__` guard that excludes the ORC JIT tests.
//
// The program's own output does not come back through here: it goes to stdout, which the host
// captures. What comes back is only whether it worked, and the diagnostics if it did not.
//
// Deliberately single-threaded: no pthreads anywhere, so the host needs no SharedArrayBuffer and no
// cross-origin isolation.

#include <string>

#include <lfortran/fortran_evaluator.h>
#include <lfortran/utils.h>
#include <libasr/diagnostics.h>
#include <libasr/pass/pass_manager.h>
#include <libasr/utils.h>

// Where the runtime .mod files live inside the wasm filesystem; the CMake target preloads them there.
#ifndef LFORTRAN_BUILD_RUNTIME_DIR
#define LFORTRAN_BUILD_RUNTIME_DIR "/lib"
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define KEEPALIVE
#endif

namespace {

// Stable storage for the returned pointer.
std::string result;

} // namespace

extern "C" {

// Returns "0" when the program ran, or "1,<diagnostics>" when it did not.
KEEPALIVE char *run_fortran(char *input) {
    LCompilers::CompilerOptions compiler_options;
    compiler_options.use_colors = false;
    compiler_options.indent = true;
    // Deliberately not get_runtime_library_dir(): that returns LFORTRAN_BUILD_RUNTIME_DIR as read at
    // *libasr's* compile time, and libasr is built without it set, so it would name a host directory
    // that does not exist in the wasm filesystem. This translation unit does have it set.
    compiler_options.po.runtime_library_dir = LFORTRAN_BUILD_RUNTIME_DIR;
    // Interactive mode is what makes a program unit executable in-process rather than something to
    // be written out and linked elsewhere.
    compiler_options.interactive = true;

    LCompilers::FortranEvaluator fe(compiler_options);

    // Not evaluate2(): that wraps this call and discards the diagnostics, keeping only an empty
    // `Error` struct in the Result (libasr/exception.h is explicit that "we do not currently store
    // anything in the Error structure"). Owning them here is the only way a failure is visible.
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

    // In interactive mode the evaluator registers the cell's source in the location manager itself,
    // which is what lets a diagnostic print the line it came from.
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

} // extern "C"

// `-s MAIN_MODULE=1` wants an entry point. Nothing has to happen here: the host drives the module
// through `run_fortran`, not through argv.
int main(int argc, char **argv) {
    (void)argc;
    (void)argv;
    return 0;
}
