/**
 * Shared KartBlitz RL / IL environment — observation, actions, reward, step.
 * Used by rl-train.mjs, ml-env-server.mjs, and browser training lab.
 */

export const ACTIONS = [
  { name: "thr-L", up: true, down: false, left: true, right: false },
  { name: "thr", up: true, down: false, left: false, right: false },
  { name: "thr-R", up: true, down: false, left: false, right: true },
  { name: "coast-L", up: false, down: false, left: true, right: false },
  { name: "coast", up: false, down: false, left: false, right: false },
  { name: "coast-R", up: false, down: false, left: false, right: true },
  { name: "brk-L", up: false, down: true, left: true, right: false },
  { name: "brk", up: false, down: true, left: false, right: false },
  { name: "brk-R", up: false, down: true, left: false, right: true },
];

export const N_ACT = ACTIONS.length;
export const N_OBS = 10;

export const OBS_LABELS = [
  "speed_norm",
  "lateral_error",
  "heading_sin",
  "heading_cos",
  "curvature_now",
  "curvature_40",
  "curvature_80",
  "curvature_160",
  "off_track",
  "lap_progress",
];

export function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function idxAhead(track, startIdx, dist) {
  const { cum, totalLen } = track;
  const n = track.spline.length;
  let target = cum[startIdx] + dist;
  if (target >= totalLen) target -= totalLen;
  const lo0 = target < cum[startIdx] ? 0 : startIdx;
  let lo = lo0;
  let hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function precomputeCurvature(track) {
  const spl = track.spline;
  const n = spl.length;
  const curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = spl[(i - 5 + n) % n];
    const c = spl[i];
    const nx = spl[(i + 5) % n];
    const dx1 = c.x - p.x;
    const dy1 = c.y - p.y;
    const dx2 = nx.x - c.x;
    const dy2 = nx.y - c.y;
    const l1 = Math.hypot(dx1, dy1) || 1;
    const l2 = Math.hypot(dx2, dy2) || 1;
    curv[i] = Math.abs((dx1 / l1) * (dy2 / l2) - (dy1 / l1) * (dx2 / l2));
  }
  return curv;
}

export function observe(kart, track, curv) {
  const spl = track.spline;
  const n = spl.length;
  const idx = ((kart._nearestSplineIdx || 0) % n + n) % n;
  const p = spl[idx];
  const nxt = spl[(idx + 1) % n];
  const tx = nxt.x - p.x;
  const ty = nxt.y - p.y;
  const tlen = Math.hypot(tx, ty) || 1;
  const tangX = tx / tlen;
  const tangY = ty / tlen;
  const halfW = track.trackWidth * 0.5;
  const lat = (kart.x - p.x) * -tangY + (kart.y - p.y) * tangX;
  const head = wrapPi(kart.angle - Math.atan2(tangY, tangX));
  const i40 = idxAhead(track, idx, 40);
  const i80 = idxAhead(track, idx, 80);
  const i160 = idxAhead(track, idx, 160);
  const maxSpd = kart.maxSpeed || 200;
  return [
    Math.max(-1, Math.min(1, kart.speed / Math.max(1, maxSpd))),
    Math.max(-1.5, Math.min(1.5, lat / Math.max(1, halfW))),
    Math.sin(head),
    Math.cos(head),
    Math.max(0, Math.min(1, curv[idx] * 4)),
    Math.max(0, Math.min(1, curv[i40] * 4)),
    Math.max(0, Math.min(1, curv[i80] * 4)),
    Math.max(0, Math.min(1, curv[i160] * 4)),
    kart.isOffTrack ? 1 : 0,
    (track.cum[idx] || 0) / Math.max(1, track.totalLen),
  ];
}

export function progressAlong(kart, track) {
  const idx = kart._nearestSplineIdx || 0;
  const lap = kart.lap || 0;
  return lap * track.totalLen + (track.cum[idx] || 0);
}

export function actionToInput(actionIdx, Sim) {
  const a = ACTIONS[actionIdx];
  const inp = Sim.emptyInput();
  inp.up = a.up;
  inp.down = a.down;
  inp.left = a.left;
  inp.right = a.right;
  inp.throttle = a.up ? 1 : 0;
  inp.brake = a.down ? 1 : 0;
  inp.steer = a.left ? -1 : a.right ? 1 : 0;
  return inp;
}

