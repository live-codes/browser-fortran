# Regression: list-directed `print` inside a `do` loop is emitted as nothing

Draft for an upstream issue. Everything below was run, not inferred.

## Summary

List-directed output inside a `do` loop produces no output at all, silently. The program compiles,
runs, exits 0, and prints nothing, and the emitted module is **smaller than a hello-world's**, so the
statement is not being written somewhere else — it is not emitted.

This works in 0.59.0 and is broken from 0.60.0 onward, on the wasm backend and on the LLVM backend
alike, and it is still broken on `main` (`0.66.0-602-gd981ac1f4`).

## Minimal repro

```fortran
program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
```

Expected output: `1`, `2`, `3` on separate lines, or at minimum the values separated by spaces.

Actual: **no output**, exit status 0, no diagnostic — nothing on stdout or stderr.

## Scope

The failure is narrow, and these were each run to establish it:

| case | result |
| --- | --- |
| `print *` inside a `do` loop | **nothing** |
| `write (*, '(I0)') i` inside the same loop | `1 2 3` ✓ |
| `print *` before or after a loop | ✓ |
| declaration and assignment, no loop | ✓ |
| loop whose body does arithmetic (`total = total + i`, printed after) | ✓ |
| loop with an empty body, printed after | ✓ |

So it is specifically list-directed output *inside* a loop, not loops, not declarations, and not
list-directed output in general.

## Versions

Same pipeline, same program, only the build changed. Measured against the published builds at
`lfortran.github.io/wasm_builds` (`d981ac1f4` and the release tags), driving each build's own
`emit_wasm_from_source` and instantiating the result:

| build | wasm | `do` loop with `print *` |
| --- | --- | --- |
| 0.52.0 (`b5e05bd3a`) | 22.32 MiB | `1 2 3` |
| **0.59.0 (`e8c53fddf`)** | 11.75 MiB | **`1 2 3`** |
| 0.60.0 (`2f734343f`) | 12.00 MiB | nothing |
| 0.62.0 (`b84f57bb4`) | 13.51 MiB | nothing |
| 0.63.0 (`8f4dab985`) | 13.65 MiB | nothing |
| 0.66.0 (`569035a33`) | 16.62 MiB | nothing |
| `dev` (`d981ac1f4`, 0.66.0+602) | 17.60 MiB | nothing |

So the regression is between **0.59.0 and 0.60.0** and has not been fixed since.

## Evidence that the statement is dropped at codegen

The module emitted for the repro is **644 bytes**, against **898** for the same program in 0.59.0 —
and 701 for a hello-world. A program whose loop body is missing comes out *smaller* than one that only
prints a string, which is consistent with the `print` being removed rather than redirected.

## Not wasm-specific

- A **native** build of 0.59.0 (x86-64, LLVM 21.1.2, built from the tag with its own pixi environment)
  prints `1 2 3` for this program.
- A wasm build of **0.66.0 with the LLVM backend** (self-built, `WITH_LLVM=yes`, LLVM 22) prints
  nothing, so this is not a property of the wasm backend's code generation.
- Every published build is `-DWITH_LLVM=no`, so the ladder above is the wasm backend; the LLVM backend
  was checked separately as described.

## Where I would look

A pass that decides the statement has no side effects, given that it vanishes and the module shrinks.
The pass list is being bisected now by dropping one pass at a time, which is possible without
rebuilding because the entry point reads the list from the filesystem before each run; if a specific
pass turns out to be responsible I will follow up here with its name.

## Why it matters

Listing a loop's values is the first thing anyone writes in Fortran, and the failure is silent — no
diagnostic, exit status 0 — so a user cannot tell a working program from a broken one. It is currently
the reason a browser playground cannot use a current LFortran build: 0.59.0 is the newest release whose
LLVM backend prints correctly, and it predates the wasm run path, while every release that can run in a
browser has this bug.
