param([string]$Deadline = '2026-11-03T04:00:00+11:00')
$ErrorActionPreference = 'Stop'
$campaignRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $campaignRoot
$campaignPython = Join-Path $campaignRoot '.venv-official\Scripts\python.exe'
$campaignDirectory = Join-Path $campaignRoot 'ml_training\runs\campaign\current'
New-Item -ItemType Directory -Path $campaignDirectory -Force | Out-Null
node scripts/build-official-core.mjs
if ($LASTEXITCODE -ne 0) { throw 'Actual-game core could not be prepared.' }
$campaignTrainer = $null
try { $campaignTrainer = Invoke-RestMethod 'http://127.0.0.1:8766/api/official/status' -TimeoutSec 2 } catch {}
if (-not $campaignTrainer) {
  $trainerDirectory = Join-Path $campaignRoot 'ml_training\runs\official'
  New-Item -ItemType Directory -Path $trainerDirectory -Force | Out-Null
  $null = Start-Process -FilePath $campaignPython -ArgumentList @('-m','ml_training.server','--port','8766','--official') -WorkingDirectory $campaignRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $trainerDirectory 'trainer.log') -RedirectStandardError (Join-Path $trainerDirectory 'trainer-errors.log') -PassThru
  for ($campaignWait = 0; $campaignWait -lt 60; $campaignWait++) {
    try { $campaignTrainer = Invoke-RestMethod 'http://127.0.0.1:8766/api/official/status' -TimeoutSec 2; break } catch { Start-Sleep -Seconds 1 }
  }
}
if (-not $campaignTrainer.ready -or -not $campaignTrainer.cudaAvailable) { throw 'The local CUDA trainer is not ready.' }
[System.IO.File]::WriteAllText((Join-Path $campaignDirectory 'control.json'),'{"action":"run"}',[System.Text.UTF8Encoding]::new($false))
$campaignProcess = Start-Process -FilePath $campaignPython -ArgumentList @('-m','ml_training.campaign_guardian','--deadline',$Deadline) -WorkingDirectory $campaignRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $campaignDirectory 'guardian.log') -RedirectStandardError (Join-Path $campaignDirectory 'guardian-errors.log') -PassThru
Write-Host "Campaign supervisor PID: $($campaignProcess.Id). Deadline: $Deadline. Training stops one hour earlier."
$campaignConnection = Get-Content -LiteralPath (Join-Path $campaignRoot 'ml_training\runs\official\connection-8766.json') -Raw | ConvertFrom-Json
$campaignUrl = 'http://127.0.0.1:8766/ui/campaign.html?trainerCode=' + [uri]::EscapeDataString($campaignConnection.pairingCode)
Start-Process $campaignUrl
Write-Host 'Opened campaign dashboard. Password: KartBlitzPass. Training waits while the laptop is on battery.'
