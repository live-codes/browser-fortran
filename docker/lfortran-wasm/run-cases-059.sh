#!/usr/bin/env bash
# Ask the freshly built native LFortran 0.59.0 what its LLVM backend does with the cases in question.
#
#   docker cp run-cases-059.sh lf-native059:/run-cases.sh
#   docker exec lf-native059 bash /run-cases.sh
#
# Separate from build-native-059.sh so it can be re-run without rebuilding: the compiler is at
# /src/src/bin/lfortran and its runtime library sits next to it, which is where its rpath points.
#
# `--linker=gcc` because LFortran links by invoking clang by default and this build image has gcc, not
# clang — the compiler says as much itself and points at this flag.
set -uo pipefail

LFORTRAN=/src/src/bin/lfortran
LINKER="${LFORTRAN_LINKER:-gcc}"

echo "=== version ==="
$LFORTRAN --version

case_run() {
	local label="$1" src="$2" out="$3" input="${4-}"
	echo
	echo "=== $label ==="
	if ! $LFORTRAN --linker="$LINKER" "$src" -o "$out" 2>&1; then
		echo "(did not compile)"
		return
	fi
	if [ -n "$input" ]; then
		printf '%s\n' "$input" | "$out"
	else
		"$out"
	fi
	echo "--- exit $? ---"
}

printf '%s\n' \
	'program p' \
	'integer :: i' \
	'do i = 1, 3' \
	"   print *, i" \
	'end do' \
	'end program' > /loop.f90

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

printf '%s\n' \
	'program p' \
	'real :: a(4)' \
	'a = 1.0' \
	"print *, a(2:3)" \
	'end program' > /section.f90

printf '%s\n' \
	'program p' \
	'integer :: a' \
	"read *, a" \
	"print *, a * 2" \
	'end program' > /reader.f90

case_run "do loop with print *  (the regression case)" /loop.f90 /loop
case_run "derived type member access" /derived.f90 /derived
case_run "array section" /section.f90 /section
case_run "read from stdin" /reader.f90 /reader "21"

echo
echo "=== done ==="
