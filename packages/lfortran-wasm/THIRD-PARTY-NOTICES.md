# Third-party notices

`assets/wasm_run.wasm` is not written by this package. It is LFortran, its runtime, LLVM and LLD,
compiled to WebAssembly with Emscripten. Redistributing it means redistributing those projects'
binaries, so their notices are reproduced here — LFortran's BSD 3-Clause and LLVM's Apache-2.0 both
require the notice to travel with binary distributions.

## LFortran

<https://github.com/lfortran/lfortran> — BSD 3-Clause

```
BSD 3-Clause License

Copyright (c) 2019-2020, Triad National Security, LLC. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
this list of conditions and the following disclaimer in the documentation and/or
other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
may be used to endorse or promote products derived from this software without
specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

This build also carries the patches listed in the repository's
`docker/lfortran-wasm/build-in-container.sh`; they are described in that file.

## LLVM and LLD

<https://llvm.org> — Apache License v2.0 with LLVM Exceptions

The compiler's backend, the `libLLVM*.a` archives, and LLD (which links the side module the compiler
emits at run time) are compiled into the wasm. The LLVM exception means the resulting binary does not
impose Apache-2.0 terms on this package, but the license and the exception notice must be included
with redistributions. The Apache-2.0 text is at <https://llvm.org/LICENSE.txt>, and the exception
notice is the first lines of `LICENSE.TXT` in any LLVM checkout.

## Emscripten

<https://emscripten.org> — MIT / University of Illinois

The JavaScript glue (`assets/wasm_run.js`), the preloaded filesystem format, and the C/C++ runtime
the wasm links against come from Emscripten. License: <https://github.com/emscripten-core/emscripten>
(`LICENSE`).

## LFortran runtime modules

`assets/wasm_run.data` contains the runtime `.mod` files built from LFortran's own runtime sources
(`src/runtime/`), covered by LFortran's license above. They are preloaded into the wasm filesystem at
`/lib`, which is where the evaluator resolves `use iso_c_binding` and friends.
