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

New training and evaluation attempts start **from rest, 30 game units behind the actual painted start/finish gate**, facing forwards. There are no randomized positions, headings or initial speeds. The first S/F crossing starts the game's lap clock; a finish requires the game's ordered intermediate checkpoints followed by a return to S/F. Distance travelled alone cannot finish an attempt. Parallel environments are independent, so their cars share the same starting location without colliding with one another. Optional traffic cars start on deterministic rows behind the learner.

The actual game Kart applies its grass slowdown, stricter off-track speed bleed and corner-cut speed penalty. Training also checks every 60 Hz physics tick: any off-track/strict-limit tick incurs a negative reward and receives no positive forward-progress reward. Even a short excursion that returns before the end of a 50 ms action is counted. A lap invalidated under the game's existing track-limit rules does not receive the valid-finish bonus.

These reset/reward rules are now environment version 3. Reverse remains available for recovery, but cannot earn positive racing-progress reward. Fresh policies begin with a forward throttle/no-brake bias and initial action standard deviation of approximately 0.61, rather than neutral outputs that apply half brake and engage reverse at rest. Steering and all controls still learn through PPO; this is initialization, not a scripted driver. Benchmark and training use the same initialization. Resumed policies retain their existing weights and exploration state.

Restart the local trainer and start a fresh run to use the new initialization; existing recordings retain their original starts. Older checkpoints can initialize new training, but their earlier evaluation scores are not reused as comparable best scores. The actual game's AI Race grid and Shootout's longer flying-lap lead-in remain unchanged; training uses the requested standing S/F setup in both modes, so assess final pace in the actual game before comparing human times.

**Stop and save** freezes the visible preview immediately, requests cancellation and then waits for the trainer's final status. A completed/cancelled job keeps its last frame stationary. If the connection fails, the preview also freezes and the page explicitly says the stop is unconfirmed; reconnect to verify the actual job. Closing the tab alone does not send a stop request. Recorded replay playback is separate and can be started manually after training ends. A finished CPU/GPU benchmark is labeled as a benchmark and does not generate racing weights.

Evaluation also checks pause/stop at every driving decision. Interrupted evaluations never replace the best completed evaluation. If stopped before any complete test, the candidate is labeled as having an incomplete evaluation and only `last.zip` is guaranteed. On resume, a saved best policy is tested again under the new run's conditions (including opponents); an old solo score cannot silently become the racecraft baseline. Non-finite observations, actions or rewards stop training with an explicit error.

Before policies can finish laps, best-checkpoint selection prioritizes completion rate and progress, then cleanliness. A clean car that barely moves must not outrank one reaching the later corners. Once evaluation completes every lap, selection favours clean driving followed by lap time. Off-track/contact penalties remain part of training throughout. Progress-only status messages preserve the current step count during evaluation and diagnostics.

## Your first training session

1. Run **Benchmark CPU / GPU**. It warms up and measures real PPO collection and updates at 16, 64 and 128 cars on each available device. It applies the fastest configuration for the selected device preference when calibration finishes; **Auto** chooses the fastest overall. This measures compute throughput, not driving quality.
2. Choose one track, **Extreme first**, **0 opponents**. GPU throughput defaults are **128 parallel cars, 8 CPU workers, NVIDIA CUDA, 128 rollout steps per car and a 2,048-sample minibatch**. Workers are capped against the available CPU count. One million steps is an initial experiment; useful driving may take substantially more. Start training and keep the job ID.
3. Watch track completion and frozen-policy evaluation. Inspect paths and replay groups. Early success means reliable completed laps; reward alone does not establish fast or fair racing.
4. Resume using the earlier job ID for more steps. Add 1–3 opponents after the solo policy can drive. With **All five**, Extreme receives half the per-track budget and the four other policies receive one eighth each, initialized from Extreme. Difficulty pace targets and rewards are starting hypotheses to tune through races.
5. Open **AI Models** from the training window, or visit `ui/ai-models.html`. Completed runs arrive as inactive candidates. Inspect the evaluation and click **Use this model** only when you want to try it. **Use Current AI** switches back for future races while keeping the candidates. Packages can include one difficulty during experimentation, or all five. Missing or incompatible track/difficulty weights use Current AI.

## GPU workload and measurements

The page shows measured steps/sec, time collecting experience (including archive writes and evaluation checks), weight-update time, whole-device GPU utilization/VRAM, and PyTorch tensor/reserved/peak memory. Whole-device readings include other applications and can miss short spikes. Missing telemetry is shown as unavailable. A completed job shows its last sample, rather than claiming live usage.

