/**
 * Tests for persistent PB ghost pack/unpack/replace + corruption handling.
 */
import assert from 'assert';
import {
  resampleGhostFrames,
  packPbGhost,
  unpackPbGhost,
  shouldReplacePbGhost,
  normalizePbGhostStore,
  getStoredPbGhost,
  putPbGhost,
  estimatePackedGhostBytes,
  unpackLeaderboardGhost,
  PB_GHOST_MAX_FRAMES,
} from '../pb-ghost.mjs';

function makeFrames(seconds, hz = 30) {
  const frames = [];
  const n = Math.floor(seconds * hz);
  for (let i = 0; i <= n; i++) {
    const t = i / hz;
    frames.push({ t, x: 1000 + t * 40, y: 2000 + Math.sin(t) * 20, a: t * 0.05 });
  }
  return frames;
}

// Public leaderboard ghosts carry authoritative pose, control, and vehicle-state samples.
{
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push([i * 100, 10000 + i * 20, 20000, i * 5, 2500, 1 | (i > 5 ? 8 : 0), 0, 900, 1, 1000]);
  const got = unpackLeaderboardGhost({ v: 1, trackId: 2, lapTime: 1.1, sampleRateHz: 15, maxSpeed: 362, frames });
  assert.ok(got);
  assert.strictEqual(got.frames.length, 12);
  assert.strictEqual(got.samples[0].x, 1000);
  assert.strictEqual(got.samples[7].flags & 8, 8);
  assert.strictEqual(unpackLeaderboardGhost({ v: 1, trackId: 2, lapTime: 1.1, frames: frames.slice().reverse() }), null);
  assert.strictEqual(unpackLeaderboardGhost({ v: 1, trackId: 2, lapTime: 1.1, frames: [[0, 1]] }), null);
}

// Resample caps size
{
  const raw = makeFrames(45, 30);
  assert.ok(raw.length > PB_GHOST_MAX_FRAMES);
  const sampled = resampleGhostFrames(raw, PB_GHOST_MAX_FRAMES);
  assert.strictEqual(sampled.length, PB_GHOST_MAX_FRAMES);
  assert.ok(sampled[0].t <= sampled[sampled.length - 1].t);
}

// Pack / unpack round-trip
{
  const raw = makeFrames(42, 30);
  const packed = packPbGhost(raw, { trackId: 3, lapTime: 41.234 });
  assert.ok(packed);
  assert.strictEqual(packed.trackId, 3);
  const bytes = estimatePackedGhostBytes(packed);
  assert.ok(bytes > 500 && bytes < 12000, `expected ~2-8KB, got ${bytes}`);
  const unpacked = unpackPbGhost(packed);
  assert.ok(unpacked);
  assert.strictEqual(unpacked.frames.length, packed.n);
  assert.ok(Math.abs(unpacked.lapTime - 41.234) < 0.002);
  assert.ok(Math.abs(unpacked.frames[0].x - raw[0].x) < 0.2);
}

// Corrupt payloads rejected
{
  assert.strictEqual(unpackPbGhost(null), null);
  assert.strictEqual(unpackPbGhost({ v: 1, n: 2, d: [1, 2] }), null);
  assert.strictEqual(unpackPbGhost({ v: 99, n: 10, d: new Array(40).fill(1), lapTime: 40 }), null);
  assert.strictEqual(unpackPbGhost({ v: 1, n: 10, d: new Array(40).fill(NaN), lapTime: 40 }), null);
  // time going backwards
  const bad = { v: 1, n: 8, lapTime: 40, d: [] };
  for (let i = 0; i < 8; i++) bad.d.push(1000 - i, 1, 2, 3);
  assert.strictEqual(unpackPbGhost(bad), null);
}

// Replace rules
{
  const frames = makeFrames(40, 20);
  const packed = packPbGhost(frames, { trackId: 0, lapTime: 40.0 });
  assert.strictEqual(shouldReplacePbGhost(null, 41, frames, true), true);
  assert.strictEqual(shouldReplacePbGhost(packed, 39.5, frames, true), true);
  assert.strictEqual(shouldReplacePbGhost(packed, 40.5, frames, true), false);
  assert.strictEqual(shouldReplacePbGhost(packed, 39.0, frames, false), false, 'invalid lap must not replace');
  assert.strictEqual(shouldReplacePbGhost(packed, 39.0, frames.slice(0, 3), true), false);
}

// Store normalize + put/get; corrupt entry dropped
{
  let store = normalizePbGhostStore(null);
  assert.strictEqual(store.enabled, true);
  const frames = makeFrames(38, 25);
  const packed = packPbGhost(frames, { trackId: 2, lapTime: 37.5 });
  store = putPbGhost(store, packed);
  const got = getStoredPbGhost(store, 2);
  assert.ok(got);
  assert.strictEqual(got.lapTime, 37.5);

  store = normalizePbGhostStore({
    enabled: false,
    tracks: {
      '2': packed,
      '5': { v: 1, n: 2, d: [1], lapTime: 10 },
    },
  });
  assert.strictEqual(store.enabled, false);
  assert.ok(store.tracks['2']);
  assert.ok(!store.tracks['5'], 'corrupt ghost stripped');
}

// Older saves with no ghost
{
  const empty = getStoredPbGhost({}, 0);
  assert.strictEqual(empty, null);
}

console.log('pb-ghost tests: OK');
