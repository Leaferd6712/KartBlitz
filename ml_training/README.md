# KartBlitz ML trainer

ML Lab trains outside the browser because Python, PyTorch and CUDA cannot run directly in the hosted game. The companion server listens only on `127.0.0.1` and prints a fresh pairing code when it starts.

## What is actually trained

- A 24-input, 128 x 128 neural actor produces continuous steering, throttle and braking.
- Exactly 10% of each preset's budget is an imitation warm-start from a built-in conservative teacher and optional laps recorded in ML Lab.
- The remaining 90% is PPO reinforcement learning. The policy drives, receives rewards and improves through trial and error; imitation does not continue during this phase.
- A curriculum begins with two tracks and mild starts, adds four tracks, then uses every track with randomized grip, power, braking and steering.
- Evaluation runs five randomized episodes on every track. It reports finish rate, median lap time, mean speed, off-track rate and failed recovery rate.
- Warm-start, halfway and final trajectories are embedded in the exported model. The Watch screen never fabricates learning footage.

## How ML Lab teaches

The course uses short experiments instead of reveal-first explanations. In **Learn**, predict steering and pedals from visible sensor values, then commit to reveal the reasoning. In **Build**, change one driving condition or reward weight and watch its exact positive or negative contribution. In **Train**, `READ THIS` sections explain the ideas while numbered `DO NOW` sections identify real actions. Copyable PowerShell boxes set up the GPU laptop. The run summary shows the exact 10% imitation and 90% PPO counts, then translates environment count and rollout horizon into the experience processed per update.

## Setup on the training computer

From PowerShell in the extracted KartBlitz trainer pack, run the first command once. Run the second command at the start of every training session:

```powershell
.\ml_training\install.ps1
.\ml_training\start.ps1
```

Enter the displayed URL and pairing code in **ML Lab -> Train**. PyTorch selects CUDA when a compatible NVIDIA installation is available; otherwise training uses CPU.

## Command-line training

```powershell
python -m ml_training.train --steps 3000000 --envs 48
```

`--steps` is the total learning budget. For `3000000`, the trainer uses 300,000 imitation samples (10%) and 2,700,000 PPO experience steps (90%).

To add human demonstrations exported from the game:

```powershell
python -m ml_training.train --steps 3000000 --envs 48 --demo kartblitz-human-demonstrations.json
```

The default output is `ml_training/runs/player-model.kartml.json`. Import that file from **ML Lab -> Race -> Your Model**.

## Model contract

Exported v2 models use the `kartblitz-ml-v1` file format with `observationVersion: 2`, 24 normalized track-relative observations and `continuous-3-v2` controls. Older v1 nine-action models remain importable for compatibility.

## Honest validation

The Python environment is a fast approximation of KartBlitz physics, not the browser engine itself. `simulation-qualified` means the model cleared stringent randomized simulator tests. It does not mean human-level. Establish that separately by running the exported model in real KartBlitz races on every circuit and comparing median lap times against several human laps.
