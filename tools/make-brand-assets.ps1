<#
.SYNOPSIS
  Remakes every program icon and logo piece from the sources in brand\ (see brand\README.md).
.DESCRIPTION
  Runs tools\brand\render-brand.cjs in the Electron that the desktop app already uses (web\app\node_modules), so no
  image tools are needed. Writes the desktop header pieces, the Windows .ico, the Samsung TV icon and the Android
  launcher icons in place; review them with git diff before committing.
#>
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$electron = Join-Path $root "web\app\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "Electron is missing: run npm install in web\app first." }
& $electron (Join-Path $PSScriptRoot "brand\render-brand.cjs") 2>&1 | Where-Object { "$_" -notmatch "DevTools|GPU|gpu_" }
if ($LASTEXITCODE) { throw "Making the brand files failed (exit code $LASTEXITCODE)." }
