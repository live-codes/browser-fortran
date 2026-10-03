#!/usr/bin/env bash
# Builds LFortran for WebAssembly and copies the artifacts out of the container.
#
#   ./build.sh                 # build the toolchain image, then build LFortran in it
#   IMAGE=x ./build.sh         # use/keep a different image name
#   LFORTRAN_REF=v0.65.0 ./build.sh
#
# The first run installs gigabytes of toolchain and compiles LFortran, so expect it to take a long
# while; afterwards the image layers are cached and only the LFortran build re-runs.
#
# Artifacts are copied out with `docker cp` rather than a bind mount, so this works the same on
# Windows and does not depend on which drives the host has shared.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${IMAGE:-lfortran-wasm-build}"
CONTAINER="${CONTAINER:-lfortran-wasm-build-run}"
REF="${LFORTRAN_REF:-v0.65.0}"

echo "=== building the toolchain image (${IMAGE}) ==="
# --network=host: Docker Desktop's build DNS proxy intermittently fails to resolve prefix.dev, and
# `pixi install` then dies after ~9 minutes of retries. Host networking uses the machine's resolver.
docker build --network=host --build-arg "LFORTRAN_REF=${REF}" -t "${IMAGE}" "${HERE}"

echo "=== building LFortran for WebAssembly (${CONTAINER}) ==="
docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker create --name "${CONTAINER}" "${IMAGE}" >/dev/null
docker start -a "${CONTAINER}"

echo "=== copying artifacts out ==="
rm -rf "${HERE}/out"
mkdir -p "${HERE}/out"
docker cp "${CONTAINER}:/out/." "${HERE}/out"
docker rm -f "${CONTAINER}" >/dev/null

ls -l "${HERE}/out"
