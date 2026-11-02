# Pace research and development

This is a separate V2 experiment workflow. Its objective is fast **valid** driving in the current game, with clean completion ahead of lap time. It preserves the V1 archives, model IDs, selected drivers and manual activation. It never commits, pushes or installs a model.

## Run the complete experiment

From CMD on this laptop:

```cmd
cd /d "C:\Users\mcmat\Downloads\KartBlitz"
npm run official:develop -- --track 0 --seconds 300
```

Track IDs are 0 Sunset, 1 Meadow, 2 Blue Bay, 3 Hurricane, 4 Riviera, 5 Titan, 6 Amber and 7 Neon. Current R&D targets Extreme. Default training is One Lap Shootout; the separate Time Trial game mode is untouched.

For a whole-race experiment, use:

```cmd
npm run official:develop -- --track 0 --mode ai --laps 3 --seconds 300
```

Supported race lengths are 1, 2, 3, 5, 8 and 10. Battery carries across laps through the actual physics. A three-lap experiment is evidence about three-lap driving; it does not establish ten-lap strategy or racecraft quality.

The budget is divided between line/speed search, corrective imitation and neural refinement. Evaluation, compression and saving take extra time. Recording caps can end a search early. `Ctrl+C` stops the workflow; completed stages and saved best checkpoints remain. `status.json` identifies the active or failed stage. Nothing starts automatically on opening the website.

Use `--candidate path/to/model.kartai.json` to include an existing policy as another seed. Multiple candidates are allowed. The workflow measures each seed rather than assuming a newer model is better. Changed physics/layouts are accepted only as explicit R&D warm starts, with the original hashes recorded. Original files are never rewritten or made compatible for deployment.

The workflow refuses to rebuild the simulator while the V1 manager is alive or cannot be inspected. It regenerates the headless core from the current `index.html` before child experiments load it. This matters after reverting/changing tracks or driving physics.

## What changed algorithmically

1. **Joint path and speed search.** A bounded cross-entropy search varies legal lateral positions, speed ceilings, braking anticipation, steering response and battery deployment together. It measures complete laps/races in the real Kart physics. Linked corners affect the same elapsed-time objective. The geometric reference is a starting point, not a required driving style.
2. **Corrective imitation (DAgger-style).** A 57-input/four-control V2 actor first learns clean planner demonstrations. It then drives its own trajectories; the planner supplies corrective labels at the states the learner actually visits. Expert mixing decreases across rounds. Only clean, completed demonstrations initialise imitation; corrective visits are separately labelled and never presented as successful laps. The best actor is selected using separate training-domain driving checks, not its fitting loss. Final pose/charge holdouts are excluded from fitting and selection.
3. **Champion-seeded neural refinement.** Search changes the four final control rows' scales/biases directly in a frozen seed network. This is a small derivative-free policy search, not full-network ES, SAC, online MPC or a globally optimal lap solver. It retains feedback from the neural policy and exports ordinary V2 weights. The unchanged seed remains an incumbent. Reliability, contact, track limits and finishing position take priority; measured elapsed time then decides. There is no reward for merely drawing an outside–apex–outside shape.
4. **Lossless PPO handoff.** The selected JSON actor can be copied directly into a PPO checkpoint. The critic and optimiser are fresh; there is no extra imitation step that changes its driving. Existing V2 mixed-mode PPO and equal-budget gamma comparisons can continue from it.

V2 PPO jobs of at least a minute also retain a measured `best.zip`, checking after completed updates approximately every two minutes and at the end. Checkpoint selection uses seeds distinct from final evaluation. `last.zip` preserves the latest training state for resuming; exported weights use the best measured checkpoint, so a worse final update cannot silently replace it. Metadata separates total training steps from the selected policy's step.

The broader PPO learner is still required to develop racing behaviour across lengths, charge levels and traffic. The present planner/coach generates solo driving examples. Race overtaking, defending, recovery and full-distance energy strategy must pass the existing native-game suite before promotion. Automatic held DRS and the existing four-control contract are unchanged.

## Files and recordings

Each job gets a new directory under `ml_training/runs/pace-rnd/`:

- `planner/`: plans, clean examples, all attempted paths and times.
- `student/`: imitation and corrective trajectories, independent evaluations and an unapproved V2 candidate.
- `refinement/`: every neural-search attempt, byte index, saved best weights, unchanged baseline and held-out comparison.
- `ppo-seed/last.zip` plus `contract.json`: exact actor handoff for further RL.
- `native.json` and its compressed recordings: browser-game comparison, when enabled.
- `report.json`: results and limitations; `approved` stays false in this R&D workflow.

