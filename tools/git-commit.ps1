<#
.SYNOPSIS
  Prints the short commit id of the working copy, with "-modified" when there are uncommitted changes.
  Finds git on the path or in the GitHub Copilot copy used on the development PC.
#>
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) {
    $git = Get-ChildItem "$env:LOCALAPPDATA\github-copilot-git-*\cmd\git.exe" -ErrorAction SilentlyContinue | Select-Object -Last 1 -ExpandProperty FullName
}
if (-not $git) { return "unknown" }
$id = (& $git -C $root rev-parse --short HEAD).Trim()
if (& $git -C $root status --porcelain --untracked-files=no) { $id = "$id-modified" }
return $id
