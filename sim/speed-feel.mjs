/**
 * KartBlitz speed sensation — visual/audio cues only.
 * Does not change handling, max speed, or acceleration.
 *
 * Each effect has its own tuner block so they can be dialed independently.
 */

export const SPEED_FEEL = Object.freeze({
  fov: Object.freeze({
    enabled: true,
    // Slightly tighter framing so the kart reads larger at rest.
    baseZoom: 1.17,
    // High-speed FOV: pull back from rest (still a hair tighter than 1:1).
    speedZoom: 1.05,
    startRatio: 0.25,
    fullRatio: 0.92,
    follow: 8,
  }),
  shake: Object.freeze({
    enabled: true,
    startRatio: 0.90,
    fullRatio: 1.08,
    maxPx: 1.15,
    freqX: 19.7,
    freqY: 16.3,
  }),
  streaks: Object.freeze({
    enabled: true,
    startRatio: 0.38,
    fullRatio: 0.90,
    poolSize: 22,
    // Center ellipse kept clear of streaks (fraction of half-axes).
    clearRadius: 0.50,
    minLen: 12,
    maxLen: 46,
    minSpd: 240,
    maxSpd: 520,
    life: 0.34,
  }),
  spray: Object.freeze({
    enabled: true,
    startRatio: 0.30,
    fullRatio: 0.82,
    interval: 0.075,
    count: 2,
  }),
  camNudge: Object.freeze({
    enabled: true,
    accel: 20,
    brake: -26,
    follow: 7,
  }),
  engine: Object.freeze({
    idleHz: 58,
    gearCount: 5,
    gearStepHz: 38,
    gearClimbHz: 96,
    maxHz: 445,
    throttleBoostHz: 26,
    brakeCutHz: 16,
    idleFilter: 280,
    maxFilter: 2150,
    idleGain: 0.0046,
    maxGain: 0.024,
    throttleGain: 0.011,
  }),
});

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function speedRatio(speed, maxSpeed) {
  return Math.abs(Number(speed) || 0) / Math.max(1, Number(maxSpeed) || 1);
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function targetZoom(ratio, reducedMotion, cfg = SPEED_FEEL.fov) {
  if (!cfg.enabled) return 1;
  if (reducedMotion) return cfg.baseZoom;
  const t = smoothstep(cfg.startRatio, cfg.fullRatio, ratio);
  return cfg.baseZoom + (cfg.speedZoom - cfg.baseZoom) * t;
}

export function shakeAmp(ratio, allowed, qualityMul, cfg = SPEED_FEEL.shake) {
  if (!cfg.enabled || !allowed) return 0;
  const t = smoothstep(cfg.startRatio, cfg.fullRatio, ratio);
  return t * cfg.maxPx * (qualityMul == null ? 1 : qualityMul);
}

export function streakIntensity(ratio, reducedMotion, cfg = SPEED_FEEL.streaks) {
  if (!cfg.enabled || reducedMotion) return 0;
  return smoothstep(cfg.startRatio, cfg.fullRatio, ratio);
}

export function sprayIntensity(ratio, reducedMotion, cfg = SPEED_FEEL.spray) {
  if (!cfg.enabled || reducedMotion) return 0;
  return smoothstep(cfg.startRatio, cfg.fullRatio, ratio);
}

export function camLookNudge(throttle, brake, reducedMotion, cfg = SPEED_FEEL.camNudge) {
  if (!cfg.enabled || reducedMotion) return 0;
  if (brake) return cfg.brake;
  if (throttle) return cfg.accel;
  return 0;
}

export function engineVoice(opts, cfg = SPEED_FEEL.engine) {
  const r = Math.max(0, Math.min(1.12, opts.speedRatio || 0));
  const gears = Math.max(1, cfg.gearCount | 0);
  const span = 1 / gears;
  const g = Math.min(gears - 1, Math.floor(r / span + 1e-6));
  const u = clamp01((r - g * span) / span);
  const rpm = Math.pow(u, 0.82);
  let hz = cfg.idleHz + g * cfg.gearStepHz + rpm * cfg.gearClimbHz;
  if (opts.throttle) hz += cfg.throttleBoostHz * (0.45 + rpm * 0.55);
  if (opts.braking) hz -= cfg.brakeCutHz;
  hz = Math.max(cfg.idleHz * 0.85, Math.min(cfg.maxHz, hz));
  const load = clamp01(rpm * 0.72 + (opts.throttle ? 0.28 : 0) + r * 0.12);
  const filter = cfg.idleFilter + load * (cfg.maxFilter - cfg.idleFilter);
  let gain = cfg.idleGain + load * (cfg.maxGain - cfg.idleGain);
  if (opts.throttle) gain += cfg.throttleGain;
  if (!opts.throttle && r < 0.05) gain = cfg.idleGain * 0.72;
  return { hz, filter, gain, gear: g, rpm };
}

export function isPeripheral(x, y, viewW, viewH, clearRadius) {
  const w = Math.max(1, viewW);
  const h = Math.max(1, viewH);
  const nx = (x / w) * 2 - 1;
  const ny = (y / h) * 2 - 1;
  const cr = clearRadius == null ? SPEED_FEEL.streaks.clearRadius : clearRadius;
  return nx * nx + ny * ny >= cr * cr;
}

export function pickPeripheralPoint(viewW, viewH, clearRadius, rng) {
  const rand = rng || Math.random;
  const cr = clearRadius == null ? SPEED_FEEL.streaks.clearRadius : clearRadius;
  for (let i = 0; i < 10; i++) {
    const x = rand() * viewW;
    const y = rand() * viewH;
    if (isPeripheral(x, y, viewW, viewH, cr)) return { x, y };
  }
  const edge = rand();
  if (edge < 0.25) return { x: rand() * viewW * 0.12, y: rand() * viewH };
  if (edge < 0.5) return { x: viewW * (0.88 + rand() * 0.12), y: rand() * viewH };
  if (edge < 0.75) return { x: rand() * viewW, y: rand() * viewH * 0.12 };
  return { x: rand() * viewW, y: viewH * (0.88 + rand() * 0.12) };
}

function makeStreakSlot() {
  return {
    active: false,
    x: 0,
    y: 0,
    len: 12,
    spd: 300,
    life: 0,
    maxLife: 1,
    w: 1.2,
    ang: 0,
    alpha: 0.2,
  };
}

export function createSlot() {
  const streaks = [];
  const n = SPEED_FEEL.streaks.poolSize;
  for (let i = 0; i < n; i++) streaks.push(makeStreakSlot());
  return {
    zoom: SPEED_FEEL.fov.baseZoom,
    shakeX: 0,
    shakeY: 0,
    lookNudge: 0,
    time: 0,
    intensity: 0,
    streaks,
  };
}

export function resetSlot(slot, opts) {
  if (!slot) return slot;
  const keepZoom = !!(opts && opts.keepZoom);
  if (!keepZoom) slot.zoom = SPEED_FEEL.fov.baseZoom;
  slot.shakeX = 0;
  slot.shakeY = 0;
  if (!keepZoom) slot.lookNudge = 0;
  slot.time = 0;
  slot.intensity = 0;
  for (let i = 0; i < slot.streaks.length; i++) slot.streaks[i].active = false;
  return slot;
}

function followLerp(dt, rate) {
  return 1 - Math.pow(0.5, Math.max(0, dt) * Math.max(0, rate));
}

export function tickDynamics(slot, opts) {
  if (!slot) return 0;
  const dt = Math.max(0, Math.min(0.05, opts.dt || 0.016));
  slot.time += dt;
  const ratio = speedRatio(opts.speed, opts.maxSpeed);
  const zT = targetZoom(ratio, !!opts.reducedMotion);
  slot.zoom += (zT - slot.zoom) * followLerp(dt, SPEED_FEEL.fov.follow);

  const amp = shakeAmp(ratio, !!opts.shakeAllowed, opts.shakeMul);
  slot.shakeX = Math.sin(slot.time * SPEED_FEEL.shake.freqX) * amp;
  slot.shakeY = Math.cos(slot.time * SPEED_FEEL.shake.freqY * 1.13) * amp * 0.72;

  const nT = camLookNudge(!!opts.throttle, !!opts.brake, !!opts.reducedMotion);
  slot.lookNudge += (nT - slot.lookNudge) * followLerp(dt, SPEED_FEEL.camNudge.follow);
  slot.intensity = streakIntensity(ratio, !!opts.reducedMotion);
  return ratio;
}

export function tickStreaks(slot, opts) {
  if (!slot) return;
  const cfg = SPEED_FEEL.streaks;
  const dt = Math.max(0, Math.min(0.05, opts.dt || 0.016));
  const viewW = Math.max(1, opts.viewW || 1280);
  const viewH = Math.max(1, opts.viewH || 720);
  const ratio = speedRatio(opts.speed, opts.maxSpeed);
  const inten = streakIntensity(ratio, !!opts.reducedMotion, cfg);
  slot.intensity = inten;
  const ang = (opts.angle || 0) + Math.PI;
  const rng = opts.rng || Math.random;
  const trailLines = opts.trailLines == null ? 8 : opts.trailLines;

  let active = 0;
  for (let i = 0; i < slot.streaks.length; i++) {
    const s = slot.streaks[i];
    if (!s.active) continue;
    s.x += Math.cos(s.ang) * s.spd * dt;
    s.y += Math.sin(s.ang) * s.spd * dt;
    s.life -= dt;
    if (s.life <= 0 || s.x < -50 || s.y < -50 || s.x > viewW + 50 || s.y > viewH + 50) {
      s.active = false;
    } else {
      active++;
    }
  }

  if (inten <= 0.01) return;

  const want = Math.max(0, Math.min(cfg.poolSize, Math.round(trailLines * (0.4 + inten * 0.85))));
  const alphaMul = opts.speedLineAlpha == null ? 0.32 : opts.speedLineAlpha;
  while (active < want) {
    let s = null;
    for (let i = 0; i < slot.streaks.length; i++) {
      if (!slot.streaks[i].active) { s = slot.streaks[i]; break; }
    }
    if (!s) break;
    const pt = pickPeripheralPoint(viewW, viewH, cfg.clearRadius, rng);
    s.active = true;
    s.x = pt.x;
    s.y = pt.y;
    s.ang = ang;
    s.len = cfg.minLen + rng() * (cfg.maxLen - cfg.minLen) * (0.55 + inten * 0.45);
    s.spd = cfg.minSpd + rng() * (cfg.maxSpd - cfg.minSpd);
    s.maxLife = cfg.life * (0.7 + rng() * 0.6);
    s.life = s.maxLife;
    s.w = 1 + rng() * 1.15;
    s.alpha = (0.28 + inten * 0.7) * Math.max(0.28, alphaMul);
    active++;
  }
}

export function countActiveStreaks(slot) {
  if (!slot || !slot.streaks) return 0;
  let n = 0;
  for (let i = 0; i < slot.streaks.length; i++) if (slot.streaks[i].active) n++;
  return n;
}

export function slotDiagnostics(slot) {
  if (!slot) return null;
  return {
    zoom: slot.zoom,
    shakeX: slot.shakeX,
    shakeY: slot.shakeY,
    lookNudge: slot.lookNudge,
    intensity: slot.intensity,
    activeStreaks: countActiveStreaks(slot),
  };
}
