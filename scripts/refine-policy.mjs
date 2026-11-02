/** Champion-seeded full-lap/full-race neural search. No publishing or activation. */
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Environment, officialTracks} from '../ml_training/official-worker-v2.mjs';
import {geometry} from '../sim/official-policy.mjs';
import {observe, validatePackage} from '../sim/official-policy-v2.mjs';
import {upgradeSeed, adjustPolicy, compilePolicy, BOUNDS, IDENTITY, compareSuites, REFINEMENT_VERSION} from '../sim/policy-refinement.mjs';
import {randomSource, nextPopulation} from '../sim/pace-planner.mjs';
import {buildOfficialCore} from './build-official-core.mjs';
import {buildProfile} from '../sim/racing-line.mjs';

export function policyCases(mode, {holdout = false, raceLaps = 3} = {}) {
  const seeds = holdout ? [81271, 91517] : [4242], cases = [];
  for (const seed of seeds) for (const energy of [.25, .5, 1]) {
    cases.push({mode, raceLaps: mode === 'shootout' ? 1 : raceLaps, energy, seed, scenario: 'solo',
      lateralOffset: holdout ? seed === 81271 ? -6 : 6 : 0, headingOffset: holdout ? seed === 81271 ? -.025 : .025 : 0});
  }
  if (mode === 'ai') for (const seed of seeds) for (const scenario of ['passing', 'defending']) cases.push({mode, raceLaps, energy: .5, seed, scenario});
  return cases;
}

export function policyRollout(pack, c, {difficulty = 'extreme', record = false} = {}) {
  const track = officialTracks[pack.trackId];
  if (pack.trackFingerprint !== upgradeTrackFingerprint(track)) throw Error('Seed geometry differs from the actual game');
  const env = new Environment(0, {trackId: track.id, difficulty, ...c, racecraft: c.scenario !== 'solo', randomization: false, lineGuidance: false,
    episodeSeconds: Math.max(150, c.raceLaps * 120)});
  let observation = env.reset({fixed: true, mode: c.mode, raceLaps: c.raceLaps, energy: c.energy});
  if (c.lateralOffset || c.headingOffset) {
    const angle = env.kart.angle; env.kart.x -= Math.sin(angle) * (c.lateralOffset || 0); env.kart.y += Math.cos(angle) * (c.lateralOffset || 0); env.kart.angle += c.headingOffset || 0;
    env.kart.prevX = env.kart.x; env.kart.prevY = env.kart.y; env.state.lastAngle = env.kart.angle;
    env.lastG = geometry(env.kart, env.track, env.state); env.trajectory = []; env.record(); observation = observe(env.kart, env.track, env.state, env.context);
  }
  const predict = compilePolicy(pack.variants[difficulty].policy); let result;
  do { result = env.step(predict(observation)); observation = result.observation; } while (!result.done);
  return {trackId: pack.trackId, difficulty, ...c, startingCharge: c.energy, result: {...result.info, ...c}, ...(record ? {points: env.trajectory} : {})};
}
// Keep the runtime's track fingerprint algorithm; no approximate layout matching.
import {trackFingerprint as upgradeTrackFingerprint} from '../sim/official-policy.mjs';

