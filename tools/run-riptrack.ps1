[CmdletBinding()]
param(
    [string]$Device = "\\.\E:",
    [Parameter(Mandatory)][int]$Track,
    [int]$MarginSectors = 5,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateSet("full", "relaxed", "fast", "none")][string]$Mode = "full",
    [string]$Msys2Root = "C:\msys64"
)

# Builds tools/cdprobe/riptrack.c against the local libcdio + libcdio-paranoia build and rips one
# track (plus margin) to raw PCM. Read-only on the drive.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:MSYSTEM = "UCRT64"
$env:CHERE_INVOKING = "1"
$out = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
$outUnix = "/" + ($out -replace '^([A-Za-z]):', { $_.Groups[1].Value.ToLower() } -replace '\\', '/')

$script = @"
set -e
P=third_party/build/libcdio-native/prefix
mkdir -p third_party/build/cdprobe
gcc -O2 -Wall -I`$P/include tools/cdprobe/riptrack.c -o third_party/build/cdprobe/riptrack.exe \
  -L`$P/lib -lcdio_paranoia -lcdio_cdda -lcdio -liconv -lwinmm -lws2_32 -lm
./third_party/build/cdprobe/riptrack.exe '$Device' $Track $MarginSectors '$outUnix' $Mode
"@

Push-Location $root
try {
    $scriptPath = Join-Path $root "third_party\build\run-riptrack.sh"
    New-Item -ItemType Directory -Force (Split-Path $scriptPath) | Out-Null
    [IO.File]::WriteAllText($scriptPath, ($script -replace "`r`n", "`n"))
    & "$Msys2Root\usr\bin\bash.exe" -lc "bash third_party/build/run-riptrack.sh"
    if ($LASTEXITCODE -ne 0) { throw "riptrack exited with code $LASTEXITCODE." }
} finally { Pop-Location }

