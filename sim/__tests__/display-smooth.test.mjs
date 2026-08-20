/**
 * Visual offset decay: local sprite = physics + visOff; remotes use interpolated pose.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import assert from "assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");
const onlineJs = path.join(root, "online.js");
const DT = 1 / 60;

function loadSession() {
  const code = fs.readFileSync(onlineJs, "utf8");
  const sandbox = {
    console,
    Math,
    Date,
    URLSearchParams,
    location: { search: "" },
    OnlineSim: {
      ONLINE_PROTOCOL: 3,
      TRACK_BAKE_VERSION: 2,
      STEPS_PER_INPUT: 2,
      FIXED_DT: DT,
    },
    fetch: async () => ({ ok: false }),
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: "online.js" });
  assert.ok(sandbox.OnlineNet, "OnlineNet missing");
  const sess = sandbox.OnlineNet.session;
  sess.localSlot = 0;
  sess._guestPhase = "racing";
  return sess;
}

function makeRace(phase = "racing") {
  const k = {
    x: 100,
    y: 200,
    angle: 0,
    speed: 180,
    isOffTrack: false,
  };
  return { phase, karts: [k] };
}

function visXY(k, sess) {
  const off = sess._visOff || { x: 0, y: 0 };
  return { x: k.x + (off.x || 0), y: k.y + (off.y || 0) };
}

function visDist(k, sess) {
  const v = visXY(k, sess);
  return Math.hypot(k.x - v.x, k.y - v.y);
}

function testOffsetHoldsOnCorrection(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  sess.latestState = {
    tick: 1,
    phase: "racing",
    karts: [{ x: 150, y: 200, angle: 0, speed: 180 }],
  };
  sess._lastReconTick = -1;
  sess._visOff = { x: 0, y: 0, a: 0 };
  const speedBefore = k.speed;
  sess.reconcileLocalKart(race, DT);
  assert.strictEqual(k.x, 150, "physics snapped to server pose");
  assert.strictEqual(k.speed, speedBefore, "physics speed unchanged by visual offset");
  const vis = visXY(k, sess);
  assert.ok(Math.abs(vis.x - 100) < 0.01, `visual X should hold at 100, got ${vis.x}`);
  assert.ok(Math.abs(vis.y - 200) < 0.01, `visual Y should hold at 200, got ${vis.y}`);
  console.log("ok offsetHoldsOnCorrection");
}

function testDecaysIn100ms(sess) {
  const race = makeRace("racing");
  sess._visOff = { x: 40, y: 0, a: 0 };
  for (let i = 0; i < 6; i++) sess.smoothOnlineDisplay(race, DT);
  const mag = visDist(race.karts[0], sess);
  assert.ok(mag < 20, `offset should decay in ~100ms, mag=${mag}`);
  assert.ok(mag > 8, `offset should not vanish in one tick, mag=${mag}`);
  console.log("ok decaysIn100ms");
}

function testNoMidRaceSnap(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  sess._visOff = { x: -150, y: 0, a: 0 };
  applyVis(k, sess);
  const visBefore = visXY(k, sess);
  sess.smoothOnlineDisplay(race, DT);
  const visAfter = visXY(k, sess);
  const jump = Math.hypot(visAfter.x - visBefore.x, visAfter.y - visBefore.y);
  assert.ok(jump < 40, `mid-race visual jump too large: ${jump}px`);
  assert.ok(visDist(k, sess) > 100, "150px correction should not snap away in one frame");
  console.log("ok noMidRaceSnap");
}

function testLaunchSnapAllowed(sess) {
  const race = makeRace("countdown");
  sess._visOff = { x: 250, y: 0, a: 0 };
  sess.smoothOnlineDisplay(race, DT);
  assert.ok(Math.abs(sess._visOff.x) < 0.01, "launch/countdown should snap large offset");
  console.log("ok launchSnapAllowed");
}

function testSpeedUntouched(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  sess._visOff = { x: -40, y: 0, a: 0 };
  const startSpeed = k.speed;
  for (let i = 0; i < 30; i++) sess.smoothOnlineDisplay(race, DT);
  assert.strictEqual(k.speed, startSpeed, "k.speed must stay unchanged");
  console.log("ok speedUntouched");
}

function applyVis(k, sess) {
  const off = sess._visOff;
  k._visOffX = off.x;
  k._visOffY = off.y;
  k._visOffA = off.a;
}

const sess = loadSession();
testOffsetHoldsOnCorrection(sess);
testDecaysIn100ms(sess);
testNoMidRaceSnap(sess);
testLaunchSnapAllowed(sess);
testSpeedUntouched(sess);

console.log("All display offset tests passed.");
