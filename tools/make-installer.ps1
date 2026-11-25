<#
.SYNOPSIS
  Builds MediaVerse-Studio-Setup.exe in dist-installer: one file you can copy to another computer or a virtual machine.
.DESCRIPTION
  1. builds the program (tools\package-windows.ps1) into dist-app\installer\app,
  2. puts the install and uninstall scripts (tools\installer) beside it and zips the lot with the tar.exe that comes
     with Windows,
  3. appends that zip to a copy of the small setup program (apps\installer-stub, standard library only) followed by a
     trailer, so the result is one self-extracting .exe. Running it unpacks to a temporary folder and runs install.ps1.
  The installer is per user (no administrator rights), adds a Start menu shortcut (and a desktop one if you agree) and an
  entry in Settings > Apps with an uninstaller. Run it with /Q for a silent install.
  It is NOT signed, so Windows SmartScreen will warn ("Windows protected your PC": More info > Run anyway).
  Sharing it (D88): the program carries a licences folder, and this script also makes
  MediaVerse-Studio-Source-<commit>.zip (tools\make-source-bundle.ps1). Always share the two files together, in
  the same place: the GPL and LGPL parts (libcdio, LAME, libiconv) require the source to be available with the program.
.PARAMETER SkipBuild
  Reuse the last build in dist-app\installer\app.
.PARAMETER SkipSource
  Do not make the source bundle (for a build that stays on your own computers).
#>
[CmdletBinding()]
param([switch]$SkipBuild, [switch]$SkipSource)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$bundle = Join-Path $root "dist-app\installer"
$out = Join-Path $root "dist-installer"
$tar = Join-Path $env:SystemRoot "System32\tar.exe"

# The project's AcoustID application key goes into the program at build time, from the environment or from a private file outside the repository
# (never from the source). Without one the build starts with no key and the Settings page asks (see BUILT_IN_ACOUSTID_KEY in crates/disc-metadata).
if (-not $env:MEDIAVERSE_ACOUSTID_KEY) {
    $keyFile = Join-Path $env:USERPROFILE ".mediaverse\acoustid-key.txt"
    if (Test-Path $keyFile) { $env:MEDIAVERSE_ACOUSTID_KEY = (Get-Content $keyFile -Raw).Trim() }
}
if ($env:MEDIAVERSE_ACOUSTID_KEY) { Write-Host "Building with the AcoustID application key from the environment or $env:USERPROFILE\.mediaverse." } else { Write-Host "No AcoustID application key given: this build starts without one." }

if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot "package-windows.ps1") -FolderName "installer\app"
}
if (-not (Test-Path (Join-Path $bundle "app\MediaVerse Studio.exe"))) { throw "Build first: dist-app\installer\app is missing." }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $bundle "app\README-TEST-BUILD.txt")
if (-not (Test-Path (Join-Path $bundle "app\licenses\README.txt"))) { throw "The build has no licences folder; run without -SkipBuild." }
Copy-Item (Join-Path $PSScriptRoot "installer\install.ps1") $bundle -Force
Copy-Item (Join-Path $PSScriptRoot "installer\uninstall.ps1") $bundle -Force

Push-Location $root
try {
    cargo build --release -p mediaverse_setup_stub --config (Join-Path $PSScriptRoot "crt-static.toml")
    if ($LASTEXITCODE) { throw "building the setup program failed" }
} finally { Pop-Location }
$stub = Join-Path $root "target\release\mediaverse-setup-stub.exe"

New-Item -ItemType Directory -Force $out | Out-Null
$zip = Join-Path $out "payload.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Write-Host "Compressing the program..."
& $tar -a -c -f $zip -C $bundle .
if ($LASTEXITCODE -or -not (Test-Path $zip)) { throw "tar could not make the zip (exit code $LASTEXITCODE)." }

$target = Join-Path $out "MediaVerse-Studio-Setup.exe"
Copy-Item $stub $target -Force
# The setup program gets the icon and a name too (D89), before the program is appended to it.
$rcedit = & (Join-Path $PSScriptRoot "fetch-rcedit.ps1")
& $rcedit $target --set-icon (Join-Path $root "web\app\electron\icon.ico") --set-version-string "FileDescription" "MediaVerse Studio setup" --set-version-string "ProductName" "MediaVerse Studio"
if ($LASTEXITCODE) { throw "rcedit could not set the setup program's icon (exit code $LASTEXITCODE)." }
$zipLength = (Get-Item $zip).Length
$stream = [System.IO.File]::Open($target, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write)
try {
    $source = [System.IO.File]::OpenRead($zip)
    try { $source.CopyTo($stream) } finally { $source.Dispose() }
    $trailer = New-Object byte[] 16
    [BitConverter]::GetBytes([uint64]$zipLength).CopyTo($trailer, 0)
    [Text.Encoding]::ASCII.GetBytes("MVSETUP1").CopyTo($trailer, 8)
    $stream.Write($trailer, 0, 16)
} finally { $stream.Dispose() }
Remove-Item -Force $zip

$hash = (Get-FileHash $target -Algorithm SHA256).Hash
Set-Content (Join-Path $out "MediaVerse-Studio-Setup.sha256.txt") "$hash  MediaVerse-Studio-Setup.exe"
Write-Host ("Done: {0} ({1} MB)" -f $target, [int]((Get-Item $target).Length / 1MB))
Write-Host "SHA-256: $hash"
if (-not $SkipSource) {
    $built = (Get-Content (Join-Path $bundle "app\resources\app\commit.txt") -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($built -and $built.EndsWith("-modified")) {
        Write-Warning "This build has uncommitted changes ($built), so no source bundle was made. Commit, rebuild, and only share a build made from a commit."
    } else {
        & (Join-Path $PSScriptRoot "make-source-bundle.ps1")
        Write-Host "Share BOTH files together: the setup program and the source bundle."
    }
}
