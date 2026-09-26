# Builds releases\Webyar-Setup.exe: the installer people download (and the one the
# app's updater runs to move an old Program Files copy to the per-user install).
# Inside is Velopack's own setup for this version, from `vpk pack` (run that first).
param(
    [string]$Releases = 'releases',
    [string]$Dotnet = 'dotnet',
    [string]$PackId = 'WebyarWindows'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$appSetup = Join-Path (Resolve-Path $Releases).Path "$PackId-win-Setup.exe"
if (-not (Test-Path $appSetup)) { throw "$appSetup is missing: run vpk pack first" }

if (Test-Path 'setup-out') { Remove-Item 'setup-out' -Recurse -Force }
Remove-Item src\Webyar.Setup\obj -Recurse -Force -ErrorAction SilentlyContinue
& $Dotnet build src\Webyar.Setup\Webyar.Setup.csproj -c Release -o setup-out -v q -clp:NoSummary "-p:PayloadPath=$appSetup"
if ($LASTEXITCODE) { throw 'installer build failed' }

Copy-Item setup-out\Webyar-Setup.exe (Join-Path $Releases 'Webyar-Setup.exe') -Force
Get-Item (Join-Path $Releases 'Webyar-Setup.exe') | Select-Object Name, Length
