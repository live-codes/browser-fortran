#!/usr/bin/env bash
# Does LFortran 0.59.0's LLVM backend still print inside a do loop?
#
#   docker run -d --name lf-native059 lfortran-wasm-build sleep infinity
#   docker cp build-native-059.sh lf-native059:/build-native.sh
#   docker exec -d lf-native059 bash -c "bash /build-native.sh > /native.log 2>&1"
#   docker exec lf-native059 tail -40 /native.log
#
# Every *published* wasm build is `-DWITH_LLVM=no`, so the LLVM backend can only be asked by building
# it. This is the cheap half of that: a native build, run directly, to answer the question before
# committing to a wasm build of the same ref. The loop regression appeared between 0.59.0 and 0.60.0
# on the wasm backend, and the LLVM backend is broken at 0.65/0.66; if it is also broken here, then no
# amount of wasm porting yields a compiler that is both complete and correct, and the effort should
# go elsewhere.
#
# A native build also sidesteps the blocker entirely: 0.59.0's pixi.toml has no wasm-build/wasm-host
# environments, but it does have `llvm21 = {features = ["llvm21", "build"]}`, which is exactly what a
# native build needs. The wasm environments would have to be borrowed from a later ref.
set -euo pipefail

cd /src
echo "=== fetching v0.59.0 ==="
# Only this tag. The image's clone is shallow (--depth 1 of another ref), and `git fetch --tags` there
# pulls every tag in the repository — thousands for LFortran — which looks like a hang and is not what
# is wanted anyway.
git fetch --depth 1 origin tag v0.59.0
git checkout --force v0.59.0
git --no-pager log -1 --oneline || true
echo "version file: $(cat version 2>/dev/null || echo none)"

echo "=== installing the native LLVM 21 environment (this ref's own line) ==="
pixi install -e llvm21

echo "=== build0.sh: parser / AST / ASR sources ==="
pixi run -e llvm21 ./build0.sh

echo "=== build1.sh: native LFortran ==="
pixi run -e llvm21 bash ./build1.sh

LFORTRAN=/src/src/bin/lfortran
echo "=== version ==="
$LFORTRAN --version || true

printf '%s\n' \
	'program p' \
	'integer :: i' \
	'do i = 1, 3' \
	"   print *, i" \
	'end do' \
	'end program' > /loop.f90

echo
echo "=== the case in question: do loop with print *, compiled with the LLVM backend ==="
$LFORTRAN --backend=llvm /loop.f90 -o /loop
echo "--- running it ---"
/loop
echo "--- exit $? ---"

printf '%s\n' \
	'program p' \
	'type :: point' \
	'   real :: x, y' \
	'end type' \
	'type(point) :: q' \
	'q%x = 3.0' \
	'q%y = 4.0' \
	"print *, q%x + q%y" \
	'end program' > /derived.f90
echo
echo "=== derived type member access ==="
$LFORTRAN --backend=llvm /derived.f90 -o /derived && /derived || echo "(failed to compile or run)"

printf '%s\n' \
	'program p' \
	'real :: a(4)' \
	'a = 1.0' \
	"print *, a(2:3)" \
	'end program' > /section.f90
echo
echo "=== array section ==="
$LFORTRAN --backend=llvm /section.f90 -o /section && /section || echo "(failed to compile or run)"

printf '%s\n' \
	'program p' \
	'integer :: a' \
	"read *, a" \
	"print *, a * 2" \
	'end program' > /reader.f90
echo
echo "=== read from stdin ==="
$LFORTRAN --backend=llvm /reader.f90 -o /reader && echo 21 | /reader || echo "(failed to compile or run)"

echo
echo "=== done ==="
