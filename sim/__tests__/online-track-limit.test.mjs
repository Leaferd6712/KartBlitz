/**
 * Online track-limit / penalty HUD state: sim behaviour + snapshot round-trip.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import vm from "vm";
import assert from "assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");
const simJs = path.join(root, "online-sim.js");
const codecJs = path.join(root, "online-codec.js");

function ensureBundle() {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build-online-sim.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error("sim:browser build failed");
  }
}

function loadOnline() {
  ensureBundle();
  const sandbox = {
    console,
    Math,
    Date,
    ArrayBuffer,
    Uint8Array,
    DataView,
    Float32Array,
    Int32Array,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(codecJs, "utf8"), sandbox, { filename: "online-codec.js" });
  vm.runInNewContext(fs.readFileSync(simJs, "utf8"), sandbox, { filename: "online-sim.js" });
  assert.ok(sandbox.OnlineSim, "OnlineSim missing");
  assert.ok(sandbox.OnlineCodec, "OnlineCodec missing");
  return sandbox;
}

function baseKartFields(extra = {}) {
  return {
    id: 0,
    x: 1800,
    y: 4200,
    angle: 0,
    speed: 120,
    lap: 1,
    finished: false,
    finishTime: null,
    finishOrder: null,
    tyreId: "med",
    tyreWear: 0.1,
    tyreTemp: 90,
    ersCharge: 0.8,
    ersActive: false,
    drsActive: false,
    drsAvailable: true,
    pitPhase: null,
    inPit: false,
    checkpointsBit: 1,
    _nearestSplineIdx: 12,
    bestLap: 42.5,
    maxSpeed: 300,
    disconnected: false,
    isOffTrack: false,
    _isCompletelyOff: false,
    _penaltyTimer: 0,
    ...extra,
  };
}

function makeState(karts, tick = 1) {
  return {
    type: "state",
    t: 1e12 + tick * 33,
    tick,
    phase: "racing",
    countdownVal: 0,
    raceTimer: tick / 30,
    launchRPM: [0, 0],
    karts,
    full: true,
    lastProcessedInput: [1, 2],
  };
}

const sandbox = loadOnline();
const Sim = sandbox.OnlineSim;
const Codec = sandbox.OnlineCodec;

assert.strictEqual(Sim.ONLINE_PROTOCOL, 5, "sim protocol bumped for penalty HUD fields");
assert.strictEqual(Codec.NET_VERSION, 5);

// Quantize round-trip
{
  const q = Codec.quantPenaltyTimer(1.5);
  assert.ok(Math.abs(Codec.dequantPenaltyTimer(q) - 1.5) < 0.02);
  assert.strictEqual(Codec.quantPenaltyTimer(0), 0);
}

// Snapshot encode/decode carries penalty HUD fields
{
  const state = makeState([
    baseKartFields({
      isOffTrack: true,
      _isCompletelyOff: true,
      _penaltyTimer: 1.25,
    }),
    baseKartFields({ id: 1, x: 1900, isOffTrack: false, _isCompletelyOff: false, _penaltyTimer: 0 }),
  ]);
  const decoded = Codec.decodeState(Codec.encodeState(state, null), null);
  assert.ok(decoded);
  assert.strictEqual(decoded.karts[0]._isCompletelyOff, true);
  assert.strictEqual(decoded.karts[0].isOffTrack, true);
  assert.ok(Math.abs(decoded.karts[0]._penaltyTimer - 1.25) < 0.03);
  assert.strictEqual(decoded.karts[1]._isCompletelyOff, false);
  assert.strictEqual(decoded.karts[1]._penaltyTimer, 0);
}

// Delta packets still refresh timer while off
{
  const a = makeState([baseKartFields({ _isCompletelyOff: true, isOffTrack: true, _penaltyTimer: 0.5 })], 16);
  const b = makeState([baseKartFields({ _isCompletelyOff: true, isOffTrack: true, _penaltyTimer: 1.1 })], 17);
  b.full = false;
  const decoded = Codec.decodeState(Codec.encodeState(b, a), a);
  assert.ok(decoded.karts[0]._isCompletelyOff);
  assert.ok(Math.abs(decoded.karts[0]._penaltyTimer - 1.1) < 0.03);
}

// Clear on return-to-track
{
  const a = makeState([baseKartFields({ _isCompletelyOff: true, isOffTrack: true, _penaltyTimer: 2.2 })], 20);
  const b = makeState([baseKartFields({ _isCompletelyOff: false, isOffTrack: false, _penaltyTimer: 0 })], 21);
  b.full = false;
  const decoded = Codec.decodeState(Codec.encodeState(b, a), a);
  assert.strictEqual(decoded.karts[0]._isCompletelyOff, false);
  assert.strictEqual(decoded.karts[0].isOffTrack, false);
  assert.strictEqual(decoded.karts[0]._penaltyTimer, 0);
}

const track = Sim.loadTrackBake(0);
assert.ok(track && track.spline && track.spline.length > 10, "track bake required");

function makeRace() {
  return new Sim.OnlineRaceSim({
    track,
    order: ["a", "b"],
    players: [
      { id: "a", name: "A", color: "#0ff", upgrades: Sim.defaultUpgrades() },
      { id: "b", name: "B", color: "#f60", upgrades: Sim.defaultUpgrades() },
    ],
    laps: 3,
    weather: "dry",
    collisionMode: "collision",
    tyres: "med",
  });
}

function skipToRacing(race) {
  race.phase = "racing";
  race.countdownVal = 0;
  for (const k of race.karts) {
    k.lap = 1;
    k.lapStart = race.simTimeMs;
  }
}

function step(race, n, inputA) {
  const inp = inputA || {
    up: true, down: false, left: false, right: false,
    ers: false, drs: false, steer: 0, throttle: 1, brake: 0,
  };
  for (let i = 0; i < n; i++) {
    race.setInput("a", inp, (race.tick + i + 1) & 0xffff);
    race.setInput("b", { ...inp, throttle: 0.2, up: true }, (race.tick + i + 1) & 0xffff);
    race.step(Sim.FIXED_DT);
  }
}

// Leave track → warning/countdown → reset → return
{
  const race = makeRace();
  skipToRacing(race);
  const k = race.karts[0];
  const ni = k._nearestSplineIdx || 0;
  const p = track.spline[ni];
  const n = track.spline.length;
  const a = track.spline[(ni - 1 + n) % n];
  const b = track.spline[(ni + 1) % n];
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  const hx = -ty / len;
  const hy = tx / len;
  const push = track.trackWidth / 2 + 80;
  k.x = p.x + hx * push;
  k.y = p.y + hy * push;
  k.prevX = k.x;
  k.prevY = k.y;
  k.speed = 180;

  assert.strictEqual(k._isCompletelyOff, false);
  assert.strictEqual(k._penaltyTimer, 0);

  // ~0.5s off → countdown active
  step(race, 30);
  assert.strictEqual(k._isCompletelyOff, true, "should be completely off");
  assert.ok(k.isOffTrack || k._isCompletelyOff, "soft or strict off");
  assert.ok(k._penaltyTimer > 0.2 && k._penaltyTimer < 1.2, `expected ~0.5s timer, got ${k._penaltyTimer}`);

  const mid = race.serializeKart(k);
  assert.strictEqual(mid._isCompletelyOff, true);
  assert.ok(mid._penaltyTimer > 0.2);
  const snapMid = {
    type: "state",
    t: 1,
    tick: race.tick,
    phase: "racing",
    countdownVal: 0,
    raceTimer: race.raceTimer,
    launchRPM: race.launchRPM.slice(),
    karts: race.karts.map((kk) => race.serializeKart(kk)),
    full: true,
    lastProcessedInput: race.lastProcessedBySlot(),
  };
  const round = Codec.decodeState(Codec.encodeState(snapMid, null), null);
  assert.strictEqual(round.karts[0]._isCompletelyOff, true);
  assert.ok(Math.abs(round.karts[0]._penaltyTimer - mid._penaltyTimer) < 0.05);

  // Hold off until reset (≥3s)
  const xBefore = k.x;
  step(race, 200);
  assert.ok(k._penaltyTimer < 0.05 || !k._isCompletelyOff, "timer cleared after reset");
  const near = track.spline[k._nearestSplineIdx || 0];
  const dist = Math.hypot(k.x - near.x, k.y - near.y);
  assert.ok(dist < track.trackWidth, `expected on-track after reset, dist=${dist}`);
  assert.ok(Math.hypot(k.x - xBefore, 0) > 5 || dist < track.trackWidth / 2 + 25);

  // Explicit return-to-track clears HUD fields
  k.x = near.x;
  k.y = near.y;
  k.prevX = k.x;
  k.prevY = k.y;
  k.speed = 40;
  step(race, 10);
  assert.strictEqual(k._isCompletelyOff, false);
  assert.strictEqual(k._penaltyTimer, 0);
  const cleared = race.serializeKart(k);
  assert.strictEqual(cleared._isCompletelyOff, false);
  assert.strictEqual(cleared._penaltyTimer, 0);
}

console.log("online-track-limit tests: OK");
