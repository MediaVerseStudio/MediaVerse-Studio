<#
  MediaVerse Studio installer (per user: needs no administrator rights).
  Copies the program to %LOCALAPPDATA%\Programs\MediaVerse Studio, adds a Start menu shortcut (and, if you
  agree, a desktop shortcut), and lists the program under Settings > Apps so Windows can uninstall it.
  Your settings, library data, history and flags live in %APPDATA%\MediaVerse Studio and are not touched.
#>
param([switch]$Quiet, [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\MediaVerse Studio"))

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Windows.Forms
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here "app"
$title = "MediaVerse Studio setup"
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\MediaVerse Studio.lnk"
$desktop = Join-Path ([Environment]::GetFolderPath("Desktop")) "MediaVerse Studio.lnk"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MediaVerseStudio"

function Ask([string]$question) {
    if ($Quiet) { return $false }
    return [System.Windows.Forms.MessageBox]::Show($question, $title, "YesNo", "Question") -eq "Yes"
}
function Tell([string]$message, [string]$icon = "Information") {
    if (-not $Quiet) { [void][System.Windows.Forms.MessageBox]::Show($message, $title, "OK", $icon) }
    Write-Host $message
}
function IconFor([string]$target, [string]$dir) {
    # The program's own icon (D86); the .exe itself still carries Electron's.
    $ico = Join-Path $dir "resources\app\electron\icon.ico"
    if (Test-Path $ico) { return $ico }
    return $target
}
function Shortcut([string]$path, [string]$target, [string]$dir) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $target
    $link.WorkingDirectory = $dir
    $link.IconLocation = "$(IconFor $target $dir),0"
    $link.Description = "MediaVerse Studio"
    $link.Save()
}

try {
    if (-not (Test-Path (Join-Path $source "MediaVerse Studio.exe"))) { throw "The installer is incomplete: the program files are missing." }

    $running = Get-Process -Name "MediaVerse Studio" -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) }
    if ($running) { throw "MediaVerse Studio is running. Close it, then run the installer again." }

    # A small window shows that something is happening while the files are unpacked.
    $form = $null
    if (-not $Quiet) {
        $form = New-Object System.Windows.Forms.Form
        $form.Text = $title; $form.Width = 420; $form.Height = 130; $form.StartPosition = "CenterScreen"; $form.FormBorderStyle = "FixedDialog"; $form.ControlBox = $false
        $label = New-Object System.Windows.Forms.Label; $label.Text = "Installing MediaVerse Studio..."; $label.Left = 20; $label.Top = 15; $label.Width = 360
        $bar = New-Object System.Windows.Forms.ProgressBar; $bar.Style = "Marquee"; $bar.Left = 20; $bar.Top = 45; $bar.Width = 360
        $form.Controls.AddRange(@($label, $bar)); $form.Show(); [System.Windows.Forms.Application]::DoEvents()
    }

    $staging = "$InstallDir.new"
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
    New-Item -ItemType Directory -Force (Split-Path $InstallDir -Parent) | Out-Null
    # robocopy copies the files; exit codes below 8 mean success.
    $job = Start-Job { param($s, $d) & robocopy.exe $s $d /E /NFL /NDL /NJH /NJS /NP | Out-Null; $LASTEXITCODE } -ArgumentList $source, $staging
    while ($job.State -eq "Running") { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
    $copyCode = Receive-Job $job | Select-Object -Last 1
    Remove-Job $job
    if ($null -eq $copyCode -or [int]$copyCode -ge 8) { throw "The program files could not be copied (code $copyCode). Is the disk full?" }

    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    Rename-Item $staging (Split-Path $InstallDir -Leaf)
    Copy-Item (Join-Path $here "uninstall.ps1") (Join-Path $InstallDir "uninstall.ps1") -Force

    $exe = Join-Path $InstallDir "MediaVerse Studio.exe"
    if (-not (Test-Path $exe)) { throw "The program was not unpacked correctly." }
    New-Item -ItemType Directory -Force (Split-Path $startMenu -Parent) | Out-Null
    Shortcut $startMenu $exe $InstallDir

    $version = "0.9.0"
    $packageFile = Join-Path $InstallDir "resources\app\package.json"
    if (Test-Path $packageFile) { $version = (Get-Content $packageFile -Raw | ConvertFrom-Json).version }
    $size = [int]((Get-ChildItem $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
    New-Item -Path $uninstallKey -Force | Out-Null
    $values = @{
        DisplayName = "MediaVerse Studio"; DisplayVersion = $version; Publisher = "MediaVerse Studio"; InstallLocation = $InstallDir
        DisplayIcon = (IconFor $exe $InstallDir); UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
        QuietUninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`" -Quiet"
    }
    foreach ($name in $values.Keys) { New-ItemProperty -Path $uninstallKey -Name $name -Value $values[$name] -PropertyType String -Force | Out-Null }
    New-ItemProperty -Path $uninstallKey -Name EstimatedSize -Value $size -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $uninstallKey -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null

    if ($form) { $form.Close() }
    if (Ask "Add a shortcut to the desktop?") { Shortcut $desktop $exe $InstallDir }
    Tell "MediaVerse Studio is installed. Find it in the Start menu."
    if (Ask "Start MediaVerse Studio now?") { Start-Process $exe -WorkingDirectory $InstallDir }
    exit 0
} catch {
    if ($form) { $form.Close() }
    Tell "The installation did not finish: $($_.Exception.Message)" "Error"
    exit 1
}
