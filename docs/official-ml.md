# Official ML for AI

This is the actual-game trainer for **AI Race and One Lap Shootout only**. The existing ML Lab remains separate. Start locally from the KartBlitz project:

```powershell
npm run official:install
npm run official:start
```

Installation creates `.venv-official`, installs CUDA-enabled PyTorch and the pinned training libraries. It does not replace system Python. Setup needs Python 3.11+ and Node/npm with this project's dependencies installed. The CUDA download is several GB. On the current laptop setup has already been run and CUDA arithmetic verified on the RTX 5070 Laptop GPU (8 GB).

The start command opens a browser window and runs the trainer in the background, bound to `127.0.0.1:8766`. Enter **KartBlitzPass**. The password is deliberately hardcoded in `index.html`; this is a light screen gate. A separate local trainer pairing code is filled automatically by the launcher. A closed window leaves training running. Reopen with the start command; use **Stop and save** before shutting down the trainer.

Direct screen URL: `index.html?tool=official-ml`. Use **Open separate window** for a dedicated view. Live data is sampled from one selectable worker batch; its camera plays a short real trajectory clip at readable speed while the other environments run freely. It uses the existing game renderer. Parallel cars are independent simulations feeding one PPO learner, rather than cars sharing one unsafe learning update.

Cold startup and policy initialization on Windows can take tens of seconds. The window reports loading libraries, preparing physics, starting workers and initializing the policy before driving begins. The local pairing code is remembered in this browser so the window can reconnect after closing a tab.

## Your first training session

1. Run **Benchmark CPU / GPU**. Use its measured device choice. Small PPO networks sometimes suit CPU execution better than GPU. A short local check with 16 environments/four workers measured about 2,620 steps/sec on CPU and 980 on CUDA; longer runs and other settings can differ.
2. Choose one track, **Extreme first**, **0 opponents**, 16 parallel cars and 4 workers. One million steps is an initial experiment; useful driving may take substantially more. Start training and keep the job ID.
3. Watch track completion and frozen-policy evaluation. Inspect paths and replay groups. Early success means reliable completed laps; reward alone does not establish fast or fair racing.
4. Resume using the earlier job ID for more steps. Add 1–3 opponents after the solo policy can drive. With **All five**, Extreme receives half the per-track budget and the four other policies receive one eighth each, initialized from Extreme. Difficulty pace targets and rewards are starting hypotheses to tune through races.
5. Open **AI Models** from the training window, or visit `ui/ai-models.html`. Completed runs arrive as inactive candidates. Inspect the evaluation and click **Use this model** only when you want to try it. **Use Current AI** switches back for future races while keeping the candidates. Packages can include one difficulty during experimentation, or all five. Missing or incompatible track/difficulty weights use Current AI.

## AI Models and manual activation

The separate HTML entry is `ui/ai-models.html` (password `KartBlitzPass`). It loads the actual game and shows its built-in Current AI driving function under **Inspect the actual Current AI driving algorithm**. The scripted controller remains part of the game; training cannot overwrite or delete it.

The updated training window remembers job IDs and copies completed/stopped packages into the separate candidate library in IndexedDB. The models page can watch these runs even when the training window is closed. New trainer processes also expose a paired, read-only catalog of saved run files, allowing discovery after a trainer restart. An already-running older trainer keeps working through its existing job endpoints; use **Watch this run** with its job ID if it was started before this update. No training process needs to be interrupted to use that fallback.

Candidate arrival never changes the installed track weights or the selected driver. **Use this model** is the manual activation step: it archives any previously installed package, installs the chosen track package and selects Trained AI for AI Race/One Lap Shootout. Switching back to Current AI retains all weights and versions. Existing races keep their current controller; the choice applies to new races.

The library and driver choices belong to the browser origin. To transfer a local model to the GitHub-hosted game, download the candidate and import it into AI Models on that hosted site, then activate it manually there. This does not change the global default for other players or publish trained files to GitHub. An incompatible model may be retained/downloaded, but activation is disabled.

Training conditions currently use dry weather and medium tyres, with variation in observable vehicle dynamics. Policy observations include dynamics, tyre state and energy state, but that alone does not establish support for every upgrade or wet-weather setup. Test those conditions before enabling a policy there. The pit strategy remains game orchestration; the policy controls driving. The defensive lane constraint allows one lane move per sustained attacking encounter and runs during both training and gameplay. It is a baseline constraint, requiring race testing rather than a claim of complete F1 rules enforcement.

