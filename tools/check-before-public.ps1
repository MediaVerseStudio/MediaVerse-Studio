[CmdletBinding()]
param(
    # Email addresses that may appear in commit metadata and files. Anything else is reported.
    [string[]]$AllowedEmails = @(),
    [string]$SettingsFile = (Join-Path $env:APPDATA "MediaVerse Studio\metadata-settings.json"),
    [string]$Git = ""
)

# Run this before making the repository public, sharing a build, or publishing source.
# It looks for personal email addresses, and for the real API keys saved in the local settings
# file, in the working tree AND in the whole git history. It never prints a key; it reports
# counts and file names only. Exit code 0 means nothing was found.
#
#   pwsh tools/check-before-public.ps1
#   pwsh tools/check-before-public.ps1 -AllowedEmails "contact@mediaverse.studio"

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root
if (-not $Git) {
    $Git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if (-not $Git) { $Git = "$env:LOCALAPPDATA\github-copilot-git-2.53.0-4\cmd\git.exe" }
}
function Run-Git { & $Git @args 2>&1 }

$findings = New-Object System.Collections.Generic.List[string]
function Finding($text) { $script:findings.Add($text); Write-Host "  [!] $text" -ForegroundColor Yellow }
function Ok($text) { Write-Host "  [ok] $text" -ForegroundColor Green }

# Addresses that are fine to publish: placeholders, GitHub no-reply addresses, and the service
# contacts the documentation names.
# Reserved test domains (RFC 2606), GitHub no-reply addresses, and made-up strings the tests use.
$builtInAllowed = @('noreply@github.com', 'info@gnudb.org', 'b@c.com', 'pass@musicbrainz.org',
    # made-up addresses in test fixtures (checked 2026-11-19: they sit in tests that exercise address and URL handling)
    'b@x.com', 'x@y.zz', 'pass@acoustid.org', 'secret@musicbrainz.org', 'pass@is1-ssl.mzstatic.com')
# Addresses on the project's own domain are meant to be public.
$allowedPattern = '(@([a-z0-9-]+\.)*example(\.[a-z]+)*$|@mediaverse\.studio$|\.invalid$|\.example$|@users\.noreply\.github\.com$|^noreply@github\.com$)'
function Is-Allowed($email) {
    $e = $email.ToLowerInvariant()
    return ($e -match $allowedPattern) -or ($builtInAllowed -contains $e) -or ($AllowedEmails | Where-Object { $_.ToLowerInvariant() -eq $e })
}

Write-Host "1. Repository visibility"
try {
    $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
    if (-not $gh) { $gh = "C:\Program Files\GitHub CLI\gh.exe" }
    $remote = (Run-Git remote get-url origin | Select-Object -First 1)
    $slug = if ($remote -match "github\.com[:/]([^/]+/[^/.]+)") { $Matches[1] } else { "" }
    $visibility = if ($slug) { (& $gh repo view $slug --json visibility --jq .visibility 2>$null) } else { "" }
    if ($visibility) { Write-Host "  The GitHub repository is currently: $visibility" } else { Write-Host "  (could not read visibility; is gh signed in?)" }
} catch { Write-Host "  (could not read visibility)" }

Write-Host "2. Email addresses in commit metadata (every branch)"
$authors = Run-Git log --all --format="%ae%n%ce" | Sort-Object -Unique | Where-Object { $_ }
$bad = @($authors | Where-Object { -not (Is-Allowed $_) })
if ($bad.Count -eq 0) { Ok "only allowed addresses appear as author or committer" }
foreach ($email in $bad) {
    $count = (Run-Git log --all --format="%h" --author="$email" | Measure-Object).Count
    Finding "commit metadata contains $email on $count commit(s). Fix: set a no-reply address with 'git config user.email', and decide whether to rewrite history (see docs/release-checklist.md)."
}

Write-Host "3. Email addresses inside tracked files"
$hits = Run-Git grep -nIEo "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" -- . ":!*.lock" ":!Cargo.lock" ":!web/app/package-lock.json"
$fileBad = @($hits | Where-Object { $_ -match '^[^:]+:\d+:(.+)$' } | ForEach-Object { $Matches[1] } | Sort-Object -Unique | Where-Object { -not (Is-Allowed $_) })
if ($fileBad.Count -eq 0) { Ok "no personal-looking addresses in tracked files" }
foreach ($email in $fileBad) { Finding "a tracked file contains the address $email" }

Write-Host "4. The real keys saved in your settings, searched for in files and history"
if (Test-Path $SettingsFile) {
    $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json
    $secrets = @($settings.acoustid.api_key, $settings.gracenote.client_id, $settings.gracenote.user_id) | Where-Object { $_ -and $_.ToString().Length -ge 6 }
    $contact = $settings.identity.contact
    if ($contact -and $contact -match '@' -and -not (Is-Allowed $contact)) { $secrets += $contact }
    if ($secrets.Count -eq 0) { Ok "no keys or contact details are saved in $SettingsFile" }
    foreach ($secret in $secrets) {
        $inFiles = (Run-Git grep -lIF -- $secret | Measure-Object).Count
        $inHistory = (Run-Git log --all --oneline -S $secret | Measure-Object).Count
        if ($inFiles -eq 0 -and $inHistory -eq 0) { Ok "a saved value ($($secret.ToString().Length) characters) is not in any file or commit" }
        else { Finding "a saved value ($($secret.ToString().Length) characters) appears in $inFiles tracked file(s) and $inHistory commit(s)" }
    }
} else {
    Write-Host "  (no settings file at $SettingsFile; nothing to compare)"
}

Write-Host "5. Files that normally hold secrets"
$risky = Run-Git ls-files | Where-Object { $_ -match '(\.pem$|\.pfx$|\.p12$|\.key$|(^|/)\.env|id_rsa|metadata-settings\.json$|(^|/)settings\.json$)' }
if (-not $risky) { Ok "none tracked" }
foreach ($file in $risky) { Finding "tracked file that may hold secrets: $file" }

Write-Host ""
if ($findings.Count -eq 0) { Write-Host "Nothing found. Also work through docs/release-checklist.md." -ForegroundColor Green; exit 0 }
Write-Host "$($findings.Count) thing(s) need attention before going public." -ForegroundColor Yellow
exit 1
