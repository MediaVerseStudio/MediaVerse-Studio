<#
  MediaVerse Studio uninstaller. Removes the program, its shortcuts and its entry under Settings > Apps.
  Your settings, library data, history and flags in %APPDATA%\MediaVerse Studio are kept unless you say otherwise
  (or pass -RemoveData). Your music files are never touched.
#>
param([switch]$Quiet, [switch]$RemoveData, [switch]$FromTemp, [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\MediaVerse Studio"))

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$title = "MediaVerse Studio uninstall"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# The uninstaller lives inside the folder it deletes, so it first moves to a temporary copy of itself.
if (-not $FromTemp) {
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("mediaverse-uninstall-" + [guid]::NewGuid().ToString("N").Substring(0, 8) + ".ps1")
    Copy-Item $MyInvocation.MyCommand.Path $temp
    $argumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$temp`"", "-FromTemp", "-InstallDir", "`"$InstallDir`"")
    if ($Quiet) { $argumentList += "-Quiet" }
    if ($RemoveData) { $argumentList += "-RemoveData" }
    $process = Start-Process powershell.exe -ArgumentList $argumentList -Wait -PassThru -WindowStyle Hidden
    exit $process.ExitCode
}

function Ask([string]$question, [bool]$whenQuiet = $false) {
    if ($Quiet) { return $whenQuiet }
    return [System.Windows.Forms.MessageBox]::Show($question, $title, "YesNo", "Question") -eq "Yes"
}

try {
    if (-not (Ask "Remove MediaVerse Studio from this computer?" $true)) { exit 0 }
    $wipe = $RemoveData -or (Ask "Also delete your MediaVerse Studio settings, history, flags and pins (in %APPDATA%\MediaVerse Studio)? Your music files are not affected." $false)

    Get-Process -Name "MediaVerse Studio", "mediaverse_sidecar", "mediaverse_cd_helper" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
    Start-Sleep -Milliseconds 500

    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\MediaVerse Studio.lnk")
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath("Desktop")) "MediaVerse Studio.lnk")
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MediaVerseStudio"
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    if ($wipe) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA "MediaVerse Studio") }
    # This temporary copy of the script cannot delete itself while it runs: have a helper do it a moment after we exit.
    Start-Process cmd.exe -ArgumentList "/c ping -n 3 127.0.0.1 >nul & del /f /q `"$($MyInvocation.MyCommand.Path)`"" -WindowStyle Hidden
    if (-not $Quiet) { [void][System.Windows.Forms.MessageBox]::Show("MediaVerse Studio has been removed.", $title, "OK", "Information") }
    exit 0
} catch {
    if (-not $Quiet) { [void][System.Windows.Forms.MessageBox]::Show("Removal did not finish: $($_.Exception.Message)", $title, "OK", "Error") }
    Write-Host $_.Exception.Message
    exit 1
}
