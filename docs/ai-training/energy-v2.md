# V1 campaign and V2 energy strategy

The running 2–3 November campaign remains **V1**, with its original source fingerprint and deadline. AI Models adds V1 to its names without modifying packages, candidate hashes, selections or recordings. Existing V1 candidates and Legacy remain usable. No V2 training starts automatically.

V2 is an opt-in, separate PPO trainer. One policy per track/difficulty controls steering, throttle, braking and ERS. DRS is a constant hold request when available/on track; the actual game physics decides whether its zone allows activation. No neural output toggles DRS. Physics, drain, regeneration, handling, weather and DRS eligibility are unchanged.

V2 adds nine observations to the original 48: track phase sine/cosine, race length, remaining race distance, actual ERS activation, blended boost power, previous ERS request, straight harvesting timer and actual DRS activation. Its package identifies generation 2, observation contract 2 and four actions. The browser dispatcher accepts both generations; V1 keeps its original controller.

AI Race episodes sample 1, 2, 3, 5, 8 and 10 laps, while Shootout always uses one. Starting charge samples 25%, 50% and 100%. Battery is not refilled at race lap crossings. Progress is bounded, potential-based shaping using the arm's gamma, so missed checkpoints and extra unofficial laps cannot farm distance reward. The objective adds valid completion/finishing-position reward, failure penalties and a time cost scaled by race length; contact, off-track and driving-smoothness penalties remain. There is no reward for hoarding charge or fixed reserve. Every lap must be valid for a successful race. Held-out comparisons judge whole-race times, positions, reliability and cleanliness, rather than battery percentage alone.

## Starting a future V2 experiment

The CLI **refuses to start while the V1 campaign manager is alive**. After that campaign finishes, an example for Sunset Extreme is:

```cmd
npm run official:v2 -- --track 0 --difficulty extreme --seconds 7200 --warm-start "ml_training/runs/official/RUN_ID/track-0/extreme/best.zip" --v1-package "ml_training/runs/official/RUN_ID/track-0.kartai.json"
```

Replace RUN_ID with the same compatible V1 source run. Existing environment installation is required. Before learning, the CLI calibrates a reference with actual KartBlitz physics, saves the calibration recordings, and freezes its timing baselines. `--line-profile path/to/reference-profile.json` reuses a fully calibrated profile. The default is CPU, 16 cars and four physics workers; `--device cuda`, `--cars` and `--workers` are explicit options. The four arms combine gamma 0.995/0.9995 with guidance off/on; each receives one quarter of the specified active training time, with identical seeds, frozen profiles and warm starts. Evaluation takes additional time; this is **not** the current campaign's deadline runner. Ctrl+C requests checkpoint/partial-recording saves. Forced termination or power loss can only retain the most recent completed checkpoint/recording.

Warm start copies the shared V1 actor/critic layers, zeroes the additional observation columns, drops the learned DRS output and creates a fresh optimizer/buffer. It checks the source track and physics. A compatible 57-input/four-action V2 checkpoint can also warm-start the new objective without carrying optimizer state. V1 files are never rewritten. This is a starting point, not evidence that the new energy strategy has already been learned.

## Recording, evaluation and promotion

Experiments live under `ml_training/runs/energy-v2/<ID>/`. Each gamma arm saves a checkpoint, versioned browser package, effective contract, status, gzip attempt archive and byte-offset index. Trajectories contain battery, ERS power/activation, DRS state, controls, position, opponents, lap index/times and race time. Interrupted fragments are labeled. Different environments have separate recordings, enabling car overlays and normal renderer playback from poses.

Each arm is evaluated deterministically on 26 matched held-out cases: two seeds covering Shootout at all three charges, AI Race at all six lengths and passing/defending/recovery/mixed encounters. Completion and clean driving precede position and race-time comparisons. The selected arm then runs native browser tests against Legacy and the supplied V1 package, using the real starts/game update, common seeds, energy and Legacy opponents. Native recordings include complete races and energy/control telemetry. Contact and defensive flags are conservative proxies, not a perfect racing rulebook.

