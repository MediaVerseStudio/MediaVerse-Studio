<#
.SYNOPSIS
  Builds a synthetic music library of tagged MP3 files for testing large libraries (D32, Phase B).

.DESCRIPTION
  Makes Artists x AlbumsPerArtist x TracksPerAlbum short MP3 files under -Folder, laid out as
  <Folder>\<Artist>\<Album>\NN - Title.mp3, each with an ID3v2 tag written by the project's own LAME build.
  Some tracks are deliberately imperfect so Review has something to find:
    - about 3 in 100 have single-sample clicks (the defect scan lists them at -Quality 0; at 5 the encoder smooths them away);
    - about 2 in 100 have no title tag, 1 in 100 has "Unknown Artist", 1 album in 20 has no year.
  The audio is a quiet tone with noise, not music. Nothing is copied from anywhere; the folder must not
  exist yet (the script never writes into an existing folder). Never commit the output.

.EXAMPLE
  pwsh tools\make-test-library.ps1 -Folder D:\MVS-Synthetic-5k -Artists 50 -AlbumsPerArtist 5 -TracksPerAlbum 20
#>
param(
  [Parameter(Mandatory)] [string] $Folder,
  [int] $Artists = 50,
  [int] $AlbumsPerArtist = 5,
  [int] $TracksPerAlbum = 20,
  [int] $Seconds = 4,
  # LAME VBR quality. 0 (this program's default) keeps injected clicks detectable; 5 makes smaller files but
  # smooths single-sample clicks away (measured 2026-11-03), so its 'clicks' tracks then scan clean.
  [ValidateRange(0, 9)] [int] $Quality = 0,
  [int] $Parallel = [Math]::Max(1, [Environment]::ProcessorCount - 1),
  [string] $Lame = (Join-Path $PSScriptRoot '..\third_party\build\lame-4.0\x64\Release\lame.exe')
)
$ErrorActionPreference = 'Stop'
if (Test-Path $Folder) { throw "The folder '$Folder' already exists; choose a new one." }
if (-not (Test-Path $Lame)) { throw "LAME not found at '$Lame' (build it with tools\build-lame-4.0.ps1)." }
$Lame = (Resolve-Path $Lame).Path
New-Item -ItemType Directory -Path $Folder | Out-Null
$work = Join-Path $Folder '.make-test-library'
New-Item -ItemType Directory -Path $work | Out-Null

function Write-TestWav([string] $path, [int] $seconds, [bool] $clicks) {
  $rate = 44100; $count = $rate * $seconds
  $data = New-Object byte[] ($count * 4)
  $state = [uint32] 7
  for ($i = 0; $i -lt $count; $i++) {
    $state = [uint32](($state * 1664525 + 1013904223) % 4294967296)
    $v = [int](3000 * [Math]::Sin($i / $rate * 220 * 2 * [Math]::PI) + (($state -shr 22) - 512))
    if ($clicks -and ($i % ($rate) -eq ($rate / 2))) { $v = 20000 }
    $s = [BitConverter]::GetBytes([int16]$v)
    $o = $i * 4
    $data[$o] = $s[0]; $data[$o + 1] = $s[1]; $data[$o + 2] = $s[0]; $data[$o + 3] = $s[1]
  }
  $header = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter($header)
  $w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write([int](36 + $data.Length)); $w.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
  $w.Write([int]16); $w.Write([int16]1); $w.Write([int16]2); $w.Write([int]$rate); $w.Write([int]($rate * 4)); $w.Write([int16]4); $w.Write([int16]16)
  $w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write([int]$data.Length); $w.Write($data); $w.Flush()
  [IO.File]::WriteAllBytes($path, $header.ToArray())
}

$clean = Join-Path $work 'clean.wav'
$clicky = Join-Path $work 'clicks.wav'
Write-TestWav $clean $Seconds $false
Write-TestWav $clicky $Seconds $true

# The plan: one entry per track, with its tags and whether it gets clicks.
$words = 'Red','Night','Paper','Iron','Velvet','Static','Lucky','Broken','Silver','Wild','Quiet','Neon','Hollow','Rust','Golden','Electric'
$nouns = 'Engines','Saints','Rivers','Ghosts','Radios','Wolves','Kings','Machines','Lights','Sparrows','Tigers','Echoes'
$plan = [System.Collections.Generic.List[object]]::new()
$n = 0
for ($a = 1; $a -le $Artists; $a++) {
  $artist = "{0} {1} {2:000}" -f $words[$a % $words.Count], $nouns[$a % $nouns.Count], $a
  for ($b = 1; $b -le $AlbumsPerArtist; $b++) {
    $album = "{0} {1} Vol. {2}" -f $words[($a + $b) % $words.Count], $nouns[($a * $b) % $nouns.Count], $b
    $year = if ((($a * 7 + $b) % 20) -eq 0) { $null } else { 1980 + (($a + $b) % 44) }
    for ($t = 1; $t -le $TracksPerAlbum; $t++) {
      $n++
      $title = "{0} {1} {2}" -f $words[($n * 3) % $words.Count], $nouns[($n * 5) % $nouns.Count], $t
      $plan.Add([pscustomobject]@{
        Dir = Join-Path $Folder (Join-Path ($artist -replace '[\\/:*?"<>|]', '_') ($album -replace '[\\/:*?"<>|]', '_'))
        File = ('{0:00} - {1}.mp3' -f $t, $title)
        Title = if (($n % 50) -eq 7) { '' } else { $title }
        Artist = if (($n % 100) -eq 13) { 'Unknown Artist' } else { $artist }
        Album = $album; Year = $year; Track = "$t/$TracksPerAlbum"
        Clicks = (($n % 33) -eq 5)
      })
    }
  }
}
$plan | Select-Object -ExpandProperty Dir -Unique | ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }

$started = Get-Date
$plan | ForEach-Object -ThrottleLimit $Parallel -Parallel {
  $p = $_
  $source = if ($p.Clicks) { $using:clicky } else { $using:clean }
  $arguments = @('--quiet', '-V', "$using:Quality", '--id3v2-only', '--ta', $p.Artist, '--tl', $p.Album, '--tn', $p.Track)
  if ($p.Title) { $arguments += @('--tt', $p.Title) }
  if ($p.Year) { $arguments += @('--ty', "$($p.Year)") }
  & $using:Lame @arguments $source (Join-Path $p.Dir $p.File)
  if ($LASTEXITCODE -ne 0) { throw "LAME failed for $($p.File)" }
}
Remove-Item -Recurse -Force $work
$made = ($plan | Measure-Object).Count
$clickCount = ($plan | Where-Object Clicks | Measure-Object).Count
"Made $made MP3 files ($clickCount with clicks) in {0:N0} s under $Folder" -f ((Get-Date) - $started).TotalSeconds
