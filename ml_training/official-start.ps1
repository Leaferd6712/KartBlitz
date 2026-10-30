$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot '.venv-official\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Run .\ml_training\official-install.ps1 first.' }
Set-Location -LiteralPath $projectRoot
node scripts/build-official-core.mjs
if ($LASTEXITCODE -ne 0) { throw 'Could not build the actual-game training core. Run npm install first.' }
try {
  $existingTrainer = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/api/official/status' -TimeoutSec 2
} catch { $existingTrainer = $null }
if ($existingTrainer) {
  $windowUrl = 'http://127.0.0.1:8766/index.html?tool=official-ml'
  $connectionPath = Join-Path $projectRoot 'ml_training\runs\official\connection-8766.json'
  if (Test-Path -LiteralPath $connectionPath) {
    $connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
    if ($connection.port -eq 8766 -and $connection.pairingCode) { $windowUrl += '&trainerCode=' + [uri]::EscapeDataString($connection.pairingCode) }
  }
  Start-Process $windowUrl
  Write-Host 'Opened the existing trainer window.'
  exit
}
$runDirectory = Join-Path $projectRoot 'ml_training\runs\official'
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
$trainerProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-m','ml_training.server','--port','8766','--open-official') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runDirectory 'trainer.log') -RedirectStandardError (Join-Path $runDirectory 'trainer-errors.log') -PassThru
Write-Host "Training window is opening. Background trainer PID: $($trainerProcess.Id)."
Write-Host 'Password: KartBlitzPass. Use the window to monitor progress and stop training.'
