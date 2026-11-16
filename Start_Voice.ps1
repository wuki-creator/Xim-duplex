$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:ASR_ENGINE) {$env:ASR_ENGINE='windows'}
if($env:ASR_ENGINE -eq 'windows') {
  $env:ASR_POWERSHELL=(Get-Process -Id $PID).Path
  python scripts/asr_worker.py
  exit $LASTEXITCODE
}
if (-not (Test-Path -LiteralPath "$PSScriptRoot/.venv-asr/Scripts/python.exe")) {
  python -m venv .venv-asr
}
& "$PSScriptRoot/.venv-asr/Scripts/python.exe" -c 'import faster_whisper' 2>$null
if ($LASTEXITCODE -ne 0) {
  & "$PSScriptRoot/.venv-asr/Scripts/python.exe" -m pip install -r requirements-asr.txt
  if($LASTEXITCODE -ne 0){throw 'ASR dependencies could not be installed'}
}
if (-not $env:ASR_MODEL -and (Test-Path -LiteralPath "$PSScriptRoot/models/faster-whisper-tiny/model.bin")) {
  $env:ASR_MODEL="$PSScriptRoot/models/faster-whisper-tiny"
}
& "$PSScriptRoot/.venv-asr/Scripts/python.exe" scripts/asr_worker.py
