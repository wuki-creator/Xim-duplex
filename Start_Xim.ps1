param([ValidateRange(1,65535)][int]$Port=8788)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath "$PSScriptRoot/node_modules/ws")) { npm.cmd ci; if($LASTEXITCODE -ne 0){throw 'Dependency installation failed'} }
$env:PORT=$Port
node server.mjs
