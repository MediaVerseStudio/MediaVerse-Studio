[CmdletBinding()]
param([string]$Msys2Root = "C:\msys64")

# Wrapper: runs build-libcdio-mingw.sh in the MSYS2 UCRT64 environment from the repo root.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:MSYSTEM = "UCRT64"
$env:CHERE_INVOKING = "1"
Push-Location $root
try {
    & "$Msys2Root\usr\bin\bash.exe" -lc "bash tools/build-libcdio-mingw.sh"
    if ($LASTEXITCODE -ne 0) { throw "libcdio build failed with exit code $LASTEXITCODE." }
} finally { Pop-Location }
