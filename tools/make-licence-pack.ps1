<#
.SYNOPSIS
  Makes the licences folder that ships beside the program (D88), in dist-app\licenses.
.DESCRIPTION
  Collects every licence text and notice for the Windows build (from the source archives in third_party\source,
  the MSYS2 toolchain and the cargo registry), lists the Rust libraries compiled in, and writes README.txt with
  how to get the source. tools\package-windows.ps1 runs it and copies the folder into the program. It stops with
  an error if anything is missing, so a build never ships with an incomplete folder.
.PARAMETER OutDir
  Where to write it (default dist-app\licenses).
#>
[CmdletBinding()]
param([string]$OutDir)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
if (-not $OutDir) { $OutDir = Join-Path $root "dist-app\licenses" }
$commit = & (Join-Path $PSScriptRoot "git-commit.ps1")
node (Join-Path $PSScriptRoot "licences\make-licence-pack.cjs") $OutDir $commit
if ($LASTEXITCODE) { throw "The licences folder could not be completed (see above)." }
