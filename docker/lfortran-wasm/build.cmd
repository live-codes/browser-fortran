@echo off
setlocal
rem Builds LFortran for WebAssembly in Docker and copies the artifacts out.
rem
rem   build.cmd            toolchain image, then the LFortran build
rem   build.cmd rebuild    skip the image build and only re-run the container step
rem
rem The batch equivalent of build.sh, because chaining docker commands in cmd.exe is easy to get
rem wrong and this keeps the sequence in one file.

set REF=v0.65.0
set IMAGE=lfortran-wasm-build
set CONTAINER=lfortran-wasm-build-run

rem %~dp0 ends with a backslash, and `"C:\path\"` escapes the closing quote when cmd hands the
rem argument to a program -- docker would then see a truncated path. Strip it.
set HERE=%~dp0
if "%HERE:~-1%"=="\" set HERE=%HERE:~0,-1%

if /I not "%1"=="rebuild" (
    echo === building the toolchain image %IMAGE% ^(LFortran %REF%^) ===
    rem --network=host: Docker Desktop's build DNS proxy intermittently fails to resolve
    rem prefix.dev, and `pixi install` then dies after ~9 minutes of retries. Host networking uses
    rem the machine's own resolver.
    docker build --network=host --build-arg LFORTRAN_REF=%REF% -t %IMAGE% "%HERE%"
    if errorlevel 1 goto :fail
)

echo === building LFortran for WebAssembly ===
docker rm -f %CONTAINER% >nul 2>&1
docker create --name %CONTAINER% %IMAGE%
if errorlevel 1 goto :fail
docker start -a %CONTAINER%
if errorlevel 1 goto :fail

echo === copying artifacts out ===
if exist "%HERE%\out" rmdir /s /q "%HERE%\out"
mkdir "%HERE%\out"
docker cp %CONTAINER%:/out/. "%HERE%\out"
docker rm -f %CONTAINER% >nul 2>&1

echo === DONE ===
dir /b "%HERE%\out"
exit /b 0

:fail
echo === FAILED ===
exit /b 1
