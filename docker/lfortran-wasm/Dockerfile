# The LFortran-to-WebAssembly toolchain, as a Docker image.
#
# The Emscripten cross toolchain is not published for Windows, and this build needs Linux, so it runs
# in a container. This file builds the *toolchain* only — the LFortran build itself is run by
# `build.sh`, so the long part can be retried without re-installing gigabytes of dependencies.
#
# Everything here follows LFortran's own pixi configuration (`pixi.toml`, the `wasm-build` and
# `wasm-host` environments) rather than inventing versions: Emscripten 4.0.9, and LLVM plus LLD for
# `emscripten-wasm32` from the emscripten-forge channel.
#
# Note what is *not* here: no pthreads, and no SharedArrayBuffer. LFortran's wasm build links
# `-fwasm-exceptions` (exceptions) but never `-pthread`, so the browser needs no cross-origin
# isolation and no shared memory. That is upstream's configuration, not something we strip.

FROM debian:bookworm-slim

ARG LFORTRAN_REF=v0.65.0

# g++ is for `wasm-build0.sh`, which builds a *native* LFortran to generate the runtime `.mod` files
# that the wasm build preloads. The wasm-build pixi environment has the cross toolchain but no host
# compiler, so this one comes from the distribution.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash bzip2 ca-certificates curl g++ git make patch xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://pixi.sh/install.sh | bash
ENV PATH="/root/.pixi/bin:${PATH}"

WORKDIR /src
RUN git clone --depth 1 --branch "${LFORTRAN_REF}" https://github.com/lfortran/lfortran.git /src

# The toolchain environments, in their own layers: they are large and slow, and nothing below this
# point should make them re-run.
RUN pixi install -e wasm-build
# `wasm-host` targets emscripten-wasm32, which the build machine cannot execute, so pixi only
# installs it when that platform is named explicitly.
RUN pixi install -e wasm-host --platform emscripten-wasm32

# The build itself is files in this image rather than mounts, so that a Windows host does not have to
# get file-mount path translation right. Only the output directory is mounted.
#
# `wasm-run-main.cpp` is the entry point that does not exist upstream: LFortran's wasm build only
# *emits* code, and in a browser there is no linker subprocess, so running a program means calling
# the evaluator in-process. See that file for the details.
COPY build-in-container.sh /build.sh
COPY wasm-run-main.cpp /wasm-run-main.cpp
CMD ["bash", "/build.sh"]