export async function refineNetwork(seeds, {difficulty = 'extreme', mode = 'shootout', raceLaps = 3, rounds = 12, population = 16, seconds = 120, seed = 42,
  allowPhysicsWarmStart = false, allowTrackWarmStart = false, cancelled = () => false, onAttempt = () => {}, onBest = () => {}} = {}) {
  if (!seeds.length) throw Error('At least one existing policy is required');
  const cases = policyCases(mode, {raceLaps}), random = randomSource(seed), deadline = Date.now() + seconds * 1000, history = [];
  const upgraded = seeds.map(p => upgradeSeed(p, difficulty, {allowPhysicsWarmStart, allowTrackWarmStart, targetTrack: officialTracks[p.trackId]}));
  if (upgraded.some(p => p.trackId !== upgraded[0].trackId || p.physicsHash !== upgraded[0].physicsHash || p.trackFingerprint !== upgraded[0].trackFingerprint)) throw Error('Seeds must match track and physics');
  let attempt = 0, best = null;
  const test = async (base, parameters, stage) => {
    const pack = structuredClone(base); pack.variants[difficulty].policy = adjustPolicy(base.variants[difficulty].policy, parameters);
    const rows = cases.map(c => { const recording = policyRollout(pack, c, {difficulty, record: true}); onAttempt({...recording, attempt: attempt++, trial: history.length, stage, parameters}); return recording.result; });
    const trial = {trial: history.length, stage, parameters, rows, seedName: base.name}; history.push(trial);
    if (!best || compareSuites(rows, best.trial.rows) < 0) { best = {pack, trial, base}; onBest(best); }
    await new Promise(resolve => setImmediate(resolve));
    return trial;
  };
  // Every seed is measured, including the unchanged champion. The budget starts
  // before this baseline; a baseline suite can exceed a very short time budget.
  for (const base of upgraded) { if (cancelled()) break; await test(base, IDENTITY, 'seed'); }
  if (!best) throw Error('Stopped before measuring a baseline');
  const baseline = structuredClone(best), base = structuredClone(best.pack), pool = [];
  // Perturbations are always relative to this frozen best seed, never repeatedly
  // applied to previously scaled weights.
  for (let round = 0; round < rounds && Date.now() < deadline && !cancelled(); round++) {
    pool.sort((a, b) => compareSuites(a.rows, b.rows));
    const elites = [best.trial.parameters, ...pool.slice(0, Math.max(1, Math.ceil(population / 5))).map(t => t.parameters)];
    const candidates = nextPopulation(elites, BOUNDS, random, population, round < 3 ? 2.5 : 1);
    for (let i = 0; i < candidates.length && Date.now() < deadline && !cancelled(); i++) {
      if (i % 2 === 0) {
        const local = [...best.trial.parameters], field = Math.floor(random() * 8), [lo, hi] = BOUNDS[field];
        local[field] = Math.max(lo, Math.min(hi, local[field] + (random() - .5) * (hi - lo) * .2)); candidates[i] = local;
      }
      pool.push(await test(base, candidates[i], `round-${round + 1}`));
    }
    pool.sort((a, b) => compareSuites(a.rows, b.rows)); pool.splice(population);
  }
  return {best, baseline, history, attempts: attempt, stoppedByTime: Date.now() >= deadline};
}

