<#
.SYNOPSIS
  Builds the Android app (apps/android) with the phone's web front end, and optionally installs it.
.DESCRIPTION
  1. `npm run phone:build` in web/app (type check, then web/app/dist-phone/web).
  2. Gradle `assembleDebug` in apps/android (apps/android/app/build/outputs/apk/debug/app-debug.apk).
  3. With -Install, `adb install -r` onto the one connected phone or emulator (or -Device <serial>), then starts it.
  Needs the Android SDK (default %LOCALAPPDATA%\Android\Sdk, or ANDROID_HOME) and Java 17 or newer. See docs/android-app.md.
#>
param(
    [switch]$Install,
    [switch]$Release,
    [string]$Device = "",
    [switch]$SkipWeb
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path $sdk)) { throw "The Android SDK was not found at $sdk. See docs/android-app.md." }
$env:ANDROID_HOME = $sdk

$android = Join-Path $repo "apps\android"
$local = Join-Path $android "local.properties"
if (-not (Test-Path $local)) { Set-Content $local ("sdk.dir=" + ($sdk -replace '\\', '\\')) }

if (-not $SkipWeb) {
    Push-Location (Join-Path $repo "web\app")
    try {
        npm run phone:build
        if ($LASTEXITCODE -ne 0) { throw "The phone's web front end did not build." }
    } finally { Pop-Location }
}

if ($Release) {
    # The signing key is kept outside the repository; this reads where it is from a private file (see docs/android-app.md, "Release build").
    $props = Join-Path $env:USERPROFILE ".mediaverse\android-release.properties"
    if (-not (Test-Path $props)) { throw "No signing key: $props is missing (docs/android-app.md, 'Release build')." }
    $p = @{}; foreach ($line in Get-Content $props) { if ($line -match '^([^=]+)=(.*)$') { $p[$Matches[1]] = $Matches[2] } }
    $env:MEDIAVERSE_KEYSTORE = $p["storeFile"]; $env:MEDIAVERSE_KEYSTORE_PASSWORD = $p["storePassword"]
    $env:MEDIAVERSE_KEY_ALIAS = $p["keyAlias"]; $env:MEDIAVERSE_KEY_PASSWORD = $p["keyPassword"]
}
Push-Location $android
try {
    if ($Release) { & .\gradlew.bat assembleRelease --console=plain -q } else { & .\gradlew.bat assembleDebug --console=plain -q }
    if ($LASTEXITCODE -ne 0) { throw "The Android app did not build." }
} finally { Pop-Location }
$apk = if ($Release) { Join-Path $android "app\build\outputs\apk\release\app-release.apk" } else { Join-Path $android "app\build\outputs\apk\debug\app-debug.apk" }
Write-Host "Built $apk"

if ($Install) {
    $adb = Join-Path $sdk "platform-tools\adb.exe"
    $target = if ($Device) { @("-s", $Device) } else { @() }
    & $adb @target install -r $apk
    if ($LASTEXITCODE -ne 0) { throw "Installing failed. Is the phone connected with USB debugging on (docs/android-app.md)?" }
    & $adb @target shell am start -n studio.mediaverse.app/.MainActivity | Out-Null
    Write-Host "Installed and started."
}