## What you can do to help make good weights

- Choose the first track and record several clean, fast offline player laps. Supply the full owner archive JSON files if you want optional imitation initialization. Online recordings with different geometry and public compact/legacy replays do not match this offline environment's required state/geometry.
- Give us your clean human lap benchmark and settings (mode, tyres, weather, upgrades). Compare trained laps in the actual game under those same settings; training evaluation times include randomized starts and are diagnostics, not leaderboard or WR claims.
- Let a longer run finish on a powered, ventilated laptop. Report completion rate, lap times, repeated failure sections and contact patterns, together with the job ID. These determine the next reward/observation experiment.

Imitation is an optional actor warm-start from compatible same-track observation/control samples. PPO then learns independently; imitation is not an ongoing objective forcing it to copy slower human actions. Recordings are sampled and do not make a perfect expert dataset automatically. Compare a run with and without imitation before deciding whether it helps this game.

## Saved data and playback

Runs live in `ml_training/runs/official/<job-id>/` (ignored by Git):

- `attempts.jsonl.gz`: every completed/failed attempt, its mode, difficulty, attempt number, policy step/update, completion, contact and off-track metrics. Each 20 Hz point includes timestamp, pose, speed, spline-position index, normalized progress, checkpoint, raw and applied action, accumulated reward, reward components and tyre/ERS state. These are actual trajectories; playback follows the saved poses without requiring deterministic resimulation.
- `track-N/track.json`: finalized geometry and position index for joining telemetry by track/section.
- `attempt-index.jsonl`: attempt outcomes, lap times and byte offsets into independent gzip members. Replay loading reads selected attempts without decoding a whole long run or blocking training collectors.
- `track-N/<difficulty>/last.zip`: resumable PPO state including optimizer. `best.zip`: best frozen evaluation checkpoint. `contract.json`: compatible physics and settings. Only load locally generated checkpoints through Resume; browser imports use validated JSON numerical weights.
- `track-N/<difficulty>/evaluations.jsonl`: frozen evaluation metrics and complete trajectories for comparing checkpoints and finding fast completed evaluation laps.
- `track-N.kartai.json`: browser-ready track package with learned actors and evaluation results. Physics/control and track geometry checks reject incompatible imports or usage.

The replay selector overlays up to 1,000 saved attempts: the first 1,000, attempts 3,001–4,000, or the latest 1,000. The paths are cached for drawing, cars move along recorded timestamps, and one selected attempt uses the game camera. A group is empty until enough attempts exist. These are attempt ranges, not PPO training iterations. Replay data remains associated with its run; keep the folder for future analysis.

Job status is held in the running trainer's memory. **Watch run** reconnects within that trainer session. Checkpoints and recordings persist after shutdown; a new training job can resume an earlier on-disk job ID. Download model JSON before transferring to another computer, and retain run folders for analysis. Stopping saves at a training callback boundary; the archive contains completed attempts, not unfinished fragments.

## Implementation and checks

`official-worker.mjs` runs a generated copy of the actual offline Kart, track finalization and helpers. Visual/audio effects and leaderboard writes are stubbed. Python's vector environment coordinates Node CPU workers; SB3 PPO trains a 48-input, two-layer 128-unit actor with five controls at 20 Hz over fixed 60 Hz physics. Progress, off-track, contact, smoothness, time and difficulty pace terms form the initial reward. Off-track positive progress is not rewarded. All checkpoints must be crossed in order before a completed-lap reward.

`npm run official:core` regenerates physics and its compatibility hash. Packaging and training regenerate it automatically. Browser tests compare actual and headless Kart physics across all eight tracks and both modes. Python tests train five tiny policies, resume a saved optimizer, check terminal observations and compare exported JavaScript actor outputs with PyTorch. These are pipeline tests, not proof of useful driving.

```powershell
npm run test:official
npx playwright test e2e/official-ml.spec.js
```

The pinned Torch 2.9 Windows/SB3 combination exposes a nested ZIP tensor reading problem. Our checkpoint writer uses PyTorch's supported legacy tensor container inside SB3's normal ZIP, keeping its `weights_only=True` tensor loading. Checkpoint round-trip and resume are tested.

See [five-project research and tradeoffs](official-ml-research.md). PPO is a baseline; SAC/TD3 remain worthwhile comparisons if learning stalls. Nothing here guarantees human or WR pace, and the short validation models are deliberately not installed into normal gameplay.
