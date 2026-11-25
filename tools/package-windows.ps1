<#
.SYNOPSIS
  Builds a runnable Windows copy of MediaVerse Studio (a personal TEST build) in dist-app\MediaVerse Studio.
.DESCRIPTION
  No installer and no extra packaging tool: it copies the Electron runtime, renames it, puts the web app and the
  Electron main program in resources\app, and puts the Rust sidecar, the native CD helper and LAME in resources.
  Run "MediaVerse Studio.exe" from that folder. Your settings and library are kept in %APPDATA%\MediaVerse Studio,
  the same place the from-source launcher uses.

  The build carries a licences folder (tools\make-licence-pack.ps1, D88). A copy shared with anyone must also be
  accompanied by the matching source bundle (tools\make-source-bundle.ps1; make-installer.ps1 makes both).
.PARAMETER FolderName
  Name of the folder inside dist-app. Use another name when the previous build is running (Windows will not
  replace files that are in use).
.PARAMETER SkipBuild
  Reuse the last release build of the sidecar and web page.
#>
[CmdletBinding()]
param([switch]$SkipBuild, [string]$FolderName = "MediaVerse Studio")

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$app = Join-Path $root "web\app"
$final = Join-Path $root "dist-app\$FolderName"
# Everything is built in a staging folder and swapped in at the end, so a build that is running (or any
# failure part-way) can never leave the existing copy half deleted.
$out = "$final.staging"

if (-not $SkipBuild) {
    Write-Host "Building the Rust sidecar (release)..."
    Push-Location $root; try { # The C runtime is linked in (crt-static) so the program starts on a computer that has no Visual C++ Redistributable.
        cargo build --release -p mediaverse_sidecar --config (Join-Path $PSScriptRoot "crt-static.toml"); if ($LASTEXITCODE) { throw "cargo build failed" } } finally { Pop-Location }
    Write-Host "Building the web page..."
    Push-Location $app
    try {
        if (-not (Test-Path "node_modules")) { npm install; if ($LASTEXITCODE) { throw "npm install failed" } }
        npm run build; if ($LASTEXITCODE) { throw "web build failed" }
    } finally { Pop-Location }
}

$sidecar = Join-Path $root "target\release\mediaverse_sidecar.exe"
$helper = Join-Path $root "target\x86_64-pc-windows-gnu\release\mediaverse_cd_helper.exe"
$lame = Join-Path $root "third_party\build\lame-4.0\x64\Release\lame.exe"
$electron = Join-Path $app "node_modules\electron\dist"
foreach ($needed in @($sidecar, $electron, (Join-Path $app "dist\index.html"))) {
    if (-not (Test-Path $needed)) { throw "Missing: $needed" }
}
if (-not (Test-Path $helper)) {
    Write-Host "Building the CD helper (release)..."
    & (Join-Path $PSScriptRoot "build-cd-helper.ps1") -Profile release
}

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $out | Out-Null
Write-Host "Copying the Electron runtime..."
Copy-Item -Recurse -Force (Join-Path $electron "*") $out
Rename-Item (Join-Path $out "electron.exe") "MediaVerse Studio.exe"
# The program's own icon and name inside the .exe (D89): Explorer, the taskbar's pinned button and Task Manager
# show these rather than Electron's.
$package = Get-Content (Join-Path $app "package.json") -Raw | ConvertFrom-Json
$rcedit = & (Join-Path $PSScriptRoot "fetch-rcedit.ps1")
& $rcedit (Join-Path $out "MediaVerse Studio.exe") --set-icon (Join-Path $app "electron\icon.ico") `
    --set-version-string "ProductName" "MediaVerse Studio" --set-version-string "FileDescription" "MediaVerse Studio" `
    --set-version-string "CompanyName" "MediaVerse Studio" --set-version-string "LegalCopyright" "GPL-3.0-or-later" `
    --set-version-string "OriginalFilename" "MediaVerse Studio.exe" --set-version-string "InternalName" "MediaVerse Studio" `
    --set-file-version $package.version --set-product-version $package.version
