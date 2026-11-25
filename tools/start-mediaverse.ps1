<#
.SYNOPSIS
  Builds what is needed and starts MediaVerse Studio from source (a development prototype).
.DESCRIPTION
  Builds the web page and the Rust sidecar, builds the native CD helper if it is missing, points the
  program at the local LAME build, and opens the app. Your real settings and library are used
  (%APPDATA%\MediaVerse Studio). Use -Fresh to run with a throwaway data folder instead.
#>
[CmdletBinding()]
param([switch]$Fresh, [switch]$SkipBuild)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$app = Join-Path $root "web\app"

if (-not $SkipBuild) {
    Write-Host "Building the Rust sidecar..."
    Push-Location $root; try { cargo build -p mediaverse_sidecar; if ($LASTEXITCODE) { throw "cargo build failed" } } finally { Pop-Location }

    $helper = Join-Path $root "target\x86_64-pc-windows-gnu\release\mediaverse_cd_helper.exe"
    if (-not (Test-Path $helper) -and -not (Test-Path ($helper -replace "release","debug"))) {
        Write-Host "Building the CD helper (needs the MSYS2 and libcdio setup; see docs/release-checklist.md)..."
        & (Join-Path $PSScriptRoot "build-cd-helper.ps1")
    }

    Write-Host "Building the web page..."
    Push-Location $app
    try {
        if (-not (Test-Path "node_modules")) { npm install; if ($LASTEXITCODE) { throw "npm install failed" } }
        npm run build; if ($LASTEXITCODE) { throw "web build failed" }
    } finally { Pop-Location }
}

$lame = Join-Path $root "third_party\build\lame-4.0\x64\Release\lame.exe"
if (Test-Path $lame) { $env:MEDIAVERSE_LAME_PATH = $lame }
else { Write-Warning "LAME is not built (tools\build-lame-4.0.ps1): MP3 copies will not be made." }

if ($Fresh) {
    $env:MEDIAVERSE_USER_DATA = Join-Path ([IO.Path]::GetTempPath()) ("mediaverse-fresh-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    Write-Host "Throwaway data folder: $env:MEDIAVERSE_USER_DATA"
}

Write-Host "Starting MediaVerse Studio..."
Push-Location $app
try { npm run electron:start } finally { Pop-Location }
