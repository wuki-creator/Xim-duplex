$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:ASR_ENGINE) {
  $taskConfigPath=Join-Path $PSScriptRoot 'private/asr.json'
  if(Test-Path -LiteralPath $taskConfigPath){
    $taskConfig=Get-Content -Raw -LiteralPath $taskConfigPath | ConvertFrom-Json
    if($taskConfig.ssh){
      try {
        $taskHealth=Invoke-RestMethod -Uri ($taskConfig.url+'/health') -TimeoutSec 3
        if($taskHealth.ready){Write-Host '语音服务已就绪。';exit 0}
      }catch{}
      & python "$PSScriptRoot/scripts/ssh_asr_tunnel.py" --host $taskConfig.ssh.host --user $taskConfig.ssh.user --ssh-port $taskConfig.ssh.ssh_port --local-port $taskConfig.ssh.local_port --remote-port $taskConfig.ssh.remote_port
      exit $LASTEXITCODE
    }
  }
}
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
