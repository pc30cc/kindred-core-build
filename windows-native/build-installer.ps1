# Builds releases\Webyar-Setup.exe (or RESPOK-Setup.exe for -Brand Respok): the installer
# people download (and the one the app's updater runs to move an old Program Files copy
# to the per-user install). Inside is Velopack's own setup for this version, from
# `vpk pack` (run that first, with the same brand's pack id).
param(
    [string]$Releases = 'releases',
    [string]$Dotnet = 'dotnet',
    # Webyar or Respok (Directory.Build.props); it names the pack and the installer.
    [ValidateSet('Webyar', 'Respok')]
    [string]$Brand = 'Webyar',
    # The release's number (the workflow passes the tag's); Directory.Build.props otherwise.
    [string]$Version = ''
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$packId = @{ Webyar = 'WebyarWindows'; Respok = 'RespokWindows' }[$Brand]
$setupName = @{ Webyar = 'Webyar-Setup'; Respok = 'RESPOK-Setup' }[$Brand]

$appSetup = Join-Path (Resolve-Path $Releases).Path "$packId-win-Setup.exe"
if (-not (Test-Path $appSetup)) { throw "$appSetup is missing: run vpk pack first" }

if (Test-Path 'setup-out') { Remove-Item 'setup-out' -Recurse -Force }
Remove-Item src\Webyar.Setup\obj -Recurse -Force -ErrorAction SilentlyContinue
$props = @("-p:PayloadPath=$appSetup", "-p:Brand=$Brand")
if ($Version) { $props += "-p:Version=$Version" }
& $Dotnet build src\Webyar.Setup\Webyar.Setup.csproj -c Release -o setup-out -v q -clp:NoSummary @props
if ($LASTEXITCODE) { throw 'installer build failed' }

Copy-Item "setup-out\$setupName.exe" (Join-Path $Releases "$setupName.exe") -Force
Get-Item (Join-Path $Releases "$setupName.exe") | Select-Object Name, Length
