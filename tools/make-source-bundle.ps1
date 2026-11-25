<#
.SYNOPSIS
  Makes dist-installer\MediaVerse-Studio-Source-<commit>.zip: the complete source for a Windows build (D88).
.DESCRIPTION
  Share it in the same place as MediaVerse-Studio-Setup.exe. The GPL (libcdio, libcdio-paranoia) and LGPL (LAME,
  libiconv) need the corresponding source to be available to everyone who gets the program; the repository is
  private, so this file is how testers get it.

  Contents:
    mediaverse-studio-<commit>.zip   MediaVerse Studio's own source at that commit (git archive), including the
                                     build scripts (tools\), the LAME patch (third_party\patches) and provenance
    third-party\                     the exact archives the build used: libcdio, libcdio-paranoia (GitHub
                                     snapshots), lame-4.0.tar.gz, MSYS2's libiconv 1.19-1 source package
    README.txt                       what is where, with SHA-256 checksums

  It refuses to run with uncommitted changes, so the source always matches a commit (pass -AllowModified to
  override while testing the script).
#>
[CmdletBinding()]
param([switch]$AllowModified)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$commit = & (Join-Path $PSScriptRoot "git-commit.ps1")
if ($commit -eq "unknown") { throw "git was not found." }
if ($commit.EndsWith("-modified") -and -not $AllowModified) { throw "There are uncommitted changes; commit first so the source matches the build." }
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = Get-ChildItem "$env:LOCALAPPDATA\github-copilot-git-*\cmd\git.exe" | Select-Object -Last 1 -ExpandProperty FullName }
$tar = Join-Path $env:SystemRoot "System32\tar.exe"

$sources = Join-Path $root "third_party\source"
$archives = @(
    (Get-ChildItem $sources -Filter "libcdio-*.tar.gz" | Where-Object Name -match '^libcdio-[0-9a-f]{40}\.tar\.gz$'),
    (Get-ChildItem $sources -Filter "libcdio-paranoia-*.tar.gz"),
    (Get-Item (Join-Path $sources "lame-4.0.tar.gz") -ErrorAction SilentlyContinue),
    (Get-Item (Join-Path $sources "mingw-w64-libiconv-1.19-1.src.tar.zst") -ErrorAction SilentlyContinue)
)
if (($archives | Where-Object { $_ }).Count -ne 4) { throw "A third-party source archive is missing from third_party\source (see third_party\provenance.toml for where each comes from)." }

$out = Join-Path $root "dist-installer"
$stage = Join-Path $out "source-staging"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force (Join-Path $stage "third-party") | Out-Null

$shortCommit = $commit.Replace("-modified", "")
& $git -C $root archive --format=zip --prefix "mediaverse-studio-$shortCommit/" -o (Join-Path $stage "mediaverse-studio-$shortCommit.zip") $shortCommit
if ($LASTEXITCODE) { throw "git archive failed." }
foreach ($archive in $archives) { Copy-Item $archive.FullName (Join-Path $stage "third-party") }

$lines = Get-ChildItem $stage -Recurse -File | ForEach-Object { "  {0}  {1}" -f (Get-FileHash $_.FullName).Hash, $_.FullName.Substring($stage.Length + 1) }
@"
MediaVerse Studio - complete source for build $commit
=======================================================

mediaverse-studio-$shortCommit.zip
    MediaVerse Studio's own source (GPL-3.0-or-later). Building on Windows: README.md, third_party\README.md
    (native parts: libcdio, the CD helper, LAME) and tools\package-windows.ps1 / tools\make-installer.ps1.
    third_party\provenance.toml records where each archive below comes from and its expected SHA-256.

third-party\libcdio-*.tar.gz, third-party\libcdio-paranoia-*.tar.gz
    GPL-3.0-or-later. Built static by tools\build-libcdio-mingw.ps1 and linked into mediaverse_cd_helper.exe.
third-party\lame-4.0.tar.gz
    LGPL-2.0-or-later. Built by tools\build-lame-4.0.ps1 with third_party\patches\lame-4.0-disable-optional-mpg123-prelink.patch;
    shipped as resources\lame.exe.
third-party\mingw-w64-libiconv-1.19-1.src.tar.zst
    LGPL-2.1-or-later. MSYS2's source package (GNU libiconv 1.19, its signature, MSYS2's PKGBUILD and patches) for
    the static libiconv in MSYS2 UCRT64, linked into mediaverse_cd_helper.exe.

SHA-256:
$($lines -join "`r`n")
"@ | Set-Content (Join-Path $stage "README.txt")

$zip = Join-Path $out "MediaVerse-Studio-Source-$commit.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
& $tar -a -c -f $zip -C $stage .
if ($LASTEXITCODE) { throw "tar could not make the zip." }
Remove-Item -Recurse -Force $stage
Write-Host ("Source bundle: {0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
