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

  function validateModel(model) {
    if (!model || model.format !== FORMAT) throw new Error('Not a KartBlitz ML model.');
    if (model.observationVersion !== 1 || model.observationCount !== OBSERVATIONS.length) {
      throw new Error('This model uses an incompatible sensor format.');
    }
    if (!model.policy || !Array.isArray(model.policy.layers) || !model.policy.layers.length) {
      throw new Error('Model weights are missing.');
    }
    let inputs = OBSERVATIONS.length;
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

  function outputsToInput(model, outputs, kart) {
    let result;
    if (model.actionSpace === 'discrete-9') {
      let best = 0;
      for (let i = 1; i < outputs.length; i++) if (outputs[i] > outputs[best]) best = i;
      result = Object.assign({}, DISCRETE_ACTIONS[best]);
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
        const obs = observe(kart, track, state);
        return outputsToInput(model, forward(model, obs), kart);
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
    FORMAT, OBSERVATIONS, DISCRETE_ACTIONS, DEFAULT_MODEL,
    validateModel, observe, forward, outputsToInput, makeController,
    nearestIndex, signedCurvature
  };
})(typeof window !== 'undefined' ? window : globalThis);
