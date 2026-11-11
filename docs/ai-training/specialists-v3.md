# V3 taught racing specialists

[Local training dashboard](http://127.0.0.1:8766/ui/specialist-training.html) · [AI Models](http://127.0.0.1:8766/index.html?tool=ai-models) · [Corner replay inspector](http://127.0.0.1:8766/ui/racing-lines.html)

Start or resume in CMD:

```bat
cd /d "C:\Users\mcmat\Downloads\KartBlitz"
npm run official:v3
```

Unlock with `KartBlitzPass`. Keep the laptop powered and awake. The local Python manager and small watchdog run independently of ChatGPT and use no model API credits. Closing a viewer does not stop training. Pause and Stop controls are on the dashboard; Stop saves completed work and available PPO checkpoints. A paused campaign remains in memory; emergency memory guards cancel and release a learner before admission resumes. Restart the command after reboot. Source changes fail closed and require a new revision rather than silently resuming a changed objective.

## What runs first

The earlier V2 campaign is checkpointed, stopped, and preserved. V3 is separate. Sunset Speedway and Titan Loop are the pilot tracks. Each track/difficulty package contains two independent actors: `shootout` for One Lap Shootout and `race` for AI Race. They retain the 57 observations, four learned controls and two 128-unit hidden layers. DRS remains automatic. Other game modes retain their existing controllers.

Each teacher is validated through native `Race` and `Kart` physics, including action smoothing. Geometry-derived line/speed profiles propagate braking constraints around the full lap. Conservative planner and Legacy-action probes are compared by clean native times; a track without a clean teacher enters `repair-required` instead of starting RL. Only completed, contact-free demonstrations with zero off-track exposure enter initial cloning. Failed-state correction labels are stored separately.

The student uses balanced braking/cornering/ordinary-driving examples, three corrective imitation rounds, closed-loop checkpoint selection, and a critic warmup that checks the actor is unchanged. Compatible saved actors can seed both pilot arms. The original fast Sunset actor participates in student selection and final regression checks.

The pilot compares repaired baseline PPO with taught PPO for three seeds, **one million RL decisions per arm, per specialist, per track**. Both arms use the same calibrated sector reward and conditions. Rollouts round budgets by less than one 512-decision rollout. Demonstration generation, cloning, correction collection and critic warmup costs are recorded separately from the RL budget. Five learners can share one Python/CUDA context; exploration and minibatch sampling have private RNGs. Race curriculum admits traffic only after a 100-case native solo gate, then progresses through passing, defending, recovery and mixed traffic. Race updates never change the Shootout actor. Between chunks the manager reviews recent completion, off-track exposure and corner diagnoses. Struggling taught actors can receive additional teacher-labelled corrections on new training states; closed-loop selection must improve before those corrections are kept. These costs are separate from the equal RL decision budget.

No attempt quota or deadline certifies a model. Both specialists require 500 independently seeded held-out attempts and a 95% Wilson lower reliability bound of at least 97% (at least 493 successful cases out of 500). Successful cases must have less than 1% off-track exposure; solo cases require no contact. The pre-existing 26 targeted scenarios are partitioned across the specialists and all must pass. Matched checks preserve saved pace and compare contact, race time and position against Legacy. Extreme Shootout must improve on Legacy. A full-recording 50×10-lap soak runs without other learners and checks crashes and retained memory. Passing one specialist cannot install half a package.

Failed certificates retain the current driver. Up to three additional selection-only refinement blocks can run with new final seed banks; the original equal-budget pilot comparison remains unchanged. Persistent teacher/simulator failures are shown as `repair-required`, with the original traceback. No guard or quality threshold is automatically relaxed. A failed pilot does not unlock full rollout. After both pilot packages qualify, Extreme finishes across eight tracks before the lower difficulties.

## Files and recordings

- `ml_training/runs/continuous-v2/current/v3-backup/20261111-065408/`: pre-V3 campaign snapshot and checkpoint inventory. Original V1/V2 files remain in their original folders.
- `ml_training/runs/specialists-v3/current/state.json`: durable queue, job progress, paths and revision fingerprint.
- `ml_training/runs/specialists-v3/current/status.json`: dashboard snapshot.
- `ml_training/runs/specialists-v3/current/jobs/<job ID>/`: teacher probes, accepted demonstrations, separate corrections, PPO chunks, checkpoints and evaluation archives.
- `reference-profile.json`: frozen reference, timing gates and matched corner-window baselines. Line and timing bonuses share the existing 5% completion-reward cap; line guidance is suppressed around traffic/recovery.
- `attempts.jsonl.gz` and other named `.jsonl.gz` archives: concatenated gzip members, one JSON record per attempt. Positions, applied controls, raw actions where available, pre-action observations, speed, lap clocks, battery, deployment, DRS, tyre state and opponents are retained. Failed/interrupted attempts are labelled. Chunks contain about 100 samples; the live simulator ring holds at most 600 samples.
- `attempt-index.jsonl`: small seek index containing archive filename, byte offset and length. `trajectory_archive.read_group` makes bounded, downsampled browser previews; originals retain full 20 Hz data for 1,000-car animations.
- `ml_training/runs/official/<job ID>/`: viewer status and replay source pointers for each V3 job.
- `ai-models/approved/continuous/`: only qualified V3 packages and validation references. `ai-models/active.json` selects approved versions automatically. Previous files, manual selections and Legacy rollback remain available.

Corner telemetry includes entry/exit speeds, interpolated ordered gate timing, whole-corner/next-approach windows, non-overlapping lap splits, battery use, DRS and braking diagnostics. Estimated braking distances and failure labels are diagnostic; measured native driving results decide promotion. Open a run's frozen profile and archives in the corner inspector to compare paths and matched timing windows.

Initial certification covers dry weather, stock performance and medium tyres. It does not certify rain, upgrades or human/WR pace. These are measured goals, not promised outcomes. This workflow writes files locally and never commits or pushes.

## Checks

`npm run test:specialists` covers dispatch, rejection gates, RNG/checkpoint restoration and streaming replay reconstruction. `.venv-official\Scripts\python.exe -m unittest ml_training.test_specialists_native` checks native deployed-mode driving, pre-action telemetry alignment and frozen-actor critic warmup. Existing energy, pace, continuous/native, and browser model-selection tests remain applicable. A smoke run never substitutes for the certification and soak jobs.
