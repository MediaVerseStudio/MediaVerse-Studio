<#
.SYNOPSIS
  Builds the Jellyfin plugin (apps/jellyfin-plugin) and a plugin repository for installing it.
.DESCRIPTION
  Writes into apps/jellyfin-plugin/dist: the plugin's zip and manifest.json, the list a Jellyfin server reads when
  this folder's web address is added under Dashboard > Plugins > Repositories. -BaseUrl is that address (where the
  two files will be served from). Needs the .NET 10 SDK. The plugin works only with the Jellyfin version it was
  built for ($TargetAbi below, matching the package versions in the project file).
#>
param(
    [string]$BaseUrl = "http://localhost:18097",
    [string]$Changelog = "Test version: profiles, problem tracks, new music."
)
$ErrorActionPreference = "Stop"
$TargetAbi = "12.4.0.0"
$repo = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $repo "apps\jellyfin-plugin"
$project = Join-Path $plugin "MediaVerse.Jellyfin\MediaVerse.Jellyfin.csproj"
$out = Join-Path $plugin "dist"
$version = ([xml](Get-Content $project)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1

$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:DOTNET_NOLOGO = "1"
dotnet build $project -c Release
if ($LASTEXITCODE -ne 0) { throw "The plugin did not build." }

New-Item -ItemType Directory -Force $out | Out-Null
$zip = Join-Path $out "mediaverse-sync_$version.zip"
$dll = Join-Path $plugin "MediaVerse.Jellyfin\bin\Release\net10.0\MediaVerse.Jellyfin.dll"
Compress-Archive -Path $dll -DestinationPath $zip -Force

$manifest = @(
    [ordered]@{
        guid        = "7c2b6f0e-3d1a-4f7e-9a57-2f4a1c9d8e31"
        name        = "MediaVerse Sync"
        description = "Profiles without extra Jellyfin users, a shared list of problem tracks and a place for new music, for MediaVerse Studio."
        overview    = "Keeps MediaVerse Studio's apps in step through your server."
        owner       = "MediaVerse Studio"
        category    = "General"
        versions    = @(
            [ordered]@{
                version   = "$version"
                changelog = $Changelog
                targetAbi = $TargetAbi
                sourceUrl = "$($BaseUrl.TrimEnd('/'))/$(Split-Path -Leaf $zip)"
                # Jellyfin checks downloads against an MD5 sum.
                checksum  = (Get-FileHash $zip -Algorithm MD5).Hash.ToLowerInvariant()
                timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            }
        )
    }
)
ConvertTo-Json -InputObject $manifest -Depth 6 | Set-Content (Join-Path $out "manifest.json")
Write-Host "Done: $zip"
Write-Host "Repository list: $(Join-Path $out 'manifest.json') (serve both files at $BaseUrl)"