Promotion requires all native V2 cases to finish validly with under 1% off-track time, no defensive reversal flags, no increased contact, no slower aggregate times in either mode and no worse aggregate AI race positions than each fully finishing baseline. A style tie can tolerate at most 0.05 seconds per matched case; it cannot justify a larger pace loss. Native checks also compare against the best unguided arm. V2 must also improve over V1 in reliability, contact, position or aggregate time (at least 0.05 seconds in one mode). A missing V1 baseline or smoke-only check cannot approve a model. Failed baselines are retained in the report; a reliable V2 completion can beat a baseline DNF. Recovery cases must recover within ten seconds.

Approved packages and validation references are saved under `ai-models/approved/v2/` and copied into the normal saved-candidate catalog. A trainer service started before this update needs restarting **after V1 finishes** to discover V2 catalog entries. Alternatively import the JSON in AI Models. Nothing activates automatically, commits or pushes. Choose V1, V2 or Legacy per track as before.

Run `npm run test:energy` for simulator, checkpoint-migration, CPU PPO, JavaScript-export and archive checks. Browser coverage is `npx playwright test e2e/energy-v2.spec.js e2e/ai-models.spec.js --workers=1`.


## Racing-line guidance and mini-sectors

The new V2 environment is version 6 with reward `v2-line-1`; the 57 observations and four learned controls are unchanged. The running V1 source fingerprint, queue and deadline are untouched. No training starts merely by opening the inspector.

`sim/racing-line.mjs` finds signed-curvature regions and linked corner complexes, creates a road-clearance reference, and fixes entry/apex/exit gates. `scripts/ai-training/build-racing-line.mjs` searches entry/apex/exit offsets and apex timing jointly for each complex using complete real-physics races. It tries progressively lower pace settings when necessary, selects clean completions by whole-race time and only uses style within a 0.05-second tie. The guide is provisional; this controller search is not proof of the globally fastest line. A faster legal learned line remains eligible.

A corner B window runs from A's exit through B to C's entry. Windows overlap and include the next straight; they must not be added to form a lap. Separate adjacent-gate splits do add up over a complete lap. Gates are finite physical lines, crossed forwards with time/speed interpolated between 60 Hz samples. This avoids closest-spline wrap jitter. Interpolated lap totals can differ from the game's tick-rounded clock by up to one physics tick. Clipped start/end windows are partial and receive no bonus. Reversals, stops, skipped/teleported gates, contact and off-track traversal invalidate affected windows. Reading partials does not close a still-running window.

The style bonus requires a smooth traversal of the entry/apex/exit reference corridor; it is capped at two points per attempt. The timing bonus is capped at three points and uses only frozen, valid baseline windows. The combined maximum is five points, 5% of the 100-point completion reward. Close traffic, defensive encounters and collision recovery suppress both bonuses. No bonus is based on apex speed alone. All ordinary contact, track-limit and steering penalties remain.

Matched timing requires identical track gates, mode, difficulty, race length/lap and physics/weather/tyres, plus close entry speed (15 units/s), charge (5 percentage points), grip (0.03), tyre wear (0.03), tyre temperature (5 degrees) and performance (5 speed units). End charge and deployed energy must also be within five percentage points and DRS active time within 0.15 seconds. Unmatched samples are still recorded, but produce no timing bonus or claimed matched delta. Reference hashes identify the frozen guidance; separate timing hashes remain identical across different lines on the same gates.

Open [Racing lines and corner timing](http://127.0.0.1:8766/ui/racing-lines.html), unlock with KartBlitzPass, load the run's reference-profile.json and then an attempts.jsonl.gz or native/calibration archive. Choose a recorded attempt and a comparison. The map overlays the reference, both paths and timing gates. The normal game camera displays recorded battery, ERS and DRS. Corner buttons play that complete timing window; ordinary playback continues through the recorded run. The adjacent split table shows timing and validity. The inspector streams concatenated gzip members locally; it retains up to the first 1,000 matching attempts. Source archives are never modified. Older pose-only recordings get estimated timing; stored V2 timing retains the 60 Hz measurements.

Reference definitions, calibration trials, frozen windows, per-attempt mini-sectors and native comparisons are saved with the run. Imports with incompatible gates require the matching profile. Models, approved exports, activation and rollback retain their existing V1/V2 separation; nothing commits, pushes or activates automatically.