/** Map digital inputs to nearest discrete action index (for demo recording). */
export function inputsToAction(inputs) {
  const up = !!inputs.up;
  const down = !!inputs.down;
  const left = !!inputs.left;
  const right = !!inputs.right;
  for (let i = 0; i < ACTIONS.length; i++) {
    const a = ACTIONS[i];
    if (a.up === up && a.down === down && a.left === left && a.right === right) return i;
  }
  if (down) {
    if (left) return 6;
    if (right) return 8;
    return 7;
  }
  if (up) {
    if (left) return 0;
    if (right) return 2;
    return 1;
  }
  if (left) return 3;
  if (right) return 5;
  return 4;
}

export function computeStepReward(kart, track, obs, dProg, moved, dt) {
  let r = dProg * 0.035 - 0.012;
  if (kart.isOffTrack) r -= 0.35;
  if (kart._isCompletelyOff) r -= 0.55;
  if (obs[3] < 0) r -= 0.08;
  if (kart.finished || (kart.lap || 0) >= 1) r += 8;
  return r;
}

export function makeKart(Sim, track, opts = {}) {
  return Sim.createKart({
    id: opts.id ?? 0,
    x: track.startPos.x,
    y: track.startPos.y,
    angle: track.startAngle,
    weather: opts.weather ?? "dry",
    tyreId: opts.tyreId ?? "med",
    totalLaps: opts.totalLaps ?? 1,
    upgrades: opts.upgrades ?? Sim.defaultUpgrades(),
  });
}

/**
 * Gym-like environment wrapper around OnlineSim physics.
 */
export class KartBlitzEnv {
  constructor(Sim, trackId, opts = {}) {
    this.Sim = Sim;
    this.trackId = trackId;
    this.track = Sim.loadTrackBake(trackId);
    if (!this.track) throw new Error(`Track ${trackId} not found`);
    this.curv = precomputeCurvature(this.track);
    this.dt = Sim.FIXED_DT;
    this.maxSteps = opts.maxSteps ?? Math.round(18 / this.dt);
    this.kartOpts = opts.kartOpts ?? {};
    this.reset();
  }

  reset() {
    this.kart = makeKart(this.Sim, this.track, this.kartOpts);
    this.others = [];
    this.stepCount = 0;
    this.lastProg = progressAlong(this.kart, this.track);
    this.stuck = 0;
    this.lastX = this.kart.x;
    this.lastY = this.kart.y;
    this.done = false;
    this.info = {};
    return this.getObs();
  }

  getObs() {
    return observe(this.kart, this.track, this.curv);
  }

  step(actionIdx) {
    if (this.done) return { obs: this.getObs(), reward: 0, done: true, info: this.info };

    const inp = actionToInput(actionIdx, this.Sim);
    this.Sim.stepKart(this.kart, inp, this.dt, this.track, this.others, {
      contact: false,
      nowMs: this.stepCount * this.dt * 1000,
      resolveCollisions: false,
    });

    const obs = this.getObs();
    const prog = progressAlong(this.kart, this.track);
    let dProg = prog - this.lastProg;
    if (dProg < -this.track.totalLen * 0.5) dProg += this.track.totalLen;
    if (dProg > this.track.totalLen * 0.5) dProg -= this.track.totalLen;
    this.lastProg = prog;

    const moved = Math.hypot(this.kart.x - this.lastX, this.kart.y - this.lastY);
    this.lastX = this.kart.x;
    this.lastY = this.kart.y;
    if (moved < 2.5) this.stuck += this.dt;
    else this.stuck = 0;

    let reward = computeStepReward(this.kart, this.track, obs, dProg, moved, this.dt);
    this.stepCount++;

    this.done =
      !!this.kart.finished ||
      (this.kart.lap || 0) >= 1 ||
      this.stepCount >= this.maxSteps ||
      this.stuck > 1.6;

    if (this.stuck > 1.6) reward -= 4;

    this.info = {
      progress: prog,
      lapFrac: prog / this.track.totalLen,
      finished: !!this.kart.finished,
      offTrack: !!this.kart.isOffTrack,
      step: this.stepCount,
    };

    return { obs, reward, done: this.done, info: this.info };
  }
}

export function createEnv(Sim, trackId, opts = {}) {
  return new KartBlitzEnv(Sim, trackId, opts);
}
