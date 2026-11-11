# Continuous V2 training

Run from the KartBlitz folder:

```cmd
npm run official:continuous
```

The launcher opens the local dashboard at [Continuous training](http://127.0.0.1:8766/ui/continuous-training.html), with automatic pairing. Unlock with `KartBlitzPass`. Keep the laptop plugged in. Local training does not use a model API, chat subscription credits, or the five-hour chat allowance. Codex cannot inspect that allowance; no continuous chat monitoring is required.

This is a new campaign, separate from the archived V1 deadline campaign. It covers all eight tracks and five difficulties, using resumable 20-minute chunks. The queue gives each combination a turn before repeating one, with priority for combinations below their training target. The controller now targets five independent learners with two environments per learner and a bounded 384 MiB JavaScript old-generation heap per native browser. Throughput comparisons no longer remove slots. Dedicated VRAM is capped at 7 GiB and system RAM at 95%. Shared-GPU excess, battery operation, high temperatures, unavailable GPU telemetry or less than 20 GiB free disk prevent further training. After RAM pressure, future batches shrink and admission waits before trying again. Ordinary simulator/logging RAM remains necessary. Windows GPU-memory counters are an operational guard, not a guarantee about the graphics driver's allocation behaviour.

The five learners now share one Python/CUDA process to avoid duplicating roughly 1.6 GiB of PyTorch/driver RAM per learner on this laptop. They retain separate models, optimisers, simulator workers, control events and archives. Simulator seeds are independent; concurrent learners share the PyTorch exploration RNG, so training interleaving is not bitwise seed-reproducible. Deterministic evaluation uses separate fixed seeds. Native Node workers have a 384 MiB V8 old-generation heap budget, and native browser renderers have a 384 MiB budget. These are JavaScript heap limits, not caps on total process RSS.

## Difficulty order

The current schedule finishes **Extreme across all eight tracks**, then **Hard**, **Medium**, **Easy** and **Ultra easy**. Each track in the current difficulty must reach its attempt/race targets and pass native approval before the next difficulty starts. Queued tracks take turns within that difficulty. An incomplete or temporarily faulted Extreme track does not silently release Hard early.

Existing progress on later difficulties stays under its original job IDs, with checkpoints, attempt counts and recordings intact. It resumes when that difficulty becomes active. Each qualifying track model loads into the local game automatically after its training targets and native approval; activation is tracked separately per difficulty so installing Hard retains Extreme. Until a model qualifies, the existing driver remains available. `schedulingMode` and `difficultyOrder` are saved in the campaign settings. The dashboard labels later difficulties as saved for later.

Each of the 40 combinations has a **minimum of 10,000 completed training attempts**, including failures, and at least **2,000 full-race training attempts** among those attempts. Evaluation cases and interrupted fragments do not count. Counts are rebuilt incrementally from durable attempt indexes across all this campaign's checkpoints and jobs. Both targets plus passing native quality checks are required for a combination to be marked ready. The controller finishes only when all 40 are ready, or when explicitly stopped; it does not declare quality from an attempt count. Reaching these targets may take longer than ten hours and passing every model's quality checks is not guaranteed. Settings are persisted in `ml_training/runs/continuous-v2/current/settings.json`.

Each variant first learns One Lap Shootout, then mixed Shootout and full races. Race training uses **the actual browser Race state machine**, graded/grid starts and Legacy opponents, with rendering disabled. Passing, defending, recovery and mixed encounters match the native evaluator's setup. Battery and tyre wear carry between laps; training samples 1, 2, 3, 5, 8 and 10 laps and 25%, 50% and 100% starting charge. DRS uses the existing stable hold request. Initial coverage is dry weather, stock performance and medium tyres, including optional worn starts. Wet weather, upgrades and other game modes are not certified by this campaign.

The existing 57-observation/four-action V2 actor and PPO remain compatible. The fast Sunset research actor seeds Sunset; other combinations start from their own best compatible actor, or the same track's Extreme actor when available. Tracks without a compatible seed learn from scratch. A changed objective gets a fresh optimiser; an interrupted identical chunk can resume its last checkpoint. Alternate passes test gamma 0.9995 and 0.9999. These are experiments, not assumptions that the longer horizon wins.

Periodic checkpoint selection and chunk evaluation use different seeds, and include ten-lap checks once race training starts. Final native approval uses two separately generated seeds across 26 matched cases. A new policy must complete every case validly, keep off-track exposure below 1%, avoid defensive review flags, match or improve contact and finishing position, preserve matched Shootout pace within 0.05 seconds, avoid aggregate race-time regression, and demonstrate an improvement. It is compared with Legacy and the installed incumbent, where present. Defensive flags and near-contact counts are conservative proxies; they do not establish perfect F1 rule compliance. Candidates can remain unapproved indefinitely. No fixed time or global optimum is promised.

## Automatic activation and backup

Approved variants are merged per track under `ai-models/approved/continuous/`, retaining previously approved difficulties. Each weight version is immutable. `ai-models/active.json` atomically points to the current approved versions and their SHA-256 checksums. The local game checks this manifest when opened and every 30 seconds. New races in AI Race and One Lap Shootout use approved variants automatically; an existing race keeps its controller. Failed checks retain the existing driver.

The original controller stays in `index.html` and is also snapshotted with the prior approved files under `ai-models/backups/<campaign ID>/`. Previously installed browser packages are archived in AI Models before replacement. **Restore Legacy backup** disables automatic replacement in that browser; **Use approved models automatically** enables it again. A manual per-track model choice is also respected until automatic selection is re-enabled.

There is no commit, push or upload. Local activation does not update GitHub Pages. A later authorised website build includes the active manifest and its referenced approved packages. Imports and standalone experimental jobs remain manual candidates.

## State, recordings and stopping

- `ml_training/runs/continuous-v2/current/state.json`: persistent 40-task queue, best candidates and resumable checkpoints.
- `status.json`: dashboard progress and hardware measurements; `events.jsonl`: decisions.
- `source/<fingerprint>/`: immutable source snapshot; editing training/game sources pauses this campaign rather than mixing versions.
- `validations/<ID>/`: final native reports, acceptance decisions and compressed recordings.
- `ml_training/runs/official/<run ID>/`: configuration, worker log, `last.zip`, measured `best.zip`, actor package, full attempt archive and byte-offset index.

Attempt points retain positions, headings, controls, raw actions, speed, rewards, battery, DRS, tyre state, opponent poses and lap times. These are full 20 Hz recordings, not video; the viewer downsamples only its response. You can reconstruct full laps or overlay 1,000 saved attempts. Interrupted fragments are labelled. No automatic archive deletion occurs. Training pauses when disk reserve is reached; preserving unlimited recordings requires additional storage eventually.

Use **Save and pause all**, **Resume**, or **Stop and save** on the dashboard. Stopping saves and releases workers. Closing browser/chat windows does not stop the local controller. After a reboot or a stopped controller, run the same command to resume. There is no automatic Windows login task or service installation. An independent guardian cleans up owned workers after a manager crash. Failed tasks retry; repeated faults enter a bounded cooldown, retain their archives and retry from the best actor. Unplugging saves and waits; admission resumes after mains power returns. The viewer automatically reconnects after a transient failed status request.

## Checks

```cmd
npm run test:continuous
npm run test:continuous-native
npm run test:energy
npm run test:pace
```

The native test runs the existing fast actor through a real Shootout and a complete three-lap race, verifies the absent spectator, battery continuity, independent reset and recording fields. CPU learner tests exercise a real update, checkpoint resume and archive output. Browser tests cover automatic installation, mode boundaries and rollback. None of these checks is proof of human/WR pace or final racecraft quality.
