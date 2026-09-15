param(
  [switch]$CpuOnly
)
$ErrorActionPreference = 'Stop'
python -m pip install --upgrade pip
if ($CpuOnly) {
  python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
  python -m pip install numpy
} elseif (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  Write-Host 'NVIDIA GPU detected. Installing the official CUDA 12.8 PyTorch wheel.'
  python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
  python -m pip install numpy
} else {
  Write-Host 'No NVIDIA driver was detected. Installing the CPU build.'
  python -m pip install -r "$PSScriptRoot\requirements.txt"
}
python -c "import torch; print('PyTorch', torch.__version__); print('CUDA available:', torch.cuda.is_available()); print('Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
