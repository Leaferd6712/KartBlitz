/** One command: current physics -> fast examples -> actor -> measured refinement. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {buildOfficialCore} from './build-official-core.mjs';

const args = process.argv.slice(2), value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (args.includes('--help')) {
  console.log('npm run official:develop -- --track 0 --seconds 300 [--mode shootout|ai --laps 3 --candidate seed.kartai.json --skip-native --output NEW_DIRECTORY]');
  process.exit(0);
}
const trackId = Number(value('--track', 0)), seconds = Number(value('--seconds', 300)), mode = value('--mode', 'shootout'), laps = Number(value('--laps', 3));
if (!Number.isInteger(trackId) || trackId < 0 || trackId > 7 || !Number.isFinite(seconds) || seconds < 60 || seconds > 7200
    || !['shootout', 'ai'].includes(mode) || ![1, 2, 3, 5, 8, 10].includes(laps)) throw Error('Use --track 0..7 --seconds 60..7200 [--mode shootout|ai --laps 1|2|3|5|8|10]');
const output = path.resolve(value('--output', `ml_training/runs/pace-rnd/develop-${Date.now()}-track-${trackId}`));
const candidates = args.flatMap((flag, i) => flag === '--candidate' ? [path.resolve(args[i + 1])] : []);
if (fs.existsSync(output)) throw Error('Choose a new output directory; existing runs are immutable');
const python = process.platform === 'win32' ? '.venv-official/Scripts/python.exe' : '.venv-official/bin/python';
if (!fs.existsSync(python)) throw Error('Install the Official ML Python environment first');
let child = null, cancelled = false, phase = 'guard';
function stop() { cancelled = true; child?.kill('SIGINT'); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
async function run(command, parameters) {
  if (cancelled) throw Error('R&D stopped; completed stages and recordings were preserved');
  const code = await new Promise((resolve, reject) => {
    child = spawn(command, parameters, {stdio: 'inherit', windowsHide: true});
    child.on('error', reject); child.on('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode));
  });
  child = null;
  if (cancelled || code !== 0) throw Error(cancelled ? 'R&D stopped; saved stages remain available' : `${phase} exited with code ${code}; inspect that stage before continuing`);
}
// A source rebuild is safe only when the existing campaign manager is gone.
await run(python, ['-c', 'from ml_training.official_train_v2 import campaign_is_live; import sys; sys.exit(2 if campaign_is_live() else 0)']);
buildOfficialCore();
fs.mkdirSync(output, {recursive: true});
const write = (file, data) => fs.writeFileSync(path.join(output, file), JSON.stringify(data, null, 2));
const started = Date.now();
function status(next) { phase = next; write('status.json', {phase, trackId, mode, raceLaps: mode === 'shootout' ? 1 : laps, elapsedSeconds: (Date.now() - started) / 1000, approved: false}); }
write('config.json', {trackId, mode, laps, seconds, candidates, note: 'Search/fitting budgets are bounded; evaluation, compression and saving take extra time. Every model remains unapproved until complete validation.'});
try {
  const planner = path.join(output, 'planner'), student = path.join(output, 'student'), refined = path.join(output, 'refinement');
  status('find-fast-legal-driving');
  await run(process.execPath, ['scripts/pace-rnd.mjs', '--track', String(trackId), '--mode', mode, '--laps', String(mode === 'shootout' ? 1 : laps),
    '--seconds', String(Math.min(1800, Math.max(10, seconds * .4))), '--rounds', '100', '--population', '24', '--output', planner]);
  const plannerReport = JSON.parse(fs.readFileSync(path.join(planner, 'report.json'), 'utf8'));
  if (!plannerReport.demonstrationSamples) throw Error('Planner found no clean examples; recordings were saved and no imitation policy was created');
  status('learn-from-fast-examples');
  await run(python, ['-m', 'ml_training.pace_distill', '--data', path.join(planner, 'demonstrations.json.gz'), '--output', student,
    '--coach-plan', path.join(planner, 'plan.json'), '--epochs', '700', '--seconds', String(Math.min(1800, Math.max(1, seconds * .2)))]);
  status('refine-measured-neural-policy');
  await run(process.execPath, ['scripts/refine-policy.mjs', '--candidate', path.join(student, 'candidate.kartai.json'),
    ...candidates.flatMap(file => ['--candidate', file]), '--allow-physics-warm-start', '--allow-track-warm-start',
    '--mode', mode, '--laps', String(laps), '--seconds', String(Math.min(1800, Math.max(10, seconds * .4))), '--rounds', '150', '--population', '20', '--output', refined]);
  const candidate = path.join(refined, 'candidate.kartai.json');
  status('create-lossless-ppo-seed');
  await run(python, ['-m', 'ml_training.policy_seed', '--candidate', candidate, '--output', path.join(output, 'ppo-seed')]);
  let native = null;
  if (!args.includes('--skip-native')) {
    status('native-game-validation');
    await run(process.execPath, ['scripts/energy-browser-check.mjs', candidate, 'extreme', path.join(output, 'native.json'), '--offline-assets',
      '--research-baseline', path.join(refined, 'baseline.kartai.json')]);
    native = JSON.parse(fs.readFileSync(path.join(output, 'native.json'), 'utf8'));
  }
  write('report.json', {approved: false, phase: 'research-complete', trackId, mode, candidate, ppoSeed: path.join(output, 'ppo-seed/last.zip'),
    refinement: JSON.parse(fs.readFileSync(path.join(refined, 'report.json'), 'utf8')), native,
    reason: 'Research comparison is never automatic promotion. Keep manual activation and complete matched baseline validation.', elapsedSeconds: (Date.now() - started) / 1000});
  status('research-complete');
  console.log(JSON.stringify({output, candidate, approved: false}));
} catch (error) {
  write('status.json', {phase: cancelled ? 'stopped' : 'needs-attention', failedStage: phase, message: error.message, approved: false});
  console.error(error.message); process.exitCode = 1;
}
