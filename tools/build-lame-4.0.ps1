[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$expectedSha256 = '3DF5124D5AD3A98312FFD7BA6A9B36230E4F8A3E66D3CE0F425E336C32D216EB'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot 'third_party\source'
$sourceDirectory = Join-Path $sourceRoot 'lame-4.0'
$buildDirectory = Join-Path $repositoryRoot 'third_party\build\lame-4.0\x64\Release'
$project = Join-Path $sourceDirectory 'vc_solution\vs2019_lame_lame.vcxproj'
$builtExecutable = Join-Path $sourceDirectory 'output\x64\Release\lame.exe'
$visualStudioDeveloperCommand = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat'

& (Join-Path $PSScriptRoot 'verify-native-source.ps1') `
    -ArchivePath $ArchivePath `
    -ExpectedSha256 $expectedSha256

if (Test-Path -LiteralPath $sourceDirectory) {
    throw "Refusing to overwrite existing source at '$sourceDirectory'. Remove it only after inspecting its contents."
}
if (-not (Test-Path -LiteralPath $visualStudioDeveloperCommand)) {
    throw "Visual Studio C++ Build Tools were not found at '$visualStudioDeveloperCommand'."
}

New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
tar -xzf $ArchivePath -C $sourceRoot

$mpg123ProjectConfiguration = Join-Path $sourceDirectory 'vc_solution\vs2019_libmpg123_config.props'
$projectText = Get-Content -LiteralPath $mpg123ProjectConfiguration -Raw
$originalWin32Condition = "Condition=`"!Exists('`$(Mpg123Path)libmpg123-0.lib') And '`$(Platform)' == 'Win32'`""
$updatedWin32Condition = "Condition=`"'`$(HaveMpg123)' == 'true' And !Exists('`$(Mpg123Path)libmpg123-0.lib') And '`$(Platform)' == 'Win32'`""
$originalX64Condition = "Condition=`"!Exists('`$(Mpg123Path)libmpg123-0.lib') And '`$(Platform)' == 'x64'`""
$updatedX64Condition = "Condition=`"'`$(HaveMpg123)' == 'true' And !Exists('`$(Mpg123Path)libmpg123-0.lib') And '`$(Platform)' == 'x64'`""

if (-not $projectText.Contains($originalWin32Condition) -or -not $projectText.Contains($originalX64Condition)) {
    throw "The expected optional mpg123 pre-link commands were not found in '$mpg123ProjectConfiguration'."
}

$projectText = $projectText.Replace($originalWin32Condition, $updatedWin32Condition)
$projectText = $projectText.Replace($originalX64Condition, $updatedX64Condition)
Set-Content -LiteralPath $mpg123ProjectConfiguration -Value $projectText -NoNewline

$buildCommand = "call `"$visualStudioDeveloperCommand`" -arch=x64 -host_arch=x64 >nul && cd /d `"$repositoryRoot`" && msbuild `"$project`" /m /t:Build `"/p:Configuration=Release;Platform=x64;PlatformToolset=v145`" /v:minimal"
& $env:ComSpec /c $buildCommand
if ($LASTEXITCODE -ne 0) {
    throw "LAME 4.0 x64 Release build failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $builtExecutable)) {
    throw "LAME build completed without producing '$builtExecutable'."
}

New-Item -ItemType Directory -Force -Path $buildDirectory | Out-Null
$artifact = Join-Path $buildDirectory 'lame.exe'
Copy-Item -LiteralPath $builtExecutable -Destination $artifact -Force
& $artifact --version
if ($LASTEXITCODE -ne 0) {
    throw "The built LAME executable did not report its version successfully."
}

$artifactHash = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
Write-Host "Built LAME 4.0 x64 encoder: $artifact"
Write-Host "SHA-256: $artifactHash"
