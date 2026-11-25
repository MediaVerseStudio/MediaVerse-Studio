[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ArchivePath,

    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$ExpectedSha256
)

$resolvedArchive = Resolve-Path -LiteralPath $ArchivePath -ErrorAction Stop
$actualSha256 = (Get-FileHash -LiteralPath $resolvedArchive -Algorithm SHA256).Hash

if ($actualSha256 -ine $ExpectedSha256) {
    throw "SHA-256 verification failed for '$resolvedArchive'. Expected $ExpectedSha256, found $actualSha256."
}

Write-Host "Verified SHA-256 for '$resolvedArchive': $actualSha256"