if ($LASTEXITCODE) { throw "rcedit could not set the program's icon (exit code $LASTEXITCODE)." }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $out "resources\default_app.asar")

$appDir = Join-Path $out "resources\app"
New-Item -ItemType Directory -Force (Join-Path $appDir "electron") | Out-Null
Copy-Item -Recurse (Join-Path $app "dist") (Join-Path $appDir "dist")
Get-ChildItem (Join-Path $app "electron") -Filter *.js | Where-Object { $_.Name -notlike "*.test.js" } | Copy-Item -Destination (Join-Path $appDir "electron")
# The mini player's page and the taskbar button pictures live beside the scripts (without them the mini player opened as an empty black window).
Get-ChildItem (Join-Path $app "electron") -Filter *.html | Copy-Item -Destination (Join-Path $appDir "electron")
if (Test-Path (Join-Path $app "electron\icons")) { Copy-Item -Recurse -Force (Join-Path $app "electron\icons") (Join-Path $appDir "electron\icons") }
# The window/taskbar icon (D86). The installer also points the Start menu and desktop shortcuts at it, because the
# renamed electron.exe itself still carries Electron's icon.
Copy-Item (Join-Path $app "electron\icon.ico"), (Join-Path $app "electron\icon.png") (Join-Path $appDir "electron")
$package = Get-Content (Join-Path $app "package.json") -Raw | ConvertFrom-Json
@{ name = "mediaverse-studio"; productName = "MediaVerse Studio"; version = $package.version; main = "electron/main.js" } | ConvertTo-Json | Set-Content (Join-Path $appDir "package.json")

Copy-Item $sidecar (Join-Path $out "resources\mediaverse_sidecar.exe")
Copy-Item $helper (Join-Path $out "resources\mediaverse_cd_helper.exe")
if (Test-Path $lame) { Copy-Item $lame (Join-Path $out "resources\lame.exe") } else { Write-Warning "LAME is not built (tools\build-lame-4.0.ps1): the test build will not make MP3 copies." }

$commit = & (Join-Path $PSScriptRoot "git-commit.ps1")
# Settings > About shows the build; the licences folder (D88) goes beside the program.
Set-Content (Join-Path $appDir "commit.txt") $commit
& (Join-Path $PSScriptRoot "make-licence-pack.ps1") -OutDir (Join-Path $out "licenses")
@"
MediaVerse Studio - personal TEST build

Run "MediaVerse Studio.exe" in this folder. Settings, the listening history, flags and pins are kept in
%APPDATA%\MediaVerse Studio (shared with the from-source launcher).

Licences, notices and how to get the source: the licenses folder (licenses\README.txt).
Built from commit: $commit on $(Get-Date -Format "yyyy-MM-dd HH:mm")
"@ | Set-Content (Join-Path $out "README-TEST-BUILD.txt")

$size = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB

# Swap the finished build in. If the existing copy is running, Windows refuses to rename its folder; it is then
# left exactly as it was and the new build stays in the staging folder.
if (Test-Path $final) {
    $previous = "$final.previous"
    if (Test-Path $previous) { Remove-Item -Recurse -Force $previous }
    try { Rename-Item $final (Split-Path $previous -Leaf) -ErrorAction Stop }
    catch {
        Write-Warning "The existing build in '$final' is in use (close MediaVerse Studio) and was left untouched."
        Write-Host "The new build is ready in $out. Close the running copy and run this script again, or use the new folder."
        return
    }
    Rename-Item $out (Split-Path $final -Leaf)
    Remove-Item -Recurse -Force $previous
} else {
    Rename-Item $out (Split-Path $final -Leaf)
}
Write-Host ("Done: {0} ({1:N0} MB)" -f (Join-Path $final "MediaVerse Studio.exe"), $size)