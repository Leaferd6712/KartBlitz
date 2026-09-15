/**
 * Persistent Time Trial PB ghosts — pack/unpack for player save.
 * Reuses in-race frame shape { t, x, y, a }; storage is quantized + capped.
 *
 * Size estimate (per track, typical 40–50s lap):
 *   raw session ghost @30Hz ≈ 1200 frames × ~60B JSON ≈ 70KB
 *   packed (max 160 frames, quantized ints) ≈ 2.5–4.5KB JSON
 *   8 tracks worst case ≈ 20–36KB total in localStorage
 */

export const PB_GHOST_SCHEMA = 1;
export const PB_GHOST_MAX_FRAMES = 160;
export const PB_GHOST_MIN_FRAMES = 8;
export const LEADERBOARD_GHOST_MAX_FRAMES = 2400;

/**
 * Evenly resample frames along time to at most maxFrames.
 * @param {{t:number,x:number,y:number,a:number}[]} frames
 */
export function resampleGhostFrames(frames, maxFrames = PB_GHOST_MAX_FRAMES) {
  if (!Array.isArray(frames) || frames.length < 2) return [];
  const sorted = frames
    .filter((f) => f && Number.isFinite(f.t) && Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.a))
    .slice()
    .sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return [];
  if (sorted.length <= maxFrames) return sorted.map((f) => ({ t: f.t, x: f.x, y: f.y, a: f.a }));

  const out = [];
  const t0 = sorted[0].t;
  const t1 = sorted[sorted.length - 1].t;
  const span = Math.max(0.001, t1 - t0);
  let src = 0;
  for (let i = 0; i < maxFrames; i++) {
    const targetT = t0 + (span * i) / (maxFrames - 1);
    while (src < sorted.length - 2 && sorted[src + 1].t < targetT) src += 1;
    const a = sorted[src];
    const b = sorted[Math.min(src + 1, sorted.length - 1)];
    const dt = b.t - a.t;
    const u = dt > 1e-6 ? (targetT - a.t) / dt : 0;
    const ang = lerpAngle(a.a, b.a, u);
    out.push({
      t: targetT,
      x: a.x + (b.x - a.x) * u,
      y: a.y + (b.y - a.y) * u,
      a: ang,
    });
  }
  return out;
}

function lerpAngle(a0, a1, u) {
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a0 + d * u;
}

/**
 * Pack frames for localStorage / cloud save.
 * @returns {object|null}
 */
export function packPbGhost(frames, meta = {}) {
  const sampled = resampleGhostFrames(frames, meta.maxFrames || PB_GHOST_MAX_FRAMES);
  if (sampled.length < PB_GHOST_MIN_FRAMES) return null;
  const lapTime = Number(meta.lapTime);
  if (!Number.isFinite(lapTime) || lapTime <= 0 || lapTime > 600) return null;
  const trackId = meta.trackId;
  if (trackId == null) return null;

  const d = new Array(sampled.length * 4);
  for (let i = 0; i < sampled.length; i++) {
    const f = sampled[i];
    const o = i * 4;
    d[o] = Math.round(f.t * 1000);
    d[o + 1] = Math.round(f.x * 10);
    d[o + 2] = Math.round(f.y * 10);
    d[o + 3] = Math.round(f.a * 1000);
  }
  return {
    v: PB_GHOST_SCHEMA,
    trackId: Number(trackId),
    lapTime: Math.round(lapTime * 1000) / 1000,
    n: sampled.length,
    d,
  };
}

/**
 * Unpack to in-race ghost frames. Returns null if corrupt.
 */
export function unpackPbGhost(packed) {
  if (!packed || typeof packed !== 'object') return null;
  if (Number(packed.v) !== PB_GHOST_SCHEMA) return null;
  const n = Math.floor(Number(packed.n) || 0);
  const d = packed.d;
  if (!Array.isArray(d) || n < PB_GHOST_MIN_FRAMES || d.length < n * 4) return null;
  if (n > PB_GHOST_MAX_FRAMES + 8) return null;
  const frames = [];
  let prevT = -1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const t = Number(d[o]) / 1000;
    const x = Number(d[o + 1]) / 10;
    const y = Number(d[o + 2]) / 10;
    const a = Number(d[o + 3]) / 1000;
    if (![t, x, y, a].every(Number.isFinite)) return null;
    if (t < prevT) return null;
    prevT = t;
    frames.push({ t, x, y, a });
  }
  const lapTime = Number(packed.lapTime);
  if (!Number.isFinite(lapTime) || lapTime <= 0) return null;
  return { frames, lapTime, trackId: packed.trackId, packed };
}

