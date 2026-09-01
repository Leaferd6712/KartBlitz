/**
 * Browser-friendly RL env helpers for training.html (no ES modules — works on file://).
 */
(function (global) {
  const ACTIONS = [
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
  const N_ACT = ACTIONS.length;
  const N_OBS = 10;

  function wrapPi(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function idxAhead(track, startIdx, dist) {
    const cum = track.cum;
    const totalLen = track.totalLen;
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

  function precomputeCurvature(track) {
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

  function observe(kart, track, curv) {
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

  function progressAlong(kart, track) {
    const idx = kart._nearestSplineIdx || 0;
    const lap = kart.lap || 0;
    return lap * track.totalLen + (track.cum[idx] || 0);
  }

  function actionToInput(actionIdx, Sim) {
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

  function inputsToAction(inputs) {
    const up = !!inputs.up;
    const down = !!inputs.down;
    const left = !!inputs.left;
    const right = !!inputs.right;
    for (let i = 0; i < ACTIONS.length; i++) {
      const a = ACTIONS[i];
      if (a.up === up && a.down === down && a.left === left && a.right === right) return i;
    }
    if (down) return left ? 6 : right ? 8 : 7;
    if (up) return left ? 0 : right ? 2 : 1;
    if (left) return 3;
    if (right) return 5;
    return 4;
  }

  function makeKart(Sim, track, opts) {
    opts = opts || {};
    return Sim.createKart({
      id: opts.id != null ? opts.id : 0,
      x: track.startPos.x,
      y: track.startPos.y,
      angle: track.startAngle,
      weather: opts.weather || "dry",
      tyreId: opts.tyreId || "med",
      totalLaps: opts.totalLaps != null ? opts.totalLaps : 1,
      upgrades: opts.upgrades || Sim.defaultUpgrades(),
    });
  }

  global.KartBlitzTrainingEnv = {
    ACTIONS,
    N_ACT,
    N_OBS,
    precomputeCurvature,
    observe,
    progressAlong,
    actionToInput,
    inputsToAction,
    makeKart,
  };
})(typeof window !== "undefined" ? window : globalThis);