async function main() {
  const args = process.argv.slice(2), value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const seedFiles = args.flatMap((v, i) => v === '--candidate' ? [args[i + 1]] : []), outputArg = value('--output', null);
  const mode = value('--mode', 'shootout'), raceLaps = Number(value('--laps', 3)), seconds = Number(value('--seconds', 120));
  const rounds = Number(value('--rounds', 15)), population = Number(value('--population', 16)), seed = Number(value('--seed', 42));
  const difficulty = value('--difficulty', 'extreme');
  const allowPhysicsWarmStart = args.includes('--allow-physics-warm-start');
  const allowTrackWarmStart = args.includes('--allow-track-warm-start');
  if (!seedFiles.length || !outputArg || !['shootout', 'ai'].includes(mode) || ![1, 2, 3, 5, 8, 10].includes(raceLaps)
    || !Number.isFinite(seconds) || seconds < 1 || seconds > 1800 || !Number.isInteger(rounds) || rounds < 0 || rounds > 200
    || !Number.isInteger(population) || population < 4 || population > 128 || !Number.isInteger(seed)) throw Error('Use --candidate file.kartai.json [--candidate another.json] --output NEW_DIRECTORY [--seconds 120 --mode shootout|ai --laps 3]');
  const seeds = seedFiles.map(file => JSON.parse(fs.readFileSync(file, 'utf8'))), output = path.resolve(outputArg);
  // Validate everything before creating files or starting a simulator.
  buildOfficialCore({checkOnly: true});
  seeds.forEach(p => upgradeSeed(p, difficulty, {allowPhysicsWarmStart, allowTrackWarmStart, targetTrack: officialTracks[p.trackId]}));
  if (fs.existsSync(output)) throw Error('Choose a new output directory. Existing runs and seed files are immutable.');
  fs.mkdirSync(output, {recursive: true});
  const write = (name, data) => { const temporary = path.join(output, name + '.tmp'); fs.writeFileSync(temporary, JSON.stringify(data, null, 2)); fs.renameSync(temporary, path.join(output, name)); };
  let archiveBytes = 0, cancelled = false;
  process.on('SIGINT', () => { cancelled = true; }); process.on('SIGTERM', () => { cancelled = true; });
  const archive = (name, data) => {
    const bytes = gzipSync(JSON.stringify(data) + '\n'), destination = path.join(output, name), offset = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
    archiveBytes += bytes.length; if (archiveBytes > 192 * 1024 ** 2) throw Error('R&D recording cap reached; previous checkpoints are saved');
    fs.appendFileSync(destination, bytes); return {offset, bytes: bytes.length};
  };
  const config = {algorithm: REFINEMENT_VERSION, mode, raceLaps, difficulty, seconds, rounds, population, seed, allowPhysicsWarmStart, allowTrackWarmStart,
    seeds: seedFiles.map(file => ({file: path.resolve(file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex')})),
    sources: Object.fromEntries(['scripts/refine-policy.mjs', 'sim/policy-refinement.mjs', 'sim/official-policy-v2.mjs', 'ml_training/official-worker-v2.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))};
  write('config.json', config);
  const reference = buildProfile(officialTracks[seeds[0].trackId]);
  write('reference-profile.json', reference);
  const outcome = await refineNetwork(seeds, {mode, raceLaps, difficulty, seconds, rounds, population, seed, allowPhysicsWarmStart, allowTrackWarmStart, cancelled: () => cancelled || archiveBytes > 120 * 1024 ** 2,
    onAttempt: record => {
      const index = archive('attempts.jsonl.gz', record);
      fs.appendFileSync(path.join(output, 'attempt-index.jsonl'), JSON.stringify({attempt: record.attempt, trial: record.trial, trackId: record.trackId, mode: record.mode, raceLaps: record.raceLaps,
        raceTime: record.result.raceTime, finished: record.result.finished, validLap: record.result.validLap, ...index}) + '\n');
      write('status.json', {phase: 'search', attempt: record.attempt, trial: record.trial, lastSeconds: record.result.raceTime});
    }, onBest: best => { write('best-search.kartai.json', best.pack); write('best-search-metrics.json', best.trial); }});
  const winner = outcome.best.pack;
  winner.createdAt = Date.now(); winner.name = `V2 R&D · ${officialTracks[winner.trackId].name} · ${difficulty} · neural pace`;
  winner.variants[difficulty].id = path.basename(output);
  winner.variants[difficulty].training = {...winner.variants[difficulty].training, algorithm: REFINEMENT_VERSION, seedFiles: config.seeds, trials: outcome.history.length,
    optimisationMode: mode, raceLaps: mode === 'shootout' ? 1 : raceLaps, recordingArchive: 'attempts.jsonl.gz', fullRaceObjective: mode === 'ai', approved: false};
  validatePackage(winner); write('candidate.kartai.json', winner); write('baseline.kartai.json', outcome.baseline.pack);
  const holdouts = policyCases(mode, {holdout: true, raceLaps}), results = {};
  for (const [arm, pack] of [['baseline', outcome.baseline.pack], ['candidate', winner]]) {
    results[arm] = holdouts.map(c => { const record = policyRollout(pack, c, {difficulty, record: true}); archive('holdouts.jsonl.gz', {...record, arm}); return record.result; });
  }
  const heldoutImproved = compareSuites(results.candidate, results.baseline) < 0;
  const clean = row => row.finished && row.validLap && row.offTrackRate === 0 && row.contacts === 0;
  const heldoutPaceImproved = results.candidate.every(clean) && results.baseline.every(clean)
    && results.candidate.reduce((s, r) => s + r.raceTime, 0) < results.baseline.reduce((s, r) => s + r.raceTime, 0) - 1e-8;
  const completed = results.candidate.filter(clean), times = completed.map(r => r.raceTime / r.raceLaps).sort((a, b) => a - b);
  const median = times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null;
  winner.variants[difficulty].evaluation = {cancelled, scope: 'Headless R&D pose/charge holdouts', nativeValidated: false,
    finishRate: completed.length / results.candidate.length, medianLapTime: median, episodes: results.candidate,
    perMode: {[mode]: {cases: results.candidate.length, finishRate: completed.length / results.candidate.length, medianSecondsPerLap: median}}};
  write('candidate.kartai.json', winner);
  const report = {approved: false, reason: 'Research candidate only. Native full-race and Shootout comparisons against V1 and Legacy are mandatory before promotion.',
    trackId: winner.trackId, difficulty, mode, raceLaps: mode === 'shootout' ? 1 : raceLaps, trials: outcome.history.length, attempts: outcome.attempts,
    cancelled, stoppedByTime: outcome.stoppedByTime, stoppedByArchiveBudget: archiveBytes > 120 * 1024 ** 2,
    baseline: outcome.baseline.trial, best: outcome.best.trial, holdouts: results, heldoutImproved, heldoutPaceImproved,
    allSearchAttemptsRecorded: true, archiveBytes, candidate: 'candidate.kartai.json', seedsUnchanged: config.seeds.every(s => createHash('sha256').update(fs.readFileSync(s.file)).digest('hex') === s.sha256)};
  if(buildOfficialCore({checkOnly:true}).hash!==winner.physicsHash)throw Error('Game physics changed during the experiment; saved weights remain research-only');
  write('report.json', report); write('status.json', {phase: 'complete', approved: false, heldoutImproved, attempts: outcome.attempts});
  console.log(JSON.stringify({output, trials: report.trials, attempts: report.attempts, heldoutImproved, heldoutPaceImproved,
    baselineSeconds: results.baseline.map(r => r.raceTime), candidateSeconds: results.candidate.map(r => r.raceTime), approved: false}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
