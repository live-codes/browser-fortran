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

#include <cstdio>
#include <string>

#include <llvm/Support/TargetSelect.h>
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
    // Clear stdin's end-of-file flag before every run. The C library keeps it set once a read has hit
    // end-of-input, and nothing else clears it, so a run with no stdin — which is what a host with an
    // empty input pane gives — leaves every later run unable to read: they die with "Failed to read
    // input." even when input is supplied. Measured: with input, a run following an empty one still
    // failed. Only the flag is reset, not the stream position, because each run's stdin is a fresh
    // file.
    clearerr(stdin);

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

    // Upstream's CLI calls this on its first line, before anything else, and this entry point did not
    // — the same class of omission as the target registration below. What it sets up is libasr-wide,
    // and without it the parser traps on *any* input, including the empty string, at a fixed address:
    //
    //   run_fortran THREW  memory access out of bounds
    //     at wasm-function[3924]:0xb5a3a8
    //
    // The same address for "", "end program", a comment and a hello-world, which is what says the
    // fault is in the parser's setup rather than in anything about the program.
    LCompilers::initialize();

    // The evaluator resolves its target through TargetRegistry::lookupTarget, which only knows the
    // targets that have been registered, and registering them is the *host* program's job: upstream's
    // CLI does it in main(). A browser host never runs main(), it calls run_fortran, so nothing had
    // registered them — so the lookup returned null, and v0.59.0 dereferences it without checking:
    //
    //   evaluator.cpp:238  const llvm::Target *target = llvm::TargetRegistry::lookupTarget(triple, Error);
    //   evaluator.cpp:247  TM = target->createTargetMachine(triple, CPU, features, opt, RM);
    //
    // which is "memory access out of bounds" a few frames into the evaluator's constructor. v0.66.0
    // does not crash there because that release has an error argument and a validate_cpu family around
    // the same calls — which is why this only bites the older ref.
    //
    // Once, on the first call: initialising twice is harmless but pointless.
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

    // Not evaluate2(): that wraps this call and discards the diagnostics, keeping only an empty
    // `Error` struct in the Result (libasr/exception.h is explicit that "we do not currently store
    // anything in the Error structure"). Owning them here is the only way a failure is visible.
    LCompilers::LocationManager lm;
    // A file has to be registered, *then* initialised, and upstream does both for exactly this reason.
    // The parse path reads the last file out of the manager:
    //
    //   include_dirs.push_back(parent_path(lm.files.back().in_filename));
    //
    // and init_simple reads it too:
    //
    //   void init_simple(const std::string &input) {
    //       files.back().out_start = {0, input.size()};
    //       ...
    //
    // so back() on an empty vector is undefined behaviour in either place. That is the "memory access
    // out of bounds" this entry point kept hitting, at the same address for "", "end program", a
    // comment and a hello-world: nothing about the program was involved, only that lm.files was empty.
    // This is what evaluate2() does — push a FileLocations named "input", then evaluate.
    const std::string source(input);
    LCompilers::LocationManager::FileLocations fl;
    fl.in_filename = "input";
    lm.files.push_back(fl);
    lm.init_simple(source);

    LCompilers::PassManager lpm;
    lpm.use_default_passes();
    LCompilers::diag::Diagnostics diagnostics;

    // The same string that was registered with the location manager, so the file it knows about and
    // the code being compiled are one and the same.
    LCompilers::Result<LCompilers::FortranEvaluator::EvalResult> r =
        fe.evaluate(source, false, lm, lpm, diagnostics);

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
