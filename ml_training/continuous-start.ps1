$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$pythonPath = Join-Path $projectRoot '.venv-official\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Run npm run official:install first.' }
node --input-type=module -e "import {buildOfficialCore} from './scripts/build-official-core.mjs'; buildOfficialCore({checkOnly:true});"
if ($LASTEXITCODE -ne 0) { throw 'Actual-game physics build failed.' }
$runDirectory = Join-Path $projectRoot 'ml_training\runs\continuous-v2\current'
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
try { $trainer = Invoke-RestMethod 'http://127.0.0.1:8766/api/official/status' -TimeoutSec 2 } catch { $trainer = $null }
if (-not $trainer) {
  Start-Process -FilePath $pythonPath -ArgumentList @('-m','ml_training.server','--port','8766') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runDirectory 'trainer.log') -RedirectStandardError (Join-Path $runDirectory 'trainer-errors.log') | Out-Null
  for ($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try { $trainer = Invoke-RestMethod 'http://127.0.0.1:8766/api/official/status' -TimeoutSec 2; break } catch {}
  }
  if (-not $trainer) { throw 'Trainer did not start; inspect continuous-v2/current/trainer-errors.log.' }
}
if (-not $trainer.ready -or -not $trainer.cudaAvailable) { throw 'The local CUDA trainer is not ready.' }
$ownerPath = Join-Path $runDirectory 'state.json'
$running = $false
if (Test-Path -LiteralPath $ownerPath) {
  $campaignState = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
  if ($campaignState.owner.pid) {
    try { $existing = Get-Process -Id $campaignState.owner.pid -ErrorAction Stop; $epoch = [DateTimeOffset]$existing.StartTime; $running = [Math]::Abs($epoch.ToUnixTimeMilliseconds()/1000 - $campaignState.owner.created) -lt 0.2 } catch {}
  }
}
if (-not $running) {
  @{action='run'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory 'control.json') -Encoding Ascii
  $manager = Start-Process -FilePath $pythonPath -ArgumentList @('-m','ml_training.continuous_campaign') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runDirectory 'manager.log') -RedirectStandardError (Join-Path $runDirectory 'manager-errors.log') -PassThru
  Write-Host "Continuous campaign starting, PID $($manager.Id). No chat/API credits used by local training."
}
$connection = Get-Content -LiteralPath (Join-Path $projectRoot 'ml_training\runs\official\connection-8766.json') -Raw | ConvertFrom-Json
$windowUrl = 'http://127.0.0.1:8766/ui/continuous-training.html?trainerCode=' + [uri]::EscapeDataString($connection.pairingCode)
Start-Process $windowUrl
Write-Host 'Password: KartBlitzPass. Use Save and pause or Stop and save on the dashboard.'
