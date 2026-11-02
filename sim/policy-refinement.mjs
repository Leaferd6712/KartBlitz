/** Measured policy search. Produces ordinary V2 network weights, no new runtime. */
import * as v1 from './official-policy.mjs';
import * as v2 from './official-policy-v2.mjs';
export const REFINEMENT_VERSION = 'neural-pace-cem-1';
export const IDENTITY = [1, 1, 1, 1, 0, 0, 0, 0];
export const BOUNDS = [[.65, 1.45], [.6, 1.6], [.6, 1.6], [.4, 1.8], [-.14, .14], [-.7, .7], [-.7, .7], [-2, 2]];

export function upgradeSeed(pack, difficulty = 'extreme', {allowPhysicsWarmStart = false, allowTrackWarmStart = false, targetTrack = null} = {}) {
  const generation = pack.format === 'kartblitz-official-track-v2' ? 2 : 1;
  const physicsChanged = pack.physicsHash !== v1.PHYSICS_HASH;
  if (physicsChanged && !allowPhysicsWarmStart) throw Error('Seed physics differ. Use explicit --allow-physics-warm-start for R&D re-evaluation, never activation of old models.');
  // The original package is immutable. Only its numerical weights may initialise
  // a new experiment, whose entire behaviour must be measured in current physics.
  (generation === 2 ? v2 : v1).validatePackage(physicsChanged ? {...pack, physicsHash: v1.PHYSICS_HASH} : pack);
  const expectedNames = generation === 2 ? v2.OBSERVATION_NAMES : v1.OBSERVATION_NAMES;
  if (JSON.stringify(pack.observationNames) !== JSON.stringify(expectedNames)) throw Error('Seed observation semantics differ');
  if (targetTrack && targetTrack.id !== pack.trackId) throw Error('Target track ID differs');
  const targetFingerprint = targetTrack ? v1.trackFingerprint(targetTrack) : pack.trackFingerprint;
  const trackChanged = targetFingerprint !== pack.trackFingerprint;
  if (trackChanged && !allowTrackWarmStart) throw Error('Seed layout differs. Use explicit --allow-track-warm-start for fresh R&D evaluation on the changed track.');
  if (!pack.variants[difficulty]) throw Error('Seed has no requested difficulty');
  const policy = structuredClone(pack.variants[difficulty].policy);
  if (generation === 1) {
    for (const row of policy.layers[0].kernel) row.push(...Array(v2.OBSERVATION_NAMES.length - v1.OBSERVATION_NAMES.length).fill(0));
    const last = policy.layers.at(-1); last.kernel = last.kernel.slice(0, 4); last.bias = last.bias.slice(0, 4);
  }
  return {format: 'kartblitz-official-track-v2', modelGeneration: 2, name: `V2 R&D · ${pack.name || 'seed'}`,
    trackId: pack.trackId, physicsHash: v1.PHYSICS_HASH, trackFingerprint: targetFingerprint,
    observationVersion: 2, observationCount: v2.OBSERVATION_NAMES.length, observationNames: [...v2.OBSERVATION_NAMES],
    actionCount: 4, actionNames: [...v2.ACTION_NAMES], decisionHz: 20, environmentVersion: 6, approved: false,
    variants: {[difficulty]: {id: 'rd-seed', policy, training: {algorithm: REFINEMENT_VERSION, seedGeneration: generation,
      sourcePhysicsHash: pack.physicsHash, physicsWarmStart: physicsChanged,
      sourceTrackFingerprint: pack.trackFingerprint, trackWarmStart: trackChanged}}}};
}

export function adjustPolicy(policy, parameters = IDENTITY) {
  if (parameters.length !== 8 || parameters.some((x, i) => !Number.isFinite(x) || x < BOUNDS[i][0] || x > BOUNDS[i][1])) throw Error('Invalid neural refinement parameters');
  const refined = structuredClone(policy), layer = refined.layers.at(-1);
  if (layer.bias.length !== 4) throw Error('Refinement expects four V2 controls');
  for (let action = 0; action < 4; action++) {
    layer.kernel[action] = layer.kernel[action].map(w => w * parameters[action]);
    layer.bias[action] = layer.bias[action] * parameters[action] + parameters[action + 4];
  }
  return refined;
}

export function compilePolicy(policy) {
  const layers = policy.layers.map(l => ({bias: Float64Array.from(l.bias), rows: l.kernel.map(r => Float64Array.from(r))}));
  return observation => {
    let inputs = observation;
    for (let i = 0; i < layers.length; i++) {
      const {bias, rows} = layers[i], values = new Float64Array(bias.length);
      for (let r = 0; r < rows.length; r++) {
        let sum = bias[r]; for (let c = 0; c < rows[r].length; c++) sum += rows[r][c] * inputs[c];
        values[r] = i < layers.length - 1 ? Math.tanh(sum) : Math.max(-1, Math.min(1, sum));
      }
      inputs = values;
    }
    return Array.from(inputs);
  };
}

export function suiteScore(rows) {
  const clean = rows.filter(r => r.finished && r.validLap && r.offTrackRate === 0 && r.contacts === 0 && Number.isFinite(r.raceTime) && r.raceTime > 0);
  return [clean.length, -rows.reduce((s, r) => s + (r.contacts || 0), 0),
    -rows.reduce((s, r) => s + (r.offTrackRate || 0), 0),
    -clean.reduce((s, r) => s + (r.racePosition || 1), 0),
    -clean.reduce((s, r) => s + r.raceTime, 0),
    rows.reduce((s, r) => s + Math.max(0, Math.min(r.raceLaps || 1, r.progress || 0)), 0)];
}
export function compareSuites(a, b) {
  if (a.length !== b.length) throw Error('Only matched case suites can be compared');
  const x = suiteScore(a), y = suiteScore(b);
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 1e-8) return y[i] - x[i];
  return 0;
}
