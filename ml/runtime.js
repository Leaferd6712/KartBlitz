(function (root) {
  'use strict';

  const FORMAT = 'kartblitz-ml-v1';
  const OBSERVATIONS = [
    'speed_norm', 'lateral_norm', 'heading_sin',
    'look_near_sin', 'look_mid_sin', 'look_far_sin',
    'curvature_near', 'curvature_mid', 'curvature_far',
    'corner_demand', 'target_speed_error', 'off_track',
    'progress_delta', 'stuck'
  ];
  const OBSERVATIONS_V2 = [
    'speed_norm', 'lateral_norm', 'heading_sin', 'heading_cos',
    'look_80_sin', 'look_180_sin', 'look_360_sin', 'look_650_sin',
    'curvature_80', 'curvature_180', 'curvature_360', 'curvature_peak',
    'edge_margin', 'target_speed_error', 'off_track', 'progress_velocity',
    'yaw_rate', 'previous_steer', 'previous_throttle', 'previous_brake',
    'ers_charge', 'drs_available', 'tyre_grip', 'stuck'
  ];
  const DISCRETE_ACTIONS = [
    { up: true,  down: false, steer: -1 },
    { up: true,  down: false, steer:  0 },
    { up: true,  down: false, steer:  1 },
    { up: false, down: false, steer: -1 },
    { up: false, down: false, steer:  0 },
    { up: false, down: false, steer:  1 },
    { up: false, down: true,  steer: -1 },
    { up: false, down: true,  steer:  0 },
    { up: false, down: true,  steer:  1 }
  ];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
  const wrap = a => {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  };
  const mod = (n, m) => ((n % m) + m) % m;

  function tangentAt(spline, idx, gap) {
    const n = spline.length;
    const a = spline[mod(idx - (gap || 2), n)];
    const b = spline[mod(idx + (gap || 2), n)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len, angle: Math.atan2(dy, dx) };
  }

  function signedCurvature(spline, idx, gap) {
    const n = spline.length;
    const a = spline[mod(idx - gap, n)];
    const b = spline[idx];
    const c = spline[mod(idx + gap, n)];
    const abx = b.x - a.x, aby = b.y - a.y;
    const bcx = c.x - b.x, bcy = c.y - b.y;
    const al = Math.hypot(abx, aby) || 1;
    const bl = Math.hypot(bcx, bcy) || 1;
    return clamp((abx / al) * (bcy / bl) - (aby / al) * (bcx / bl), -1, 1);
  }

  function nearestIndex(kart, track, previous) {
    const spline = track && track.spline;
    if (!spline || !spline.length) return 0;
    const n = spline.length;
    let best = Number.isFinite(previous) ? mod(previous, n) : 0;
    let bestD = Infinity;
    const globalSearch = !Number.isFinite(previous) || previous < 0 || previous >= n;
    const start = globalSearch ? 0 : -20;
    const end = globalSearch ? n : 90;
    for (let d = start; d < end; d++) {
      const i = globalSearch ? d : mod(best + d, n);
      const p = spline[i];
      const dd = (kart.x - p.x) ** 2 + (kart.y - p.y) ** 2;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return best;
  }

  function indexAtDistance(track, startIndex, distance) {
    const spline = track.spline || [];
    const n = spline.length;
    if (!n) return 0;
    const cum = track.cum;
    const total = Number(track.totalLen) || (Array.isArray(cum) && cum.length ? Number(cum[cum.length - 1]) : 0);
    if (!cum || cum.length !== n || !total) return mod(startIndex + Math.max(1, Math.round(n * distance / Math.max(1, total || n * 18))), n);
    const target = (Number(cum[startIndex]) + distance) % total;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (Number(cum[mid]) < target) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function observe(kart, track, state) {
    state = state || {};
    const spline = track && track.spline;
    if (!kart || !spline || spline.length < 8) return new Array(OBSERVATIONS.length).fill(0);
    const n = spline.length;
    const idx = nearestIndex(kart, track, Number.isFinite(kart._nearestSplineIdx) ? kart._nearestSplineIdx : state.nearest);
    state.nearest = idx;
    const tang = tangentAt(spline, idx, 3);
    const center = spline[idx];
    const nx = -tang.y, ny = tang.x;
    const width = Math.max(30, track.trackWidth || 160);
    const lateral = ((kart.x - center.x) * nx + (kart.y - center.y) * ny) / (width * 0.5);
    const angle = Number(kart.angle) || 0;
    const lookAngle = offset => {
      const p = spline[mod(idx + offset, n)];
      return Math.sin(wrap(Math.atan2(p.y - kart.y, p.x - kart.x) - angle));
    };
    const near = Math.max(6, Math.round(n * 0.012));
    const mid = Math.max(14, Math.round(n * 0.032));
    const far = Math.max(28, Math.round(n * 0.065));
    const curvNear = signedCurvature(spline, mod(idx + near, n), Math.max(3, Math.round(near * 0.5)));
    const curvMid = signedCurvature(spline, mod(idx + mid, n), Math.max(4, Math.round(mid * 0.35)));
    const curvFar = signedCurvature(spline, mod(idx + far, n), Math.max(5, Math.round(far * 0.25)));
    const maxSpeed = Math.max(1, Number(kart.maxSpeed) || 520);
    const speedNorm = clamp(Math.abs(Number(kart.speed) || 0) / maxSpeed, 0, 1.5);
    const nearLook = lookAngle(near);
    const midLook = lookAngle(mid);
    const farLook = lookAngle(far);
    const cornerDemand = clamp(Math.max(Math.abs(nearLook), Math.abs(midLook) * 0.92, Math.abs(farLook) * 0.72,
      Math.abs(curvNear) * 1.3, Math.abs(curvMid) * 1.1) * (0.45 + speedNorm * 0.75), 0, 1.5);
    const targetSpeed = clamp(1.04 - cornerDemand * 0.78, 0.30, 1.02);
    const progress = idx / n;
    let progressDelta = 0;
    if (Number.isFinite(state.progress)) {
      progressDelta = progress - state.progress;
      if (progressDelta < -0.5) progressDelta += 1;
      if (progressDelta > 0.5) progressDelta -= 1;
    }
    state.progress = progress;
    const moved = Number.isFinite(state.x) ? Math.hypot(kart.x - state.x, kart.y - state.y) : 99;
    state.x = kart.x; state.y = kart.y;
    if (moved < 0.8 && speedNorm < 0.08) state.stuckFrames = (state.stuckFrames || 0) + 1;
    else state.stuckFrames = 0;
    return [
      speedNorm, clamp(lateral, -2, 2), Math.sin(wrap(tang.angle - angle)),
      nearLook, midLook, farLook, curvNear, curvMid, curvFar,
      cornerDemand, clamp(speedNorm - targetSpeed, -1.2, 1.2), kart.isOffTrack ? 1 : 0,
      clamp(progressDelta * n * 0.2, -1, 1), state.stuckFrames > 45 ? 1 : 0
    ];
  }

  function observeV2(kart, track, state) {
    state = state || {};
    const spline = track && track.spline;
    if (!kart || !spline || spline.length < 8) return new Array(OBSERVATIONS_V2.length).fill(0);
    const n = spline.length;
    const idx = nearestIndex(kart, track, Number.isFinite(kart._nearestSplineIdx) ? kart._nearestSplineIdx : state.nearest);
    state.nearest = idx;
    const tang = tangentAt(spline, idx, 3);
    const center = spline[idx];
    const width = Math.max(30, Number(track.trackWidth) || 160);
    const lateral = ((kart.x - center.x) * -tang.y + (kart.y - center.y) * tang.x) / (width * 0.5);
    const angle = Number(kart.angle) || 0;
    const lookDistances = [80, 180, 360, 650];
    const lookIndices = lookDistances.map(distance => indexAtDistance(track, idx, distance));
    const looks = lookIndices.map(index => {
      const p = spline[index];
      return Math.sin(wrap(Math.atan2(p.y - kart.y, p.x - kart.x) - angle));
    });
    const curvatureGap = Math.max(3, Math.round(n * 0.008));
    const curves = lookIndices.slice(0, 3).map(index => signedCurvature(spline, index, curvatureGap));
    let peak = 0;
    for (let distance = 60; distance <= 700; distance += 55) {
      const value = signedCurvature(spline, indexAtDistance(track, idx, distance), curvatureGap);
      if (Math.abs(value) > Math.abs(peak)) peak = value;
    }
    const maxSpeed = Math.max(1, Number(kart.maxSpeed) || 520);
    const speedNorm = clamp(Math.abs(Number(kart.speed) || 0) / maxSpeed, 0, 1.5);
    const cornerDemand = clamp(Math.max(Math.abs(looks[0]), Math.abs(looks[1]) * .9, Math.abs(looks[2]) * .72,
      Math.abs(curves[0]) * 1.35, Math.abs(curves[1]) * 1.15, Math.abs(peak)) * (.42 + speedNorm * .78), 0, 1.5);
    const targetSpeed = clamp(1.05 - cornerDemand * .76, .28, 1.04);
    const progress = idx / n;
    let progressDelta = 0;
    if (Number.isFinite(state.progress)) {
      progressDelta = progress - state.progress;
      if (progressDelta < -.5) progressDelta += 1;
      if (progressDelta > .5) progressDelta -= 1;
    }
    state.progress = progress;
    const moved = Number.isFinite(state.x) ? Math.hypot(kart.x - state.x, kart.y - state.y) : 99;
    state.x = kart.x; state.y = kart.y;
    if (moved < .7 && speedNorm < .08) state.stuckFrames = (state.stuckFrames || 0) + 1;
    else state.stuckFrames = Math.max(0, (state.stuckFrames || 0) - 2);
    let yawRate = 0;
    if (Number.isFinite(state.angle)) yawRate = clamp(wrap(angle - state.angle) / .11, -1.5, 1.5);
    state.angle = angle;
    const headingError = wrap(tang.angle - angle);
    const tyreGrip = Number.isFinite(kart.tyreGripPct) ? kart.tyreGripPct : (Number.isFinite(kart.grip) ? kart.grip : 1);
    return [
      speedNorm, clamp(lateral, -2.5, 2.5), Math.sin(headingError), Math.cos(headingError),
      looks[0], looks[1], looks[2], looks[3], curves[0], curves[1], curves[2], peak,
      clamp(1 - Math.abs(lateral), -1.5, 1), clamp(speedNorm - targetSpeed, -1.2, 1.2), kart.isOffTrack ? 1 : 0,
      clamp(progressDelta * n * .2, -1.5, 1.5), yawRate,
      clamp(state.previousSteer || 0, -1, 1), clamp(state.previousThrottle || 0, 0, 1), clamp(state.previousBrake || 0, 0, 1),
      clamp(Number(kart.ersCharge) || 0, 0, 1), kart.drsAvailable && kart.drsInZone ? 1 : 0,
      clamp(tyreGrip, 0, 1.5), state.stuckFrames > 45 ? 1 : 0
    ];
  }

  function validateModel(model) {
    if (!model || model.format !== FORMAT) throw new Error('Not a KartBlitz ML model.');
    const names = model.observationVersion === 2 ? OBSERVATIONS_V2 : OBSERVATIONS;
    if (![1, 2].includes(model.observationVersion) || model.observationCount !== names.length) {
      throw new Error('This model uses an incompatible sensor format.');
    }
    if (!model.policy || !Array.isArray(model.policy.layers) || !model.policy.layers.length) {
      throw new Error('Model weights are missing.');
    }
    let inputs = names.length;
    model.policy.layers.forEach((layer, index) => {
      if (!Array.isArray(layer.kernel) || !Array.isArray(layer.bias) || layer.kernel.length !== layer.bias.length) {
        throw new Error(`Invalid weights in layer ${index + 1}.`);
      }
      layer.kernel.forEach(row => {
        if (!Array.isArray(row) || row.length !== inputs || row.some(v => !Number.isFinite(v))) {
          throw new Error(`Invalid weight shape in layer ${index + 1}.`);
        }
      });
      if (layer.bias.some(v => !Number.isFinite(v))) throw new Error(`Invalid bias in layer ${index + 1}.`);
      inputs = layer.bias.length;
    });
    if (!['discrete-9', 'continuous-3', 'continuous-3-v2'].includes(model.actionSpace)) {
      throw new Error('This model uses an incompatible action space.');
    }
    const expected = model.actionSpace === 'discrete-9' ? 9 : 3;
    if (inputs !== expected) throw new Error(`Expected ${expected} outputs, found ${inputs}.`);
    return true;
  }

  function forward(model, input) {
    validateModel(model);
    let values = input.slice();
    const layers = model.policy.layers;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const out = layer.kernel.map((row, r) => row.reduce((sum, w, c) => sum + w * values[c], layer.bias[r] || 0));
      values = li === layers.length - 1 ? out : out.map(v => Math.tanh(v));
    }
    return values;
  }

  function outputsToInput(model, outputs, kart, state) {
    let result;
    if (model.actionSpace === 'discrete-9') {
      let best = 0;
      for (let i = 1; i < outputs.length; i++) if (outputs[i] > outputs[best]) best = i;
      result = Object.assign({}, DISCRETE_ACTIONS[best]);
    } else if (model.actionSpace === 'continuous-3-v2') {
      const targetSteer = Math.tanh(outputs[0] || 0);
      let targetThrottle = (Math.tanh(outputs[1] || 0) + 1) * .5;
      let targetBrake = (Math.tanh(outputs[2] || 0) + 1) * .5;
      if (targetBrake > .12) targetThrottle *= Math.max(0, 1 - targetBrake * 1.35);
      if (targetBrake < .045) targetBrake = 0;
      state = state || {};
      const steer = (state.previousSteer || 0) + (targetSteer - (state.previousSteer || 0)) * .42;
      const throttle = (state.previousThrottle || 0) + (targetThrottle - (state.previousThrottle || 0)) * .34;
      const brake = (state.previousBrake || 0) + (targetBrake - (state.previousBrake || 0)) * .46;
      state.previousSteer = steer; state.previousThrottle = throttle; state.previousBrake = brake;
      result = { up: throttle > .12, down: brake > .12, steer, throttle, brake };
    } else {
      const steer = Math.tanh(outputs[0] || 0);
      const throttle = 1 / (1 + Math.exp(-(outputs[1] || 0)));
      const brake = 1 / (1 + Math.exp(-(outputs[2] || 0)));
      result = { up: throttle >= 0.47 && brake < 0.62, down: brake >= 0.58, steer };
    }
    result.left = result.steer < -0.12;
    result.right = result.steer > 0.12;
    result.ers = !!(kart && kart.ersCharge > 0.12 && !kart.isOffTrack && Math.abs(result.steer) < 0.18 && result.up);
    result.drs = !!(kart && kart.drsAvailable && kart.drsInZone && Math.abs(result.steer) < 0.14 && result.up);
    result.pit = false;
    return result;
  }

  function makeController(track, model) {
    validateModel(model);
    let kart = null;
    const state = {};
    return {
      fn: function () {
        if (!kart) return { up: false, down: false, left: false, right: false, steer: 0, ers: false, drs: false };
        const obs = model.observationVersion === 2 ? observeV2(kart, track, state) : observe(kart, track, state);
        return outputsToInput(model, forward(model, obs), kart, state);
      },
      set: function (value) {
        kart = value;
        if (kart) {
          kart._mlDriver = true;
          kart.mlModelName = model.name || 'ML Driver';
          kart.mlModelId = model.id || 'unknown';
        }
      }
    };
  }

  const baselineKernel = [
    [0, -1.55, 1.20, 2.00, 1.15, 0.45, 0.30, 0.18, 0.08, 0, 0, -0.35, 0, 0],
    [-0.50, 0, 0, 0, 0, 0, 0, 0, 0, -1.80, -4.80, -0.80, 0.2, 1.5],
    [0.10, 0, 0, 0, 0, 0, 0, 0, 0, 1.70, 7.50, -0.20, -0.1, -1.0]
  ];
  const DEFAULT_MODEL = {
    format: FORMAT,
    formatVersion: 1,
    id: 'kartblitz-our-model-v1',
    name: 'KartBlitz Apex V1',
    source: 'ours',
    description: 'A track-relative baseline tuned across the complete KartBlitz circuit pack.',
    observationVersion: 1,
    observationCount: OBSERVATIONS.length,
    observationNames: OBSERVATIONS.slice(),
    actionSpace: 'continuous-3',
    policy: { activation: 'tanh', layers: [{ kernel: baselineKernel, bias: [0, 3.0, -3.2] }] },
    training: { tracks: 'all', algorithm: 'pre-tuned-linear-policy', device: 'developer baseline' },
    evaluation: { status: 'baseline', note: 'Run the validation suite before marking a release model high-speed certified.' }
  };

  root.KartBlitzMLRuntime = {
    FORMAT, OBSERVATIONS, OBSERVATIONS_V2, DISCRETE_ACTIONS, DEFAULT_MODEL,
    validateModel, observe, observeV2, forward, outputsToInput, makeController,
    nearestIndex, indexAtDistance, signedCurvature
  };
})(typeof window !== 'undefined' ? window : globalThis);
