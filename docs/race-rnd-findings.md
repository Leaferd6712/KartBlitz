# Race R&D: second experiment, 2 November 2026

The existing fast Sunset policy remains selected as the research seed. No challenger in this pass qualified for promotion or activation. All weights, recordings and earlier reports are preserved; no commits or pushes were made by this workflow.

## Findings from actual checks

The first native benchmark had a hidden-spectator error. The unused human car was moved off-map but still updated in AI Race. Its recovery could return it to the circuit and trigger unwanted defensive encounters during nominally solo runs. The harness now disables only that spectator's update and excludes it from controller opponents. It remains unfinished in AI mode because marking the human finished would auto-DNF other cars after 30 seconds. Shootout uses its normal stowed-competitor behaviour.

Every new native report records the opponent count, spectator intrusion ticks, evaluation source hash and the actual vehicle state at the end of launch. A regression test verifies a native solo three-lap race completes beyond 30 seconds with no spectator intrusion. Older race statistics should not be combined with the corrected evaluator's results. The earlier Shootout comparison was unaffected by this AI Race spectator issue.

Temporarily removing the defensive state in a diagnostic-only ablation reduced valid race completion on the original test schedule from 12/20 to 11/20. This does not support deleting the rule. The ablation cannot approve a model. Existing defensive flags measure lane deviation and are conservative review proxies, not proof of an intentional second blocking move; the acceptance gate remains strict.

## Controlled training comparison

Two challengers received 90 active seconds each, starting from exactly the same fast actor and fresh optimiser. Both used mixed Shootout/race training, traffic, the supported race lengths/charges, lower warm-start steering noise, a PPO KL limit, and optional initial tyre wear of 0%, 20%, 40% or 60%. All episodes still start behind the actual S/F line. Worn starts are training conditions; fixed evaluation starts fresh. Wear and charge carry normally across race laps.

The second arm added four small actor-only rehearsal updates after each PPO update. It rehearsed frozen raw action means on the seed's successful Shootout states. This is post-update teacher rehearsal, not a reproduction of the Kickstarting algorithm. Critics and original teacher weights are unaffected. Replay data are saved separately; checkpoints remain standard PPO-compatible.

On the same headless Shootout cases, the unchanged seed's median was 24.82 s, ordinary PPO's was 27.97 s and rehearsal's was 25.12 s. Rehearsal retained more pace in this short run, but both regressed. This was one training seed and a small budget, so it does not establish algorithm superiority. The starting-wear curriculum was common to both arms; this comparison does not establish its independent benefit.

The rehearsed candidate then faced fresh native seeds **163381** and **256019**. It completed all six Shootout cases cleanly with a 23.54 s median, versus the unchanged seed's 23.41 s and Legacy's 25.84 s. It completed 12/20 races validly, versus the unchanged seed's 14/20 and Legacy's 18/20. The challenger was rejected. Race median pace across different completed subsets is deliberately not used to claim an improvement.

Research selection now always includes the unchanged fast seed. A race challenger that loses more than 0.05 s in any matched successful Shootout case, or loses its reliability/cleanliness, is ineligible. Improving one mode cannot silently replace stronger driving in the other mode. This is a regression gate, not a claim that 0.05 s is statistically meaningful.

## Steering feedback audit

The defensive helper sometimes applies a different steering value from the one retained in controller state. The next `previousSteer` observation and smoothing step then use the pre-override value. The fresh native reference recorded 5,991 calls with this discrepancy across the race suite and none in Shootout.

A diagnostic feeding the actual applied steering back into controller state kept Shootout results identical, reduced contact events from six to five and reduced mean off-track exposure, but valid race completion fell from 14/20 to 13/20. It was **not deployed**. This is evidence of a control/observation issue worth investigating, not evidence that simply changing the feedback will improve the existing weights. A proper change needs explicit contract versioning and retraining. `--applied-steer-feedback` is an unapprovable diagnostic flag; original production control semantics remain unchanged.

## The next research priority

The unchanged seed passed 20/20 headless race cases but only 14/20 fresh native cases. The environments have identical Kart physics, but their episode setup and opponents differ. Headless resets are standing starts one car length behind S/F; native Race includes the real grid and graded launch. Headless traffic uses scripted training opponents; native traffic uses Legacy drivers. **My inference is that closing this setup/opponent gap deserves priority over a blind PPO-to-SAC switch.** This pass does not prove which difference contributes most.

The next useful tests are to reproduce the captured native launch states in controlled headless cases, introduce matched native opponent behaviours, and evaluate worn-tyre/traffic failures separately. If mixed training still trades Shootout pace for race behaviour, a conditional policy with dedicated mode heads inside the same per-track package is a promising experiment. It is not implemented or assumed to improve results here. Longer-horizon energy planning should be judged over complete races; the current short test is insufficient evidence about optimal battery strategy.

There is also a horizon question: at 20 decisions per second, gamma 0.9995 weights an end reward 400 seconds away by only about 1.8%. The discount determines how strongly future outcomes affect learning. A longer horizon or finite-distance energy planner is worth a matched complete-race experiment, especially for ten laps; this calculation alone does not show which setting will drive faster.

## Repeat and inspect

```cmd
npm run official:race-rnd -- --candidate PATH_TO_CURRENT_V2.kartai.json --output NEW_RESEARCH_DIRECTORY --seconds-per-arm 120
npm run test:native-isolation
```

Run `test:energy` and `test:pace` for simulator, replay, checkpoint, rehearsal and pace-retention checks. Native checks use disposable Chromium and local assets; they do not change the player's selected model.

The two-arm runs and complete recordings are under `ml_training/runs/pace-rnd/sunset-race-rehearsal-v1/`. The retrospective review retaining the fast seed is under `ml_training/runs/pace-rnd/sunset-race-retention-review/`. The new retention rule is also part of future runs. Older research artifacts are immutable and retain their original selection reports.

## Primary research used

- [GT Sophy technology](https://www.gran-turismo.com/us/gran-turismo-sophy/technology/) describes mixed racing situations and specialised opponents. It supports testing race skills explicitly, not assuming solo pace produces racecraft.
- [Kickstarting Deep Reinforcement Learning](https://arxiv.org/abs/1803.03835) studies using existing agents as teachers during RL. It informed the rehearsal hypothesis; our small post-update experiment is a different implementation.
- [SB3 evaluation guidance](https://stable-baselines3.readthedocs.io/en/master/guide/rl_tips.html) supports separate evaluation, repeatable conditions and multiple runs. Fresh native seeds and preserving the original baseline are essential to interpreting this pass.
