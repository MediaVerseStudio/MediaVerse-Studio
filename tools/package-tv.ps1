<#
.SYNOPSIS
  Builds the MediaVerse Studio TV app and packages it as a signed Tizen .wgt (D38).
.DESCRIPTION
  Needs Samsung's Tizen Studio (D37) with a certificate profile made in its Certificate Manager (a Samsung
  author certificate and a Samsung distributor certificate that lists each TV's device ID).
  The certificates and their passwords stay on this computer; nothing here stores them.
.PARAMETER CertificateProfile
  The name of the certificate profile in Tizen Studio's Certificate Manager.
.PARAMETER Install
  TV addresses to install on after packaging (each TV must be in developer mode with this PC's address).
.EXAMPLE
  tools\package-tv.ps1 -CertificateProfile MediaVerseTV
.EXAMPLE
  tools\package-tv.ps1 -CertificateProfile MediaVerseTV -Install 192.168.1.50
#>
param(
  [Parameter(Mandatory = $true)][string]$CertificateProfile,
  [string[]]$Install = @(),
  [string]$TizenStudio = "C:\tizen-studio",
  [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$web = Join-Path $repo "web\app"
$tizen = Join-Path $TizenStudio "tools\ide\bin\tizen.bat"
$sdb = Join-Path $TizenStudio "tools\sdb.exe"
if (-not (Test-Path $tizen)) { throw "Tizen Studio's command-line tool was not found at $tizen." }

if (-not $SkipBuild) {
  Push-Location $web
  try {
    npm run tv:build
    if ($LASTEXITCODE -ne 0) { throw "The TV app did not build." }
  } finally { Pop-Location }
}

$built = Join-Path $web "dist-tv"
$out = Join-Path $repo "dist-tv-package"
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -Filter *.wgt -ErrorAction SilentlyContinue | Remove-Item -Force

# tizen package signs the folder in place (it adds author and distributor signature files), so package a copy.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("mediaverse-tv-" + [guid]::NewGuid().ToString("N"))
Copy-Item $built $stage -Recurse
try {
  & $tizen package -t wgt -s $CertificateProfile -o $out -- $stage
  if ($LASTEXITCODE -ne 0) { throw "tizen package failed (see above). Is the certificate profile name right?" }
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
$package = Get-ChildItem $out -Filter *.wgt | Select-Object -First 1
if (-not $package) { throw "No .wgt was made." }
# tizen package names the file after the app ("MediaVerse Studio.wgt"); the TV's installer fails on the space.
$package = Rename-Item $package.FullName "MediaVerseStudio.wgt" -PassThru
Write-Host "Packaged: $($package.FullName)"

foreach ($tv in $Install) {
  Write-Host "Installing on $tv ..."
  & $sdb connect $tv | Write-Host
  $serial = "${tv}:26101"
  & $tizen install -n $package.FullName -s $serial
  if ($LASTEXITCODE -ne 0) { Write-Warning "Install on $tv failed (see above)." }
}