Attempt archives contain positions, heading, controls, raw actions, speed, lap progress, lap/race times, contact/off-track data, charge, deployment and DRS state. Complete attempts can be reconstructed or overlaid for 1,000-car animations. Each compressed attempt has an offset/byte index for random access. Search caps reserve space for validation. Forced OS termination can interrupt the current unsaved attempt; previously completed attempts/checkpoints remain.

Import a planner's `reference-profile.json` and matching attempt archive in [Racing Line Inspector](https://leaferd6712.github.io/KartBlitz/index.html?tool=racing-lines) to inspect paths, gates and battery use. Neural refinement uses the standard generated reference profile; it records full paths regardless of whether a matching overlay profile is loaded.

For individual stages:

```cmd
npm run official:pace -- --track 0 --seconds 120 --output ml_training/runs/pace-rnd/NEW-planner
npm run official:imitate -- --data ml_training/runs/pace-rnd/NEW-planner/demonstrations.json.gz --coach-plan ml_training/runs/pace-rnd/NEW-planner/plan.json --output ml_training/runs/pace-rnd/NEW-student --seconds 60
npm run official:refine -- --candidate ml_training/runs/pace-rnd/NEW-student/candidate.kartai.json --output ml_training/runs/pace-rnd/NEW-refined --seconds 120
npm run official:seed -- --candidate ml_training/runs/pace-rnd/NEW-refined/candidate.kartai.json --output ml_training/runs/pace-rnd/NEW-ppo-seed
```

Use fresh names for NEW directories. Resume further mixed-mode RL through the existing trainer, for example:

```cmd
npm run official:v2 -- --track 0 --seconds 7200 --warm-start ml_training/runs/pace-rnd/NEW-ppo-seed/last.zip
```

This starts the existing four gamma/guidance arms and performs additional evaluation. A compatible V1 package is needed for that workflow's promotion comparison. An old-build warm start is not an already-approved current-build baseline.

## Validation and research basis

`npm run test:pace` checks legal profiles, actual physics, inference parity, immutable seed conversion, explicit compatibility guards, clean-time ranking, demonstration filtering, actor-only learning and exact PPO import. `npm run test:energy` covers the shared V2 battery/DRS, full-lap, timing and compatibility behaviour.

The native checker supports `--offline-assets`, fulfilling actual game assets directly into disposable Chromium without a running trainer/server. `--shootout-only` and `--research-baseline` are diagnostic flags and explicitly prevent approval. A normal `--v1` argument must contain an actual compatible V1 package. `--skip-native` skips browser checks in the combined workflow and leaves the candidate unapproved.

The implemented direction is informed by primary sources:

- [TUM minimum-time trajectory optimisation](https://github.com/TUMFTM/global_racetrajectory_optimization) distinguishes minimum time from minimum curvature and considers powertrain state. Our search uses KartBlitz's simulator instead of TUM's vehicle model.
- [Trajectory-aided racing RL](https://arxiv.org/abs/2306.07003) combines trajectory guidance with a feasible speed profile. Its F1Tenth results do not predict KartBlitz lap times.
- [DAgger](https://arxiv.org/abs/1011.0686) addresses the distribution shift caused by a learner visiting different states from its demonstrations. Our implementation uses simulator-coach labels and bounded mixing rounds.
- [Evolution Strategies](https://arxiv.org/abs/1703.03864) motivates evaluating policy changes directly. Our current final-layer CEM search is much narrower than that paper's method.
- [SB3 evaluation guidance](https://stable-baselines3.readthedocs.io/en/master/guide/rl_tips.html) supports separate evaluation, repeatable conditions and multiple runs. Six pose/charge checks are an initial check, not a human-pace or WR claim.

SAC/TD3 remain candidates for a subsequent controlled learner comparison; this implementation does not claim either has beaten PPO in KartBlitz. Hardware utilisation is not a model-quality score.

## First current-build result (2 November 2026)

See [the second research pass](race-rnd-findings.md) for the corrected race evaluator, teacher-rehearsal experiment and fresh native comparison. Its race results supersede the earlier contaminated race benchmark below; older files remain preserved.

The complete workflow was exercised on Sunset Extreme. On six matched native-game Shootout cases, Legacy's median was 26.88 s, the corrective-imitation seed's was 23.94 s and neural refinement's was 23.40 s. Each completed all six cases with no off-track ticks or contacts. These are controlled test results on the current track/build, not leaderboard or WR claims.

The same experimental policy completed validly in only 13 of 20 full-race checks, compared with Legacy's 19 of 20, and generated defensive review flags. It remains **unapproved**. This result supports the solo pace method and identifies race reliability/defending as the next training requirement. It does not justify replacing all existing drivers or claiming success on other tracks. Reports and complete recordings are under `ml_training/runs/pace-rnd/pipeline-check/`.