On this RTX 5070 Laptop/i7-14650HX, short warmed-up compute calibration measured roughly **2,200 steps/sec at 16 cars on CUDA versus 8,900 at 128**. CPU at 128 was effectively tied at 9,000. A separate 131,072-step run with full attempt recording measured approximately **3,000 steps/sec for the previous 16-car CPU defaults versus 5,200 for the new CUDA configuration**. These are local short-run measurements, not sustained performance guarantees. Calibration is saved in `ml_training/runs/official/hardware-profile.json`.

These workloads used about **0.9 GiB whole-device VRAM**, not 7 GiB, and did not sustain 85% GPU utilization. The small numerical policy and CPU physics/serialization are the limiting workload; reserving unused GPU memory would not accelerate training. SB3 itself [warns about GPU use for small PPO MLP policies](https://github.com/DLR-RM/stable-baselines3/blob/master/stable_baselines3/common/on_policy_algorithm.py). PyTorch distinguishes [tensor allocation from cached/reserved GPU memory](https://docs.pytorch.org/docs/stable/notes/cuda.html#memory-management).

A rollout is the experience collected before a PPO update; a minibatch is the chunk used for each gradient step. With these defaults a rollout contains 16,384 samples. Bigger batches change learning behaviour as well as throughput: in the short learning comparison neither policy completed a lap, and the larger configuration initially had lower progress and more off-track driving. The defaults are a throughput starting point, not a validated improvement in lap quality. Compare completion and lap times over longer runs; lower the minibatch toward 256 or reduce rollout steps if learning worsens. Both controls are exposed, and resumed checkpoints adopt the new sizes/car count. The deployed actor stays two layers of 128 units.

## AI Models and manual activation

The separate HTML entry is `ui/ai-models.html` (password `KartBlitzPass`). It loads the actual game and shows its built-in Current AI driving function under **Inspect the actual Current AI driving algorithm**. The scripted controller remains part of the game; training cannot overwrite or delete it.

The updated training window remembers job IDs and copies completed/stopped packages into the separate candidate library in IndexedDB. The models page can watch these runs even when the training window is closed. New trainer processes also expose a paired, read-only catalog of saved run files, allowing discovery after a trainer restart. An already-running older trainer keeps working through its existing job endpoints; use **Watch this run** with its job ID if it was started before this update. No training process needs to be interrupted to use that fallback.

Candidate arrival never changes the installed track weights or the selected driver. **Use this model** is the manual activation step: it archives any previously installed package, installs the chosen track package and selects Trained AI for AI Race/One Lap Shootout. Switching back to Current AI retains all weights and versions. Existing races keep their current controller; the choice applies to new races.

The library and driver choices belong to the browser origin. To transfer a local model to the GitHub-hosted game, download the candidate and import it into AI Models on that hosted site, then activate it manually there. This does not change the global default for other players or publish trained files to GitHub. An incompatible model may be retained/downloaded, but activation is disabled.

Training conditions currently use dry weather and medium tyres, with variation in observable vehicle dynamics. Policy observations include dynamics, tyre state and energy state, but that alone does not establish support for every upgrade or wet-weather setup. Test those conditions before enabling a policy there. The pit strategy remains game orchestration; the policy controls driving. The defensive lane constraint allows one lane move per sustained attacking encounter and runs during both training and gameplay. It is a baseline constraint, requiring race testing rather than a claim of complete F1 rules enforcement.

## What you can do to help make good weights

- Choose the first track and record several clean, fast offline player laps. Supply the full owner archive JSON files if you want optional imitation initialization. Online recordings with different geometry and public compact/legacy replays do not match this offline environment's required state/geometry.
- Give us your clean human lap benchmark and settings (mode, tyres, weather, upgrades). Compare trained laps in the actual game under those same settings. Training evaluation starts at the standing S/F setup; its times are diagnostics rather than leaderboard or WR claims.
- Let a longer run finish on a powered, ventilated laptop. Report completion rate, lap times, repeated failure sections and contact patterns, together with the job ID. These determine the next reward/observation experiment.

Imitation is an optional actor warm-start from compatible same-track observation/control samples. PPO then learns independently; imitation is not an ongoing objective forcing it to copy slower human actions. Recordings are sampled and do not make a perfect expert dataset automatically. Compare a run with and without imitation before deciding whether it helps this game.

## Saved data and playback

Runs live in `ml_training/runs/official/<job-id>/` (ignored by Git):

- `attempts.jsonl.gz`: every completed/failed attempt, its environment version, mode, difficulty, attempt number, policy step/update, valid-lap result, contact and off-track metrics. Each 20 Hz point includes timestamp, pose, speed, spline-position index, normalized progress, checkpoint, strict off-track/corner-cut flags, raw and applied action, accumulated reward, reward components and tyre/ERS state. These are actual trajectories; playback follows the saved poses without requiring deterministic resimulation.
- `track-N/track.json`: finalized geometry and position index for joining telemetry by track/section.
- `attempt-index.jsonl`: attempt outcomes, lap times and byte offsets into independent gzip members. Replay loading reads selected attempts without decoding a whole long run or blocking training collectors.
- `track-N/<difficulty>/last.zip`: resumable PPO state including optimizer. `best.zip`: best frozen evaluation checkpoint. `contract.json`: compatible physics and settings. Only load locally generated checkpoints through Resume; browser imports use validated JSON numerical weights.
- `track-N/<difficulty>/evaluations.jsonl`: frozen evaluation metrics and complete trajectories for comparing checkpoints and finding fast completed evaluation laps.
- `track-N/<difficulty>/training-diagnostics.jsonl`: actual PPO update count/step, approximate KL, clipping fraction, policy entropy, value explained variance, losses, action standard deviation and learning rate. The page shows KL, clipping and explained variance. These help diagnose unstable updates or a poor value fit; they do not certify driving quality. Undefined metrics are saved as `null`. Logging uses [SB3's callback lifecycle](https://stable-baselines3.readthedocs.io/en/master/guide/callbacks.html) after completed updates.
- `track-N.kartai.json`: browser-ready track package with learned actors and evaluation results. Physics/control and track geometry checks reject incompatible imports or usage.

The replay selector overlays up to 1,000 saved attempts: the first 1,000, attempts 3,001–4,000, or the latest 1,000. The paths are cached for drawing, cars move along recorded timestamps, and one selected attempt uses the game camera. A group is empty until enough attempts exist. These are attempt ranges, not PPO training iterations. Replay data remains associated with its run; keep the folder for future analysis.

Job status is held in the running trainer's memory. **Watch run** reconnects within that trainer session. Checkpoints and recordings persist after shutdown; a new training job can resume an earlier on-disk job ID. Download model JSON before transferring to another computer, and retain run folders for analysis. Stopping saves at a training callback boundary; the archive contains completed attempts, not unfinished fragments.

## Implementation and checks

`official-worker.mjs` runs a generated copy of the actual offline Kart, track finalization and helpers. Visual/audio effects and leaderboard writes are stubbed. Python's vector environment coordinates Node CPU workers; SB3 PPO trains a 48-input, two-layer 128-unit actor with five controls at 20 Hz over fixed 60 Hz physics. Progress, off-track, contact, smoothness, time and difficulty pace terms form the initial reward. Off-track positive progress is not rewarded. All checkpoints must be crossed in order before a completed-lap reward.

Local learning validation on 31 October 2026: an isolated Sunset Speedway/Extreme run used CUDA, 128 cars/eight workers, 128-step rollouts, 2,048-sample minibatches, seed 42, no opponents and no imitation. The earlier neutral-brake initialization learned to reverse and remained near 5% progress after a million steps. With version 3 and the forward initialization, frozen evaluation completed both modes at 250,112 steps. At 1,015,808 steps (about 215 seconds on this laptop), evaluation completed AI Race in 25.97 seconds and Shootout in 22.12 seconds, with no contacts or off-track ticks. This was one solo track/seed and one episode per mode per checkpoint; it establishes a working learning example, not broad reliability or competitive pace.

`e2e/official-deployment.spec.js` additionally compares policy-controlled trajectories against the native browser Kart across all eight tracks/both modes. Set `OFFICIAL_VALIDATION_PACKAGE` to a real exported Extreme candidate to test full learned trajectories and native AI grid/Shootout lead-in starts, including the native countdown and launch. That optional acceptance check stows the human car, uses dry medium tyres and one AI, and runs only in the isolated test browser. The final validation export completed valid native laps in 25.38 seconds (AI Race) and 17.57 seconds (Shootout). It does not install or activate a model in the user's browser. Native start timings differ from standing-S/F evaluation; these are not interchangeable leaderboard benchmarks. The local validation candidate remains in `ml_training/runs/official/end-to-end-validation-v3/track-0.kartai.json` and can be manually imported into AI Models.

`npm run official:core` regenerates physics and its compatibility hash. Packaging and training regenerate it automatically. Browser tests compare actual and headless Kart physics across all eight tracks and both modes. Python tests train five tiny policies, resume a saved optimizer, check terminal observations and compare exported JavaScript actor outputs with PyTorch. These are pipeline tests, not proof of useful driving.

```powershell
npm run test:official
npx playwright test e2e/official-ml.spec.js
```

The pinned Torch 2.9 Windows/SB3 combination exposes a nested ZIP tensor reading problem. Our checkpoint writer uses PyTorch's supported legacy tensor container inside SB3's normal ZIP, keeping its `weights_only=True` tensor loading. Checkpoint round-trip and resume are tested.

See [five-project research and tradeoffs](official-ml-research.md). PPO is a baseline; SAC/TD3 remain worthwhile comparisons if learning stalls. Nothing here guarantees human or WR pace, and the short validation models are deliberately not installed into normal gameplay.
