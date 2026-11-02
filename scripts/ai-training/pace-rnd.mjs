/** Bounded offline R&D: actual physics, explicit cases, immutable runs, no activation. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Environment, officialTracks, referenceAction} from '../../ml_training/official-worker-v2.mjs';
import {observe, OBSERVATION_NAMES, ACTION_NAMES} from '../../sim/official-policy-v2.mjs';
import {PHYSICS_HASH, geometry} from '../../sim/official-policy.mjs';
import {PLANNER_VERSION, makePlan, initialParameters, parameterBounds, nextPopulation, randomSource, speedEnvelope, plannedAction, compareTrials, cleanFinish} from '../../sim/pace-planner.mjs';

export function drive(plan, {mode = 'shootout', raceLaps = 1, energy = 1, seed = 4242, difficulty = 'extreme', referencePace = null, collect = false, record = false, lateralOffset = 0, headingOffset = 0} = {}) {
  const env = new Environment(0, {trackId: plan.trackId, mode, raceLaps, difficulty, seed, randomization: false, lineGuidance: false, lineProfile: plan.profile, scenario: 'solo', episodeSeconds: Math.max(150, raceLaps * 120)});
  let observation = env.reset({fixed: true, mode, raceLaps, energy}), result;
  if (lateralOffset || headingOffset) {
    const angle = env.kart.angle;
    env.kart.x -= Math.sin(angle) * lateralOffset; env.kart.y += Math.cos(angle) * lateralOffset; env.kart.angle += headingOffset;
    env.kart.prevX = env.kart.x; env.kart.prevY = env.kart.y; env.state.lastAngle = env.kart.angle;
    env.lastG = geometry(env.kart, env.track, env.state); env.trajectory = []; env.record();
    observation = observe(env.kart, env.track, env.state, env.context);
  }
  const speeds = speedEnvelope(plan, env.kart.maxSpeed, env.kart.brakeForce), pairs = [];
  while (true) {
    const action = referencePace === null ? plannedAction(env, plan, speeds) : referenceAction(env, referencePace);
    if (collect) pairs.push({observation, action});
    result = env.step(action); observation = result.observation;
    if (result.done) break;
  }
  return {trackId: plan.trackId, difficulty, mode, raceLaps, startingCharge: energy, seed, lateralOffset, headingOffset, plannerVersion: PLANNER_VERSION,
    profileHash: plan.profile.profileHash, result: result.info, ...(collect || record ? {points: env.trajectory} : {}), ...(collect ? {pairs} : {})};
}

export async function search(track, {rounds = 6, population = 20, seed = 4242, seconds = 120, mode = 'shootout', raceLaps = 1, energy = 1, onTrial = () => {}, onBest = () => {}, cancelled = () => false} = {}) {
  const deadline = Date.now() + seconds * 1000, random = randomSource(seed), bounds = parameterBounds(), history = [];
  const conditions = {mode, raceLaps, energy, seed}; let best = null;
  const test = async (parameters, stage) => {
    const plan = makePlan(track, parameters), run = drive(plan, {...conditions, record: true}), row = {...run.result, trial: history.length, stage, parameters};
    history.push(row); onTrial(row, {...run, trial: row.trial, parameters});
    if (!best || compareTrials(row, best.row) < 0) { best = {plan, row}; onBest({...drive(plan, {...conditions, collect: true}), trial: row.trial}); }
    await new Promise(resolve => setImmediate(resolve)); // Dispatch stop requests between complete attempts.
    return {plan, row};
  };
  // Broad initial feasibility sweep, including centreline and classical shapes.
  for (const classic of [false, true]) for (const speed of [.65, .85, 1.1]) for (const energySchedule of ['on', 'off', 'spatial']) {
    if (cancelled() || Date.now() > deadline) break;
    const parameters = initialParameters(track, {classic, speed, energy: energySchedule === 'off' ? -.6 : .4});
    if (energySchedule === 'spatial') for (let i = 24; i < 36; i++) parameters[i] = random() * 2 - 1;
    await test(parameters, 'initial');
  }
  if (!best) throw Error('Experiment cancelled before its first rollout');
  const initialBest = structuredClone(best.row), pool = [...history];
  for (let round = 0; round < rounds && !cancelled() && Date.now() < deadline; round++) {
    pool.sort(compareTrials);
    const elites = pool.slice(0, Math.max(2, Math.ceil(population * .2))).map(r => r.parameters);
    // Keep exploration broad initially; use CEM elites and local champion mutations.
    const candidates = nextPopulation(elites, bounds, random, population, round < 2 ? 1.8 : 1);
    for (let j = 0; j < candidates.length && !cancelled() && Date.now() < deadline; j++) {
      if (j % 3 === 0) {
        const local = [...best.row.parameters], field = Math.floor(random() * local.length), [lo, hi] = bounds[field];
        local[field] = Math.max(lo, Math.min(hi, local[field] + (random() - .5) * (hi - lo) * .3)); candidates[j] = local;
      }
      pool.push((await test(candidates[j], `round-${round + 1}`)).row);
    }
    pool.sort(compareTrials); pool.splice(population);
  }
  return {best, initialBest, history, stoppedByTime: Date.now() >= deadline};
}

async function main() {
  const args = process.argv.slice(2), value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const trackId = Number(value('--track', 0)), seconds = Number(value('--seconds', 120)), seed = Number(value('--seed', 4242));
  const population = Number(value('--population', 20)), rounds = Number(value('--rounds', 6));
  const mode = value('--mode', 'shootout'), raceLaps = Number(value('--laps', mode === 'shootout' ? 1 : 3)), energy = Number(value('--charge', 1));
  if (!officialTracks[trackId] || !Number.isInteger(trackId) || !Number.isFinite(seconds) || seconds < 1 || seconds > 1800 || !Number.isInteger(seed)
      || !Number.isInteger(population) || population < 4 || population > 128 || !Number.isInteger(rounds) || rounds < 0 || rounds > 100
      || !['shootout', 'ai'].includes(mode) || ![1, 2, 3, 5, 8, 10].includes(raceLaps) || mode === 'shootout' && raceLaps !== 1 || ![.25, .5, 1].includes(energy)) throw Error('Use --track 0..7 --seconds 1..1800 [--mode shootout|ai --laps 1|2|3|5|8|10 --charge .25|.5|1 --seed 4242 --rounds 6 --population 20]');
  const output = path.resolve(value('--output', `ml_training/runs/pace-rnd/${Date.now()}-track-${trackId}`));
  if (fs.existsSync(output)) throw Error('Choose a new R&D directory. Existing runs are immutable.');
  fs.mkdirSync(output, {recursive: true});
  // Snapshot protected campaign sources without importing or touching the manager.
  const protectedFiles = ['index.html', 'sim/official-policy.mjs', 'sim/official-contract.mjs', 'ml_training/official-worker.mjs', 'ml_training/official_environment.py', 'ml_training/official_train.py', 'ml_training/campaign.py', 'ml_training/campaign_resources.py', 'ml_training/campaign_validation.py', 'ml_training/campaign_guardian.py', 'scripts/campaign-browser-check.mjs'];
  const fingerprints = () => Object.fromEntries(protectedFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const before = fingerprints(), write = (file, data) => fs.writeFileSync(path.join(output, file), JSON.stringify(data, null, 2));
  let cancelled = false, archiveBytes = 0;
  process.on('SIGINT', () => { cancelled = true; }); process.on('SIGTERM', () => { cancelled = true; });
  function archive(file, value) {
    const data = gzipSync(JSON.stringify(value) + '\n'); archiveBytes += data.length;
    if (archiveBytes > 160 * 1024 ** 2) throw Error('160 MiB R&D archive cap reached; previous checkpoints remain available');
    const destination = path.join(output, file), offset = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
    fs.appendFileSync(destination, data); return {offset, bytes: data.length};
  }
  const experimentSources = Object.fromEntries(['scripts/ai-training/pace-rnd.mjs', 'sim/pace-planner.mjs', 'ml_training/official-worker-v2.mjs', 'sim/official-policy-v2.mjs', 'sim/racing-line.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  write('config.json', {trackId, mode, raceLaps, energy, seed, seconds, rounds, population, physicsHash: PHYSICS_HASH, plannerVersion: PLANNER_VERSION, protectedSources: before, experimentSources, nodeVersion: process.version, approved: false});
  const outcome = await search(officialTracks[trackId], {seconds, seed, mode, raceLaps, energy, population, rounds, cancelled: () => cancelled || archiveBytes >= 120 * 1024 ** 2,
    onTrial: (row, record) => {
      const location = archive('attempts.jsonl.gz', record);
      fs.appendFileSync(path.join(output, 'attempt-index.jsonl'), JSON.stringify({trial: row.trial, trackId, mode, raceLaps, raceTime: row.raceTime, finished: row.finished, validLap: row.validLap, points: record.points.length, ...location}) + '\n');
      fs.appendFileSync(path.join(output, 'trials.jsonl'), JSON.stringify(row) + '\n'); write('status.json', {phase: 'search', trial: row.trial, valid: cleanFinish(row), seconds: row.raceTime}); },
    onBest: record => archive('improvements.jsonl.gz', record)});
  const plan = outcome.best.plan; write('plan.json', plan); write('reference-profile.json', plan.profile);
  const conditions = {mode, raceLaps, energy, seed}, baselinePlan = makePlan(officialTracks[trackId], initialParameters(officialTracks[trackId]));
  // Matched baseline of the current calibration controller, all speeds tried.
  const referenceRuns = [];
  for (const referencePace of [.95, .8, .65, .5, .35, .25]) {
    const record = drive(baselinePlan, {...conditions, referencePace, collect: true}); archive('reference.jsonl.gz', record);
    referenceRuns.push({...record.result, referencePace});
  }
  referenceRuns.sort(compareTrials);
  const validation = [], demonstrations = [];
  for (const holdoutSeed of [81271, 91517]) for (const charge of [.25, .5, 1]) {
    // Seed alone changes nothing in a fixed solo lap. Explicit small start-pose
    // perturbations make these genuine recovery/robustness holdouts.
    const lateralOffset = holdoutSeed === 81271 ? -6 : 6, headingOffset = holdoutSeed === 81271 ? -.025 : .025;
    const record = drive(plan, {...conditions, seed: holdoutSeed, energy: charge, lateralOffset, headingOffset, collect: true}); archive('validation.jsonl.gz', record);
    validation.push({...record.result, seed: holdoutSeed, startingCharge: charge, lateralOffset, headingOffset});
    // Holdout cases never enter the imitation dataset.
  }
  for (const charge of [.25, .5, 1]) {
    const teacher = drive(plan, {...conditions, energy: charge, collect: true}); archive('teacher.jsonl.gz', teacher);
    if (cleanFinish(teacher.result)) demonstrations.push({trackId, difficulty: 'extreme', mode, raceLaps, seed, startingCharge: charge, profileHash: plan.profile.profileHash,
      result: teacher.result, pairs: teacher.pairs});
  }
  const dataset = {format: 'kartblitz-pace-demonstrations-v1', physicsHash: PHYSICS_HASH, trackId, trackFingerprint: plan.trackFingerprint, difficulty: 'extreme', observationNames: OBSERVATION_NAMES, actionNames: ACTION_NAMES,
    provenance: {algorithm: PLANNER_VERSION, plan: 'plan.json', trainingSeeds: [seed], holdoutSeeds: [81271, 91517]}, episodes: demonstrations};
  archive('demonstrations.json.gz', dataset);
  const after = fingerprints(), unchanged = JSON.stringify(before) === JSON.stringify(after);
  const report = {approved: false, reason: 'Offline controller R&D only; a policy must still pass independent native-game validation.',
    trackId, mode, raceLaps, seed, startingCharge: energy, trials: outcome.history.length, stoppedByTime: outcome.stoppedByTime, cancelled,
    protectedSourcesUnchanged: unchanged, initialBest: outcome.initialBest, best: outcome.best.row, referenceBest: referenceRuns[0], validation,
    improvementOverReferenceSeconds: cleanFinish(outcome.best.row) && cleanFinish(referenceRuns[0]) ? referenceRuns[0].raceTime - outcome.best.row.raceTime : null,
    improvementOverInitialSeconds: cleanFinish(outcome.best.row) && cleanFinish(outcome.initialBest) ? outcome.initialBest.raceTime - outcome.best.row.raceTime : null,
    heldoutCleanRate: validation.filter(cleanFinish).length / validation.length, demonstrationSamples: demonstrations.reduce((n, e) => n + e.pairs.length, 0), archiveBytes,
    stoppedByArchiveBudget: archiveBytes >= 120 * 1024 ** 2, allSearchAttemptsRecorded: true};
  write('report.json', report); write('status.json', {phase: 'complete', approved: false, trials: report.trials});
  if (!unchanged) throw Error('Protected files changed during the experiment; investigate before using the results');
  console.log(JSON.stringify({output, trials: report.trials, seconds: report.best.raceTime, clean: cleanFinish(report.best), heldoutCleanRate: report.heldoutCleanRate, improvementOverReferenceSeconds: report.improvementOverReferenceSeconds, approved: false}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
