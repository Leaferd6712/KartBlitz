param([switch]$CpuOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot '.venv-official'
$pythonPath = Join-Path $environmentPath 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
  python -m venv --system-site-packages $environmentPath
  if ($LASTEXITCODE -ne 0) { throw 'Python 3.11+ is required to create the training environment.' }
}
& $pythonPath -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Could not update pip.' }
if ($CpuOnly) {
  & $pythonPath -m pip install 'torch==2.9.1+cpu' --index-url https://download.pytorch.org/whl/cpu
} else {
  & $pythonPath -m pip install 'torch==2.9.1+cu128' --index-url https://download.pytorch.org/whl/cu128
}
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
& $pythonPath -m pip install -r (Join-Path $PSScriptRoot 'official-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Official training dependencies could not be installed.' }
& $pythonPath -c "import torch; print('PyTorch:',torch.__version__); print('CUDA:',torch.cuda.is_available()); device='cuda' if torch.cuda.is_available() else 'cpu'; a=torch.randn(256,256,device=device); print('Matrix test:',float((a@a.T).mean())); print('Device:',torch.cuda.get_device_name(0) if device=='cuda' else 'CPU')"
if ($LASTEXITCODE -ne 0) { throw 'PyTorch failed its calculation check.' }
Write-Host 'Setup complete. Run .\ml_training\official-start.ps1 to open the training window.'