export function estimatePackedGhostBytes(packed) {
  if (!packed) return 0;
  try {
    return JSON.stringify(packed).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Whether a newly completed lap should replace the stored PB ghost.
 * Requires valid lap flag + strictly better (or first) time + usable frames.
 */
export function shouldReplacePbGhost(existingPacked, nextLapTime, nextFrames, lapValid) {
  if (!lapValid) return false;
  if (!Number.isFinite(nextLapTime) || nextLapTime <= 0 || nextLapTime >= Infinity) return false;
  if (!Array.isArray(nextFrames) || nextFrames.length < PB_GHOST_MIN_FRAMES) return false;
  if (!existingPacked) return true;
  const prev = unpackPbGhost(existingPacked);
  if (!prev) return true; // corrupt → allow replace
  return nextLapTime < prev.lapTime;
}

export function normalizePbGhostStore(raw) {
  const out = { enabled: true, tracks: {} };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  const src = raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : raw;
  for (const key of Object.keys(src)) {
    if (key === 'enabled' || key === 'tracks') continue;
    const packed = src[key];
    const unpacked = unpackPbGhost(packed);
    if (unpacked) out.tracks[String(unpacked.trackId != null ? unpacked.trackId : key)] = packed;
  }
  return out;
}

export function getStoredPbGhost(store, trackId) {
  const s = normalizePbGhostStore(store);
  const packed = s.tracks[String(trackId)];
  return unpackPbGhost(packed);
}

export function putPbGhost(store, packed) {
  const s = normalizePbGhostStore(store);
  if (!packed || packed.trackId == null) return s;
  const ok = unpackPbGhost(packed);
  if (!ok) return s;
  s.tracks[String(packed.trackId)] = packed;
  return s;
}

/** Validate and unpack a public server-generated top-10 ghost. */
export function unpackLeaderboardGhost(raw) {
  if (!raw || Number(raw.v) !== 1 || !Array.isArray(raw.frames)) return null;
  if (raw.frames.length < PB_GHOST_MIN_FRAMES || raw.frames.length > LEADERBOARD_GHOST_MAX_FRAMES) return null;
  const trackId = Number(raw.trackId), lapTime = Number(raw.lapTime);
  if (!Number.isInteger(trackId) || trackId < 0 || !Number.isFinite(lapTime) || lapTime <= 0 || lapTime > 600) return null;
  let previousT = -1;
  const frames = [];
  const samples = [];
  for (const packed of raw.frames) {
    if (!Array.isArray(packed) || packed.length < 10 || packed.slice(0, 10).some(value => !Number.isFinite(Number(value)))) return null;
    const t = Number(packed[0]) / 1000;
    if (t < previousT || t > lapTime + 1) return null;
    previousT = t;
    const flags = Number(packed[5]) & 0xff;
    frames.push({ t, x: Number(packed[1]) / 10, y: Number(packed[2]) / 10, a: Number(packed[3]) / 1000 });
    samples.push({
      t,
      x: Number(packed[1]) / 10,
      y: Number(packed[2]) / 10,
      a: Number(packed[3]) / 1000,
      speed: Number(packed[4]) / 10,
      flags,
      offTrack: !!Number(packed[6]),
      ersCharge: Number(packed[7]) / 1000,
      drsInZone: !!Number(packed[8]),
      grip: Number(packed[9]) / 1000,
    });
  }
  return { frames, samples, lapTime, trackId, packed: raw };
}

export default {
  PB_GHOST_SCHEMA,
  PB_GHOST_MAX_FRAMES,
  PB_GHOST_MIN_FRAMES,
  LEADERBOARD_GHOST_MAX_FRAMES,
  resampleGhostFrames,
  packPbGhost,
  unpackPbGhost,
  estimatePackedGhostBytes,
  shouldReplacePbGhost,
  normalizePbGhostStore,
  getStoredPbGhost,
  putPbGhost,
  unpackLeaderboardGhost,
};
