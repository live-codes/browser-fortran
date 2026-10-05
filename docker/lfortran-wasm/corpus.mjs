// The acceptance corpus, shared by the Node harness (test-run.mjs) and the browser probe
// (browser-test.html) so both judge the same programs.
//
// This is the same corpus that was run against the f2c pipeline, deliberately: the interesting
// question is not "does LFortran work" but whether it fixes the cases f2c accepted *and got wrong*.
// `array section` is the one to watch — f2c compiled `PRINT *, A(2:3)` on a `REAL A(4)`, ran it,
// exited 0 and printed all four elements, because it reads `x(a:b)` as a character substring.
export const CASES = {
	'hello (free form)': `program hello
print *, 'hello from LFortran'
end program
`,
	'DO loop': `program squares
integer :: i, sq
do i = 1, 10
   sq = i * i
   print *, 'n=', i, '  n squared=', sq
end do
end program
`,
	'arrays, DATA, REAL': `program stats
real :: x(5), total, avg
integer :: i
data x /1.0, 2.0, 3.0, 4.0, 5.0/
total = 0.0
do i = 1, 5
   total = total + x(i)
end do
avg = total / 5.0
print *, 'Sum  = ', total
print *, 'Mean = ', avg
end program
`,
	'subroutine and function': `program calls
integer :: n
call double(21, n)
print *, 'doubled:', n
print *, 'tripled:', triple(14)
contains
integer function triple(v)
   integer, intent(in) :: v
   triple = v * 3
end function
subroutine double(v, out)
   integer, intent(in) :: v
   integer, intent(out) :: out
   out = v * 2
end subroutine
end program
`,
	'F90 declarations': `program decl
integer :: i
real(8) :: r
character(len=10) :: s
i = 1
r = 1.5
s = 'hi'
print *, i, r, s
end program
`,
	'MODULE + USE': `module m
implicit none
contains
subroutine say
   print *, 'from a module'
end subroutine
end module
program p
use m
call say
end program
`,
	'derived type': `program p
type :: point
   real :: x, y
end type
type(point) :: p1
p1%x = 1.0
p1%y = 2.0
print *, p1%x, p1%y
end program
`,
	'ALLOCATABLE': `program p
real, allocatable :: a(:)
allocate(a(3))
a(1) = 1.0
a(2) = 2.0
a(3) = 3.0
print *, a(1) + a(2) + a(3)
end program
`,
	'array section A(2:3)': `program p
real :: a(4)
a(1) = 10.0
a(2) = 20.0
a(3) = 30.0
a(4) = 40.0
print *, 'A(2:3) =', a(2:3)
end program
`,
	'whole-array arithmetic': `program p
real :: a(3), b(3)
a = 1.0
b = a + 1.0
print *, b
end program
`,
	'SUM intrinsic': `program p
real :: a(3)
a(1) = 1.0
a(2) = 2.0
a(3) = 3.0
print *, sum(a)
end program
`,
	'READ from stdin': `program adder
integer :: a, b
print *, 'Enter two integers:'
read *, a
read *, b
print *, 'Sum = ', a + b
end program
`,
	// The shape upstream's own wasm tests use: global statements with no program unit.
	'statements, no program unit': `integer :: i
i = 5
print *, i
`,
	'statements, implicit program': `real :: x
x = 3.5
print *, x
`,
	// Regression guard: list-directed print inside a do loop printed nothing, silently, with exit code
	// 0 — the kind of failure an exit-code-only assertion cannot see.
	'print inside a loop': `program p
integer :: i
do i = 1, 3
   print *, i
end do
end program
`,
	// The starter template's own program, so what users first see is covered by the probe. It prints a
	// title line and then a counter, which the template's markup splits out.
	'starter program (counter)': `program counter
implicit none
integer :: count

print *, 'Fortran'

read *, count
count = count + 1
print *, count
end program
`,
};

// What each program must and must not print. Asserting only on the exit code let a case that printed
// nothing pass as OK, so these are checked too.
export const EXPECT = {
	'hello (free form)': { expect: ['hello from LFortran'] },
	'DO loop': { expect: ['n = 1', 'n squared = 100'] },
	'arrays, DATA, REAL': { expect: ['Sum', 'Mean', '15.0000000'] },
	'subroutine and function': { expect: ['doubled: 42', 'tripled: 42'] },
	'F90 declarations': { expect: ['1 1.5000000000000000 hi'] },
	'MODULE + USE': { expect: ['from a module'] },
	'derived type': { expect: ['1.00000000 2.00000000'] },
	'ALLOCATABLE': { expect: ['6.00000000'] },
	// f2c compiled this, ran it, exited 0 and printed all four elements.
	'array section A(2:3)': { expect: ['20.0000000', '30.0000000'], not: ['10.0000000', '40.0000000'] },
	'whole-array arithmetic': { expect: ['2.00000000 2.00000000 2.00000000'] },
	'SUM intrinsic': { expect: ['6.00000000'] },
	'READ from stdin': { expect: ['Sum =  42'] },
	'statements, no program unit': { expect: ['5'] },
	'statements, implicit program': { expect: ['3.50000000'] },
	'print inside a loop': { expect: ['1', '2', '3'] },
	'starter program (counter)': { expect: ['Fortran', '0'] },
};

export const STDIN = {
	'READ from stdin': '20\n22\n',
	// The starter's markup seeds the counter with -1, so the first run prints 0.
	'starter program (counter)': '-1\n',
};

export function stdinFor(name) {
	return STDIN[name] ?? '';
}
