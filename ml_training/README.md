# KartBlitz ML trainer

The ML Lab uses a local Python companion because a hosted browser game cannot directly execute Python or CUDA. The companion binds only to `127.0.0.1` and prints a new pairing code each time it starts.

## Setup

From PowerShell in the KartBlitz project:

```powershell
.\ml_training\install.ps1
.\ml_training\start.ps1
```

Enter the displayed URL and pairing code in **Settings → ML Lab → Train**. PyTorch selects CUDA automatically when a compatible CUDA build and NVIDIA driver are present; otherwise it uses CPU.

The installer detects `nvidia-smi` and uses PyTorch's official CUDA 12.8 wheel when an NVIDIA driver is available. Use `.\ml_training\install.ps1 -CpuOnly` to force the smaller CPU build.

You can also train without the UI:

```powershell
python -m ml_training.train --steps 150000 --envs 64
```

Training rotates through every track in `sim/tracks/bakes.json`, uses randomized starts, and exports a `.kartml.json` model. Simulator evaluation is deliberately marked separately from browser-physics validation.

## Model contract

Both Python and the browser use `kartblitz-ml-v1`: 14 track-relative observations and nine discrete actions. Coordinates and track IDs are not model inputs, allowing one policy to generalize across circuit geometry.
