[CmdletBinding()]
param([string]$Destination = "")

# Fetches Xiph's official FLAC command-line tools (version 1.5.0, Windows 64-bit) for TESTING ONLY, so
# our FLAC files can be checked with the reference decoder (`flac --test --warnings-as-errors`).
# The tools are never shipped or linked. The download is checked three ways: against the SHA-256 pinned
# below, against Xiph's published SHA256SUMS.txt, and against the same file from GitHub's release.
#
#   pwsh tools/fetch-flac-reference.ps1
#   cargo test -p mediaverse_ripper --test reference_decoder

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Destination) { $Destination = Join-Path $root "third_party\build\flac-reference" }
$version = "1.5.0"
$pinned = "53f1500f0d6e7c61379d7fee50d4a9f7f504c650009506d9ba015530d76c0dde"   # flac-1.5.0-win.zip
$mirror = "https://ftp.osuosl.org/pub/xiph/releases/flac"

$exe = Get-ChildItem $Destination -Recurse -Filter flac.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match "Win64" } | Select-Object -First 1
if ($exe) { Write-Host "Already present: $($exe.FullName)"; exit 0 }

$work = Join-Path ([IO.Path]::GetTempPath()) ("flac-ref-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
try {
    $zip = Join-Path $work "flac-$version-win.zip"
    Invoke-WebRequest "$mirror/flac-$version-win.zip" -OutFile $zip -TimeoutSec 180
    $sums = (Invoke-WebRequest "$mirror/SHA256SUMS.txt" -TimeoutSec 60).Content
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $pinned) { throw "SHA-256 does not match the pinned value (got $actual)." }
    if ($sums -notmatch "$actual\s+flac-$version-win\.zip") { throw "Xiph's SHA256SUMS.txt does not list this file's hash." }

    $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
    if (-not $gh) { $gh = "C:\Program Files\GitHub CLI\gh.exe" }
    if (Test-Path $gh) {
        $second = Join-Path $work "github"; New-Item -ItemType Directory $second | Out-Null
        & $gh release download $version --repo xiph/flac --pattern "flac-$version-win.zip" --dir $second 2>$null
        $copy = Join-Path $second "flac-$version-win.zip"
        if (Test-Path $copy) {
            if ((Get-FileHash $copy -Algorithm SHA256).Hash.ToLower() -ne $actual) { throw "The GitHub copy differs from the mirror's." }
            Write-Host "Identical copy confirmed from GitHub's release."
        }
    } else { Write-Host "(GitHub CLI not found; skipped the second-host comparison.)" }

    New-Item -ItemType Directory -Force $Destination | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $Destination)
    $exe = Get-ChildItem $Destination -Recurse -Filter flac.exe | Where-Object { $_.FullName -match "Win64" } | Select-Object -First 1
    Write-Host "Ready: $($exe.FullName)"
    & $exe.FullName --version
} finally { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
