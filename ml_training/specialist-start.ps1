$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$pythonPath = Join-Path $projectRoot '.venv-official\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Run npm run official:install first.' }
node --input-type=module -e "import {buildOfficialCore} from './scripts/build-official-core.mjs'; buildOfficialCore({checkOnly:true});"
if ($LASTEXITCODE -ne 0) { throw 'Actual-game physics check failed.' }
$runDirectory = Join-Path $projectRoot 'ml_training\runs\specialists-v3\current'
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
try { $trainer = Invoke-RestMethod 'http://127.0.0.1:8766/api/official/status' -TimeoutSec 2 } catch { $trainer = $null }
if (-not $trainer) {
  Start-Process -FilePath $pythonPath -ArgumentList @('-m','ml_training.server','--official','--port','8766') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runDirectory 'trainer.log') -RedirectStandardError (Join-Path $runDirectory 'trainer-errors.log') | Out-Null
  for ($attempt=0; $attempt -lt 30; $attempt++) { Start-Sleep -Seconds 1; try { $trainer = Invoke-RestMethod 'http://127.0.0.1:8766/api/official/status' -TimeoutSec 2; break } catch {} }
}
if (-not $trainer.ready -or -not $trainer.cudaAvailable) { throw 'Local CUDA trainer is not ready.' }
$ownerPath = Join-Path $runDirectory 'state.json'
$running = $false
if (Test-Path -LiteralPath $ownerPath) {
  $savedState = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
  if ($savedState.owner.pid) { try { $process = Get-Process -Id $savedState.owner.pid -ErrorAction Stop; $stamp = [DateTimeOffset]$process.StartTime; $running = [Math]::Abs($stamp.ToUnixTimeMilliseconds()/1000 - $savedState.owner.created) -lt 0.2 } catch {} }
}
if (-not $running) {
  @{action='run'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory 'control.json') -Encoding Ascii
  Start-Process -FilePath $pythonPath -ArgumentList @('-m','ml_training.specialist_campaign','--slots','5') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runDirectory 'manager.log') -RedirectStandardError (Join-Path $runDirectory 'manager-errors.log') | Out-Null
}
$connection = Get-Content -LiteralPath (Join-Path $projectRoot 'ml_training\runs\official\connection-8766.json') -Raw | ConvertFrom-Json
Start-Process ('http://127.0.0.1:8766/ui/specialist-training.html?trainerCode=' + [uri]::EscapeDataString($connection.pairingCode))
Write-Host 'V3 pilot starts first. Password: KartBlitzPass. Models install only after both specialists qualify.'
