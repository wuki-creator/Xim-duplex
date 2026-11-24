param([ValidateRange(1,65535)][int]$Port=8788, [switch]$SmallModel)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath "$PSScriptRoot/node_modules/ws")) { npm.cmd ci; if($LASTEXITCODE -ne 0){throw 'Dependency installation failed'} }
if ($SmallModel) {
  if (-not $PSBoundParameters.ContainsKey('Port')) { $Port=8790 }
  $demoPython=$env:XIM_SMALL_PYTHON
  if (-not $demoPython) {
    $venv=Join-Path $env:LOCALAPPDATA 'Xim/voice-test/venv'
    $demoPython=Join-Path $venv 'Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $demoPython)) {
      python -m venv $venv
      if ($LASTEXITCODE) { throw 'Unable to create the voice demo environment' }
    }
    & $demoPython -c "import importlib.util, sys; sys.exit(0 if all(importlib.util.find_spec(n) for n in ('ctranslate2', 'faster_whisper', 'tokenizers')) else 1)"
    if ($LASTEXITCODE) {
      & $demoPython -m pip install --disable-pip-version-check -r requirements-asr.txt 'ctranslate2>=4.6,<5' 'tokenizers>=0.21,<1'
      if ($LASTEXITCODE) { throw 'Voice model dependencies could not be installed' }
    }
  }
  & $demoPython scripts/small_voice_demo.py --port $Port
  exit $LASTEXITCODE
}
$env:PORT=$Port
node server.mjs
