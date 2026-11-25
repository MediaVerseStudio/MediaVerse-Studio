[CmdletBinding()]
param(
    [string]$Device = "\\.\E:",
    [int]$BaseLsn = 100000,
    [int]$FarLsnA = 20000,
    [int]$FarLsnB = 200000,
    [string]$Msys2Root = "C:\msys64"
)

# Builds tools/cdprobe/cachetest.c against the local libcdio build and runs it (read-only).
# Choose LSNs that are inside the audio area of the disc in the drive.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:MSYSTEM = "UCRT64"
$env:CHERE_INVOKING = "1"

$script = @"
set -e
P=third_party/build/libcdio-native/prefix
mkdir -p third_party/build/cdprobe
gcc -O2 -Wall -I`$P/include tools/cdprobe/cachetest.c -o third_party/build/cdprobe/cachetest.exe \
  -L`$P/lib -lcdio -liconv -lwinmm -lws2_32 -lm
./third_party/build/cdprobe/cachetest.exe '$Device' $BaseLsn $FarLsnA $FarLsnB
"@

Push-Location $root
try {
    $scriptPath = Join-Path $root "third_party\build\run-cachetest.sh"
    New-Item -ItemType Directory -Force (Split-Path $scriptPath) | Out-Null
    [IO.File]::WriteAllText($scriptPath, ($script -replace "`r`n", "`n"))
    & "$Msys2Root\usr\bin\bash.exe" -lc "bash third_party/build/run-cachetest.sh"
    if ($LASTEXITCODE -ne 0) { throw "cachetest exited with code $LASTEXITCODE." }
} finally { Pop-Location }
