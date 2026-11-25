<#
.SYNOPSIS
  Points the program's stored song paths at the current music library after the library moved (for example from
  C:\Users\X\Music to a network drive M:\).
.DESCRIPTION
  Favorites, play history, playlists, flags, the instrumental list, the Lyric AI's results and the lyrics review entries
  remember songs by their full path. When the library folder changes, those paths no longer point at the library
  (playback and saving then refuse them). This finds each old path's song in the current library by the end of its path
  (the last five, four or three parts, the longest that matches uniquely: artist, album and file name at least, so two songs are never mixed up) and rewrites the stored path. The Lyric AI
  results and review entries are files named by a hash of the song's path (FNV-1a, 64 bits, as in the program), so they are
  renamed to the hash of the new path.
  Without -Apply nothing is changed: it only says what it would do. With -Apply everything it touches is first copied to
  <DataDir>\path-rebase-backup-<time>, and the program must be closed. Paths it cannot match to a library song are left alone.
  The batch journals (picture-batches, artist-rename-batches, mb-ids) are NOT changed: Undo must act on the files they name.
.PARAMETER Root
  The library folder now (default M:\).
.PARAMETER DataDir
  The program's data folder (default %APPDATA%\MediaVerse Studio).
#>
[CmdletBinding()]
param(
  [string]$Root = "M:\",
  [string]$DataDir = (Join-Path $env:APPDATA "MediaVerse Studio"),
  [switch]$Apply
)
$ErrorActionPreference = "Stop"
$Root = $Root.TrimEnd('\') + '\'
if (-not (Test-Path $Root)) { throw "The library folder $Root was not found." }

function Get-Fnv([string]$text) {
  $hash = [System.Numerics.BigInteger]::Parse("14695981039346656037")
  $prime = [System.Numerics.BigInteger]1099511628211
  $mod = [System.Numerics.BigInteger]::Pow(2, 64)
  foreach ($b in [Text.Encoding]::UTF8.GetBytes($text)) {
    $hash = ([System.Numerics.BigInteger]($hash -bxor $b) * $prime) % $mod
  }
  return ([UInt64]$hash).ToString("x16")
}

# The current library's songs, by the end of their path.
$audio = '.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus'
$byTail = @{}
$count = 0
foreach ($file in [IO.Directory]::EnumerateFiles($Root, '*', [IO.SearchOption]::AllDirectories)) {
  if ($audio -notcontains [IO.Path]::GetExtension($file).ToLowerInvariant()) { continue }
  $count++
  $parts = $file.Substring($Root.Length) -split '\\' | Where-Object { $_ -ne '' }
  for ($n = 3; $n -le [Math]::Min(5, $parts.Count); $n++) {
    $key = ($parts[($parts.Count - $n)..($parts.Count - 1)] -join '/').ToLowerInvariant()
    if ($byTail.ContainsKey($key)) { $byTail[$key] = $null } else { $byTail[$key] = $file } # null: two songs end alike: ambiguous
  }
}
Write-Host "Library $Root : $count songs."

$memo = @{}
function Get-Moved([string]$old) {
  if ($memo.ContainsKey($old)) { return $memo[$old] }
  $moved = $null
  if (-not $old.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
    $parts = $old -split '[\\/]' | Where-Object { $_ -ne '' -and $_ -notmatch ':' -and $_ -ne '.' -and $_ -ne '..' }
    for ($n = [Math]::Min(5, $parts.Count); $n -ge 3 -and -not $moved; $n--) {
      $key = ($parts[($parts.Count - $n)..($parts.Count - 1)] -join '/').ToLowerInvariant()
      if ($byTail.ContainsKey($key) -and $byTail[$key]) { $moved = $byTail[$key] }
    }
  }
  $memo[$old] = $moved
  return $moved
}

$jsonOptions = [System.Text.Json.JsonSerializerOptions]::new()
$jsonOptions.Encoder = [System.Text.Encodings.Web.JavaScriptEncoder]::UnsafeRelaxedJsonEscaping
# A JSON string that starts with a drive letter, as the stores write song paths ("C:\\Users\\...").
$pathLiteral = [regex]'"([A-Za-z]:\\\\(?:[^"\\]|\\.)*)"'

function Convert-Text([string]$text, [ref]$changed, [ref]$unmatched) {
  $script:lastChanged = 0
  $result = $pathLiteral.Replace($text, {
    param($m)
    $old = [System.Text.Json.JsonSerializer]::Deserialize[string]('"' + $m.Groups[1].Value + '"')
    $moved = Get-Moved $old
    if ($moved) { $script:lastChanged++; return [System.Text.Json.JsonSerializer]::Serialize($moved, $jsonOptions) }
    if (-not $old.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { $script:lastUnmatched++ }
    return $m.Value
  })
  return $result
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $DataDir "path-rebase-backup-$stamp"
$report = [ordered]@{}
function Save-Backup([string]$file) {
  if (-not $Apply) { return }
  $relative = $file.Substring($DataDir.Length).TrimStart('\')
  $target = Join-Path $backup $relative
  New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
  Copy-Item -LiteralPath $file -Destination $target
}
function Write-Text([string]$file, [string]$text) {
  [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding($false)))
}

# 1. Stores that hold paths inside one file.
foreach ($name in 'favorites.json', 'history.json', 'lyrics-instrumental.json', 'playlists.json', 'rerip-flags.json', 'flags.json') {
  $file = Join-Path $DataDir $name
  if (-not (Test-Path $file)) { continue }
  $script:lastUnmatched = 0
  $text = [IO.File]::ReadAllText($file)
  $new = Convert-Text $text ([ref]$null) ([ref]$null)
  $report[$name] = "$($script:lastChanged) paths moved, $($script:lastUnmatched) not found in the library"
  if ($Apply -and $new -ne $text) { Save-Backup $file; Write-Text $file $new }
}

# 2. Stores with one file per song, named by the hash of the song's path.
$keyed = @(
  @{ Name = 'lyrics-review'; Dir = Join-Path $DataDir 'lyrics-review' },
  @{ Name = 'lyric-ai\results'; Dir = Join-Path $DataDir 'lyric-ai\results' },
  @{ Name = 'lyric-ai\judged'; Dir = Join-Path $DataDir 'lyric-ai\judged' }
)
foreach ($store in $keyed) {
  if (-not (Test-Path $store.Dir)) { continue }
  $moved = 0; $same = 0; $conflict = 0; $unmatched = 0
  foreach ($file in Get-ChildItem $store.Dir -File -Filter '*.json') {
    $text = [IO.File]::ReadAllText($file.FullName)
    $path = $null
    $m = [regex]::Match($text, '"path"\s*:\s*"((?:[^"\\]|\\.)*)"')
    if ($m.Success) { $path = [System.Text.Json.JsonSerializer]::Deserialize[string]('"' + $m.Groups[1].Value + '"') }
    if (-not $path -or $path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) { $same++; continue }
    $newPath = Get-Moved $path
    if (-not $newPath) { $unmatched++; continue }
    $oldKey = $file.BaseName
    $newKey = Get-Fnv $newPath
    if ((Get-Fnv $path) -ne $oldKey) { $unmatched++; continue } # not named by its path: not ours to rename
    $target = Join-Path $store.Dir "$newKey.json"
    if (Test-Path $target) { $conflict++; continue } # the song already has a newer entry: keep that one, leave this alone
    $script:lastUnmatched = 0
    $new = Convert-Text $text ([ref]$null) ([ref]$null)
    $new = $new.Replace("`"key`": `"$oldKey`"", "`"key`": `"$newKey`"").Replace("`"key`":`"$oldKey`"", "`"key`":`"$newKey`"")
    if ($Apply) {
      Save-Backup $file.FullName
      Write-Text $target $new
      Remove-Item -LiteralPath $file.FullName
    }
    $moved++
  }
  $report[$store.Name] = "$moved moved to the new path's name, $same already fine, $conflict left (the song has a newer entry), $unmatched not matched to a library song"
}

Write-Host ""
$report.GetEnumerator() | ForEach-Object { Write-Host ("{0,-26} {1}" -f $_.Key, $_.Value) }
if ($Apply) { Write-Host "`nDone. The originals are in $backup" } else { Write-Host "`nDry run: nothing was changed. Run again with -Apply (program closed) to do it." }
