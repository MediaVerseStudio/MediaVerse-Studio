[CmdletBinding()]
param(
    [ValidateSet("debug", "release")][string]$Profile = "release",
    [string]$Msys2Root = "C:\msys64"
)

# Builds the native CD helper for x86_64-pc-windows-gnu against the local static libcdio
# (run tools/build-libcdio-mingw.ps1 first). Uses the MSYS2 UCRT64 GCC as the linker.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gcc = Join-Path $Msys2Root "ucrt64\bin\gcc.exe"
if (-not (Test-Path $gcc)) { throw "MSYS2 UCRT64 GCC not found at $gcc." }
if (-not (Test-Path (Join-Path $root "third_party\build\libcdio-native\prefix\lib\libcdio.a"))) {
    throw "libcdio is not built. Run tools\build-libcdio-mingw.ps1 first."
}

$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = $gcc
$env:MEDIAVERSE_MINGW_LIB = (Join-Path $Msys2Root "ucrt64\lib") -replace '\\', '/'
$env:Path = "$(Join-Path $Msys2Root 'ucrt64\bin');$env:Path"

$arguments = @("build", "--target", "x86_64-pc-windows-gnu", "-p", "mediaverse_cd_helper")
if ($Profile -eq "release") { $arguments += "--release" }
Push-Location $root
try {
    & cargo @arguments
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE." }
    Write-Host "Built: target\x86_64-pc-windows-gnu\$Profile\mediaverse_cd_helper.exe"
} finally { Pop-Location }
