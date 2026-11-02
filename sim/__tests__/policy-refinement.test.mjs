import assert from 'node:assert/strict';
import {upgradeSeed, adjustPolicy, compilePolicy, compareSuites, IDENTITY} from '../policy-refinement.mjs';
import * as v1 from '../official-policy.mjs';
import * as v2 from '../official-policy-v2.mjs';
import {officialTracks} from '../../ml_training/official-worker-v2.mjs';
import {refineNetwork} from '../../scripts/refine-policy.mjs';

const policy = {activation: 'tanh', output: 'clipped-linear', layers: [
  {kernel: Array.from({length: 5}, (_, r) => v1.OBSERVATION_NAMES.map((_, c) => Math.sin(c + r) * .03)), bias: [0, .2, -.8, .1, .8]}
]};
const pack = {format: 'kartblitz-official-track-v1', trackId: 0, physicsHash: v1.PHYSICS_HASH,
  observationVersion: 1, observationCount: 48, observationNames: v1.OBSERVATION_NAMES,
  trackFingerprint: v1.trackFingerprint(officialTracks[0]), variants: {extreme: {policy}}};
const saved = structuredClone(pack), upgraded = upgradeSeed(pack);
assert(v2.validatePackage(upgraded)); assert.deepEqual(pack, saved);
const obs = v2.OBSERVATION_NAMES.map((_, i) => Math.cos(i));
const original = v1.forward(policy, obs.slice(0, 48)).slice(0, 4), actual = v1.forward(upgraded.variants.extreme.policy, obs);
assert.deepEqual(actual, original);
assert.deepEqual(compilePolicy(upgraded.variants.extreme.policy)(obs), actual);
assert.deepEqual(adjustPolicy(upgraded.variants.extreme.policy, IDENTITY), upgraded.variants.extreme.policy);
const parameters = [1.2, .8, 1.1, .9, .03, -.2, .1, .5], adjusted = adjustPolicy(upgraded.variants.extreme.policy, parameters);
assert.deepEqual(upgraded.variants.extreme.policy.layers[0].bias, [0, .2, -.8, .1]);
assert(Math.abs(adjusted.layers[0].bias[0] - .03) < 1e-12);
assert.throws(() => adjustPolicy(adjusted, [NaN]), /Invalid/);
assert.throws(() => upgradeSeed({...pack, physicsHash: 'old'}), /physics differ/);
const rebased = upgradeSeed({...pack, physicsHash: 'old'}, 'extreme', {allowPhysicsWarmStart: true});
assert.equal(rebased.physicsHash, v1.PHYSICS_HASH); assert.equal(rebased.variants.extreme.training.sourcePhysicsHash, 'old');
assert.equal(rebased.approved, false);
assert.throws(() => upgradeSeed({...pack, trackFingerprint: 'different'}, 'extreme', {targetTrack: officialTracks[0]}), /layout differs/);
const transferred = upgradeSeed({...pack, trackFingerprint: 'different'}, 'extreme', {targetTrack: officialTracks[0], allowTrackWarmStart: true});
assert.equal(transferred.trackFingerprint, pack.trackFingerprint); assert(transferred.variants.extreme.training.trackWarmStart);
assert.throws(() => upgradeSeed({...pack, observationNames: ['wrong']}), /semantics/);
const row = {finished: true, validLap: true, offTrackRate: 0, contacts: 0, raceTime: 20, raceLaps: 1, progress: 1, racePosition: 1};
assert(compareSuites([row], [{...row, raceTime: 21}]) < 0);
assert(compareSuites([row], [{...row, finished: false, raceTime: 1, progress: 1000}]) < 0);
assert(compareSuites([row], [{...row, raceTime: 19, offTrackRate: .01}]) < 0);
assert.throws(() => compareSuites([row], []), /matched/);
// With no search rounds, an unchanged, measured seed is the selected champion.
const result = await refineNetwork([pack], {rounds: 0, seconds: 1});
assert.deepEqual(result.best.trial.parameters, IDENTITY); assert.equal(result.history.length, 1); assert.equal(result.attempts, 3);
let stopped = false;
const interrupted = await refineNetwork([pack], {rounds: 50, seconds: 30, cancelled: () => stopped,
  onAttempt: () => setImmediate(() => { stopped = true; })});
assert.equal(interrupted.history.length, 1); assert(v2.validatePackage(interrupted.best.pack));
console.log('Neural refinement: exact V1 transfer, compiled inference parity, immutable seeds, explicit compatibility guards, clean-time ranking and baseline retention passed.');
