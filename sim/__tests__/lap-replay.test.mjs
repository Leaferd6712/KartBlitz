import assert from 'node:assert/strict';
import { sampleLap, nearestLapTime, replayBounds } from '../lap-replay.mjs';

const samples = [
  { t: 0, x: 0, y: 0, a: Math.PI - .1, speed: 100, flags: 1 },
  { t: 2, x: 20, y: 0, a: -Math.PI + .1, speed: 200, flags: 2 },
  { t: 4, x: 20, y: 20, a: 0, speed: 0, flags: 0 },
];
const middle = sampleLap(samples, 1);
assert.equal(middle.x, 10);
assert.equal(middle.speed, 150);
assert.equal(middle.flags, 1, 'Controls are held from the previous sample, not interpolated backwards');
assert.ok(Math.abs(middle.a - Math.PI) < 1e-8, 'Heading interpolates across the angle wrap');
assert.equal(sampleLap(samples, -10).t, 0);
assert.equal(sampleLap(samples, 100).t, 4);
assert.equal(sampleLap(samples, 2).flags, 2);
assert.equal(sampleLap([], 0), null);
assert.equal(nearestLapTime(samples, 10, -2), 1);
assert.equal(nearestLapTime(samples, 21, 10), 3);
const bounds = replayBounds({ spline: [{ x: -100, y: -100 }], trackWidth: 100 }, samples);
assert.ok(bounds.width >= 250 && bounds.height >= 250, 'Both track and recorded off-track excursions fit');
console.log('lap-replay: ok');
