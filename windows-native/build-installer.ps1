# Builds releases\Webyar-Setup.exe from the published app (dotnet publish -o publish).
#   1. zip the published app: the payload the installer unpacks into Program Files
#   2. build the installer once without a payload: "Uninstall Webyar.exe"
#   3. build it again with the payload and that uninstaller inside
param(
    [string]$Publish = 'publish',
    [string]$Releases = 'releases',
    [string]$Dotnet = 'dotnet'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Add-Type -AssemblyName System.IO.Compression.FileSystem

$payload = Join-Path $PSScriptRoot 'setup-payload.zip'
if (Test-Path $payload) { Remove-Item $payload -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory((Resolve-Path $Publish).Path, $payload, [System.IO.Compression.CompressionLevel]::Optimal, $false)

foreach ($dir in 'setup-uninstaller', 'setup-out') { if (Test-Path $dir) { Remove-Item $dir -Recurse -Force } }
& $Dotnet build src\Webyar.Setup\Webyar.Setup.csproj -c Release -o setup-uninstaller -v q -clp:NoSummary
if ($LASTEXITCODE) { throw 'uninstaller build failed' }
# Two builds of one project: the second must not reuse the first's intermediate output.
Remove-Item src\Webyar.Setup\obj -Recurse -Force -ErrorAction SilentlyContinue
& $Dotnet build src\Webyar.Setup\Webyar.Setup.csproj -c Release -o setup-out -v q -clp:NoSummary "-p:PayloadPath=$payload" "-p:UninstallerPath=$(Resolve-Path setup-uninstaller\Webyar-Setup.exe)"
if ($LASTEXITCODE) { throw 'installer build failed' }

New-Item -ItemType Directory -Force $Releases | Out-Null
Copy-Item setup-out\Webyar-Setup.exe (Join-Path $Releases 'Webyar-Setup.exe') -Force
Remove-Item $payload -Force
Get-Item (Join-Path $Releases 'Webyar-Setup.exe') | Select-Object Name, Length
