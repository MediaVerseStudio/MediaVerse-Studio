<#
.SYNOPSIS
  Makes a made-up demo music library for screenshots and demos: 18 albums by 12 invented artists, original covers,
  tags, and time-stamped lyrics for some songs. The audio is generated (soft chords over a beat).
.DESCRIPTION
  Everything comes from tools\demo\demo-library.json, so no real artist's music or artwork is shown in the
  project's screenshots or website. Covers are drawn by tools\demo\render-covers.cjs (the app's Electron), the MP3s
  are encoded and tagged by the project's own LAME. The folder must not exist yet. Never commit the output.
.EXAMPLE
  tools\make-demo-library.ps1 -Folder <folder>\MediaVerse-Demo-Library
#>
param(
  [Parameter(Mandatory)] [string] $Folder,
  [string] $Lame = (Join-Path $PSScriptRoot "..\third_party\build\lame-4.0\x64\Release\lame.exe")
)
$ErrorActionPreference = "Stop"
if (Test-Path $Folder) { throw "The folder '$Folder' already exists; choose a new one." }
if (-not (Test-Path $Lame)) { throw "LAME not found at '$Lame' (build it with tools\build-lame-4.0.ps1)." }
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$electron = Join-Path $root "web\app\node_modules\electron\dist\electron.exe"
New-Item -ItemType Directory -Path $Folder | Out-Null
$Folder = (Resolve-Path $Folder).Path
Write-Host "Drawing covers..."
& $electron (Join-Path $PSScriptRoot "demo\render-covers.cjs") $Folder 2>&1 | Where-Object { "$_" -match "cover:|rror" }
if ($LASTEXITCODE) { throw "Drawing the covers failed." }
Write-Host "Making songs..."
node (Join-Path $PSScriptRoot "demo\make-demo-library.cjs") $Folder (Resolve-Path $Lame).Path
if ($LASTEXITCODE) { throw "Making the songs failed." }
