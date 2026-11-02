/** Offline pace experiments. This controller is never installed as a game driver. */
import {centerAt, hash, referenceAt, buildProfile} from './racing-line.mjs';
import {PHYSICS_HASH, trackFingerprint} from './official-policy.mjs';

export const PLANNER_VERSION = 'pace-search-1';
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mod = (x, n) => ((x % n) + n) % n;
const wrap = x => Math.atan2(Math.sin(x), Math.cos(x));

export function randomSource(seed) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function normal(random) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
}
export function schedule(values, phase) {
  const u = mod(phase, 1) * values.length, i = Math.floor(u), f = (1 - Math.cos((u - i) * Math.PI)) / 2;
  return values[i] + (values[(i + 1) % values.length] - values[i]) * f;
}

// Line, speed ceiling and deployment desirability are independent search variables.
// Coupled braking feasibility is computed over the entire circular path below.
export function parameterBounds(knots = 12) {
  return [...Array.from({length: knots}, () => [-.85, .85]),
    ...Array.from({length: knots}, () => [.35, 1.35]),
    ...Array.from({length: knots}, () => [-1, 1]),
    [160, 950], [.35, .95], [.12, .55], [1.7, 4.5]];
}
export function initialParameters(track, {knots = 12, classic = false, speed = 1, energy = 0} = {}) {
  const profile = buildProfile(track), limit = Math.max(1, track.trackWidth / 2 - 24);
  return [...Array.from({length: knots}, (_, i) => classic ? referenceAt(profile, i / knots * profile.length).offset / limit : 0),
    ...Array(knots).fill(speed), ...Array(knots).fill(energy), 340, .65, .28, 2.6];
}
export function makePlan(track, parameters) {
  const knots = (parameters.length - 4) / 3, bounds = parameterBounds(knots);
  if (!Number.isInteger(knots) || knots < 4 || knots > 64 || parameters.some((x, i) => !Number.isFinite(x) || x < bounds[i][0] - 1e-8 || x > bounds[i][1] + 1e-8)) throw Error('Invalid pace search parameters');
  const profile = buildProfile(track), offsets = parameters.slice(0, knots), limit = Math.max(0, track.trackWidth / 2 - 24);
  profile.reference = profile.reference.map(p => {
    const center = centerAt(track, profile.origin + p.s), offset = schedule(offsets, p.s / profile.length) * limit;
    return {...p, offset, x: center.x - Math.sin(center.angle) * offset, y: center.y + Math.cos(center.angle) * offset};
  });
  profile.tuning = {planner: PLANNER_VERSION, parameters};
  delete profile.profileHash; profile.profileHash = hash(profile); profile.physicsHash = PHYSICS_HASH;
  const points = profile.reference, n = points.length;
  const curvature = points.map((b, i) => {
    const a = points[mod(i - 2, n)], c = points[(i + 2) % n];
    const ab = Math.hypot(b.x - a.x, b.y - a.y), bc = Math.hypot(c.x - b.x, c.y - b.y), ac = Math.hypot(c.x - a.x, c.y - a.y);
    return 2 * Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / Math.max(1, ab * bc * ac);
  });
  return {version: PLANNER_VERSION, trackId: track.id, trackFingerprint: trackFingerprint(track), physicsHash: PHYSICS_HASH,
    parameters: [...parameters], knots, profile, curvature};
}
export function speedEnvelope(plan, maxSpeed, brakeForce) {
  const n = plan.profile.reference.length, p = plan.parameters, k = plan.knots;
  const speeds = plan.curvature.map((curve, i) => Math.min(maxSpeed * schedule(p.slice(k, k * 2), i / n), Math.sqrt(p[k * 3] / Math.max(curve, 1e-6))));
  // A second circular pass propagates braking constraints across start/finish.
  for (let i = n * 2 - 1; i >= 0; i--) {
    const j = i % n, next = (j + 1) % n, a = plan.profile.reference[j], b = plan.profile.reference[next];
    speeds[j] = Math.min(speeds[j], Math.sqrt(speeds[next] ** 2 + 2 * brakeForce * p[k * 3 + 1] * Math.hypot(b.x - a.x, b.y - a.y)));
  }
  return speeds;
}
export function plannedAction(env, plan, speeds) {
  const k = env.kart, p = plan.parameters, count = plan.knots, s = env.lastG.progress - plan.profile.origin;
  const look = 35 + Math.abs(k.speed) * p[count * 3 + 2], aim = referenceAt(plan.profile, s + look);
  const turn = wrap(Math.atan2(aim.y - k.y, aim.x - k.x) - k.angle);
  const target = schedule(speeds, (s + Math.max(15, k.speed * .12)) / plan.profile.length);
  const error = target - k.speed;
  const throttle = clamp(error / 22 + .15, 0, 1), brake = clamp(-error / 45, 0, 1);
  // Deployment is a learned spatial schedule, constrained only by useful demand.
  const deployment = schedule(p.slice(count * 2, count * 3), s / plan.profile.length);
  const ers = deployment > 0 && error > -8 && brake < .05;
  return [clamp(turn * p[count * 3 + 3], -1, 1), throttle * 2 - 1, brake * 2 - 1, ers ? 1 : -1];
}
export function cleanFinish(row) {
  return row.finished === true && row.validLap === true && Number.isFinite(row.raceTime) && row.raceTime > 0 && row.offTrackRate === 0 && row.contacts === 0;
}
export function compareTrials(a, b) {
  const ac = cleanFinish(a), bc = cleanFinish(b);
  if (ac !== bc) return ac ? -1 : 1;
  if (ac) return a.raceTime - b.raceTime;
  // Only failed candidates use progress as a search aid; it can never beat a clean lap.
  return (b.validLaps?.filter(Boolean).length || 0) - (a.validLaps?.filter(Boolean).length || 0)
    || clamp(b.progress || 0, 0, b.raceLaps || 1) - clamp(a.progress || 0, 0, a.raceLaps || 1)
    || a.offTrackRate - b.offTrackRate;
}
export function nextPopulation(elites, bounds, random, size, scale = 1) {
  if (!elites.length || elites.some(e => e.length !== bounds.length)) throw Error('Missing or mismatched CEM elites');
  const mean = bounds.map((_, i) => elites.reduce((v, e) => v + e[i], 0) / elites.length);
  const spread = bounds.map(([lo, hi], i) => Math.max((hi - lo) * .025, Math.sqrt(elites.reduce((v, e) => v + (e[i] - mean[i]) ** 2, 0) / elites.length)) * scale);
  return Array.from({length: size}, () => mean.map((m, i) => clamp(m + normal(random) * spread[i], ...bounds[i])));
}
