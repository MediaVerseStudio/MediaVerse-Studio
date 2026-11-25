<#
.SYNOPSIS
  Downloads rcedit 2.0.0 (Electron's resource editor, MIT) into third_party\build and checks its SHA-256 (D89).
.DESCRIPTION
  Build-time tool only, never shipped: tools\package-windows.ps1 uses it to give the renamed electron.exe the
  program's icon and name, and tools\make-installer.ps1 to give the setup program the icon. Prints the path.
#>
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dir = Join-Path $root "third_party\build\rcedit-2.0.0"
$exe = Join-Path $dir "rcedit-x64.exe"
$expected = "3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A" # third_party\provenance.toml
if (-not (Test-Path $exe)) {
    New-Item -ItemType Directory -Force $dir | Out-Null
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe" -OutFile "$exe.download"
    Move-Item "$exe.download" $exe -Force
}
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash
if ($hash -ne $expected) {
    Remove-Item -Force $exe
    throw "rcedit-x64.exe has SHA-256 $hash, not the recorded $expected; it was deleted. Check the download before changing the record."
}
return $exe
