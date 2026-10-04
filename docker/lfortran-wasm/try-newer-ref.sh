#!/usr/bin/env bash
# Builds a *different* LFortran ref with the same toolchain and the same build script, to tell a bug in
# our build configuration apart from a bug in LFortran itself.
#
#   docker run --rm -v "$PWD/out:/out" <image> bash /try-newer-ref.sh v0.66.0
#
# The build proper is unchanged: this only checks the ref out and installs that ref's pixi
# environments, then hands over to /build.sh. The clone in the image lives at the ref the image was
# built from, so this is a fetch and a checkout rather than a fresh clone.
set -euo pipefail

REF="${1:-v0.66.0}"

cd /src
echo "=== fetching and checking out $REF ==="
git fetch --tags --force origin
git checkout --force "$REF"
git --no-pager log -1 --oneline
echo "--- version file at this ref ---"
cat version 2>/dev/null || echo "(no version file)"

# The image carries the previous ref's build output, and reusing any of it would be silently wrong:
#   * the runtime .mod files are version-stamped, and a compiler refuses a .mod from another version,
#     so leaving them would fail the compile with "Incompatible format" rather than testing anything;
#   * the wasm build tree holds objects for the previous ref's sources.
rm -rf "${PREFIX:-/src/.pixi/envs/wasm-host}"/lib/*.mod
rm -rf /src/asset_dir /src/build-wasm
echo "cleared the previous ref's build output"

# The ref may declare different dependencies, so both environments are solved again.
echo "=== installing this ref's pixi environments ==="
pixi install -e wasm-build
pixi install -e wasm-host --platform emscripten-wasm32

echo "=== building $REF with the shared build script ==="
exec bash /build.sh
