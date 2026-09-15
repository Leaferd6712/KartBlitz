import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../ml/runtime.js', import.meta.url), 'utf8');
const context = { console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'ml/runtime.js' });

const ML = context.KartBlitzMLRuntime;
assert.ok(ML, 'runtime should install its public API');
assert.equal(ML.validateModel(ML.DEFAULT_MODEL), true);
assert.equal(ML.OBSERVATIONS.length, 14);
assert.equal(ML.OBSERVATIONS_V2.length, 24);
assert.equal(ML.DISCRETE_ACTIONS.length, 9);

const spline = Array.from({ length: 360 }, (_, index) => {
  const angle = index / 360 * Math.PI * 2;
  return { x: 1000 + Math.cos(angle) * 600, y: 1000 + Math.sin(angle) * 600 };
});
const track = { id: 0, trackWidth: 160, spline };
const kart = {
  x: spline[0].x,
  y: spline[0].y,
  angle: Math.PI / 2,
  speed: 220,
  maxSpeed: 520,
  _nearestSplineIdx: 0,
  isOffTrack: false,
  ersCharge: 1,
  drsAvailable: false,
  drsInZone: false,
};
const observation = ML.observe(kart, track, {});
assert.equal(observation.length, 14);
assert.ok(observation.every(Number.isFinite));
assert.ok(Math.abs(observation[2]) < 0.05, 'heading sensor should align with the circular track tangent');
const observationV2 = ML.observeV2(kart, track, {});
assert.equal(observationV2.length, 24);
assert.ok(observationV2.every(Number.isFinite));

const controller = ML.makeController(track, ML.DEFAULT_MODEL);
controller.set(kart);
const input = controller.fn();
assert.equal(typeof input.up, 'boolean');
assert.equal(typeof input.down, 'boolean');
assert.ok(input.steer >= -1 && input.steer <= 1);
assert.equal(kart._mlDriver, true);

const continuousV2 = {
  format: ML.FORMAT,
  formatVersion: 2,
  id: 'test-v2',
  name: 'Test V2',
  observationVersion: 2,
  observationCount: 24,
  observationNames: ML.OBSERVATIONS_V2,
  actionSpace: 'continuous-3-v2',
  policy: { activation: 'tanh', layers: [{ kernel: Array.from({ length: 3 }, () => Array(24).fill(0)), bias: [0, 2, -2] }] },
};
assert.equal(ML.validateModel(continuousV2), true);
const analogController = ML.makeController(track, continuousV2);
analogController.set(kart);
const analogInput = analogController.fn();
assert.ok(Number.isFinite(analogInput.steer));
assert.ok(analogInput.throttle > 0 && analogInput.throttle <= 1);
assert.ok(analogInput.brake >= 0 && analogInput.brake <= 1);

const broken = structuredClone(ML.DEFAULT_MODEL);
broken.observationCount = 3;
assert.throws(() => ML.validateModel(broken), /incompatible sensor/i);

console.log('ML runtime contract tests passed');
