import assert from 'node:assert/strict';
import {officialTracks, Environment} from '../../ml_training/official-worker-v2.mjs';
import {drive, search} from '../../scripts/pace-rnd.mjs';
import {makePlan, initialParameters, parameterBounds, nextPopulation, randomSource, schedule, cleanFinish, compareTrials, speedEnvelope, plannedAction} from '../pace-planner.mjs';
import {validateProfile} from '../racing-line.mjs';
import {PHYSICS_HASH} from '../official-policy.mjs';

assert.equal(schedule([0, 1, 0, -1], 0), schedule([0, 1, 0, -1], 1));
assert(Math.abs(schedule([0, 1, 0, -1], -.25) + 1) < 1e-9);
for (const track of officialTracks) {
  const p = initialParameters(track, {classic: true}), plan = makePlan(track, p);
  assert(validateProfile(plan.profile, track, PHYSICS_HASH));
  const env = new Environment(0, {trackId: track.id, mode: 'shootout', lineProfile: plan.profile, randomization: false});
  for (const point of plan.profile.reference) {
    Object.assign(env.kart, {x: point.x, y: point.y}); assert(env.kart.onTrack(track));
  }
  env.reset({fixed: true, mode: 'shootout', energy: .5});
  const envelope = speedEnvelope(plan, env.kart.maxSpeed, env.kart.brakeForce);
  assert(envelope.every(x => Number.isFinite(x) && x > 0));
  const action = plannedAction(env, plan, envelope);
  assert.equal(action.length, 4); assert(action.every(x => Number.isFinite(x) && Math.abs(x) <= 1));
  const initialCharge = env.kart.ersCharge;
  for (let i = 0; i < 10; i++) env.step(plannedAction(env, plan, envelope));
  assert(env.kart.ersCharge <= initialCharge + .05); // Energy uses physics, never an unlimited search resource.
}
const bounds = parameterBounds(), first = initialParameters(officialTracks[0]), second = initialParameters(officialTracks[0], {classic: true});
const population = nextPopulation([first, second], bounds, randomSource(7), 8);
assert.deepEqual(population, nextPopulation([first, second], bounds, randomSource(7), 8));
assert(population.every(p => p.every((v, i) => v >= bounds[i][0] && v <= bounds[i][1])));
const clean = {finished: true, validLap: true, raceTime: 30, offTrackRate: 0, contacts: 0, progress: 1};
assert(cleanFinish(clean)); assert(!cleanFinish({...clean, validLap: false}));
assert(compareTrials(clean, {...clean, finished: false, raceTime: 1, progress: 100}) < 0);
assert(compareTrials(clean, {...clean, raceTime: 40}) < 0);
assert(compareTrials(clean, {...clean, raceTime: 20, contacts: 1}) < 0);
const a = await search(officialTracks[0], {rounds: 0, seconds: 10}), b = await search(officialTracks[0], {rounds: 0, seconds: 10});
assert.deepEqual(a.best.row, b.best.row); assert(cleanFinish(a.best.row));
const recording = drive(a.best.plan, {collect: true});
assert(recording.result.finished); assert(recording.result.validLap); assert(recording.points.length > 100);
assert.equal(recording.pairs[0].observation.length, 57); assert.equal(recording.pairs[0].action.length, 4);
assert(recording.points.every(p => 'ersCharge' in p && 'drsActive' in p && 'action' in p));
console.log('Pace planner: all-track legal profiles, finite controls, real energy, deterministic CEM, clean-lap ranking and replay/observation records passed.');
