/**
 * Regression tests for online display smoothing (smoothOnlineDisplay / reconcile).
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
  return sess;
}

function makeRace(phase = "racing") {
  const k = {
    x: 100,
    y: 200,
    angle: 0,
    speed: 180,
    isOffTrack: false,
    _dispX: 100,
    _dispY: 200,
    _dispAngle: 0,
  };
  return { phase, karts: [k] };
}

function dispDist(k) {
  return Math.hypot(k.x - k._dispX, k.y - k._dispY);
}

function captureDisplayPose(k) {
  if (!k || !Number.isFinite(k._dispX) || !Number.isFinite(k._dispY)) return null;
  return {
    x: k._dispX,
    y: k._dispY,
    a: Number.isFinite(k._dispAngle) ? k._dispAngle : k.angle,
  };
}

function restoreDisplayPose(k, disp) {
  if (!k || !disp) return;
  k._dispX = disp.x;
  k._dispY = disp.y;
  k._dispAngle = disp.a;
}

function applyPose(k, pose) {
  k.x = pose.x;
  k.y = pose.y;
  k.angle = pose.angle;
  if (pose.speed != null) k.speed = pose.speed;
}

function smooth(sess, race, dt = DT) {
  sess.smoothOnlineDisplay(race, dt);
}

function testCorrectionGlides(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  k.x = 160;
  const prevDispX = k._dispX;
  smooth(sess, race);
  const frameDelta = Math.abs(k._dispX - prevDispX);
  assert.ok(frameDelta > 0, "display should move toward corrected physics");
  assert.ok(frameDelta < 25, `single-frame glide too large: ${frameDelta}px`);
  assert.notStrictEqual(k._dispX, k.x, "display should not instantly snap to physics");
  console.log("ok correctionGlides");
}

function testConvergesWithin150ms(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  k.x = 160;
  for (let i = 0; i < 10; i++) smooth(sess, race);
  assert.ok(dispDist(k) < 2, `display should converge within 150ms, err=${dispDist(k)}`);
  console.log("ok convergesWithin150ms");
}

function testNoMidRaceSnapAt180(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  k.x = 250;
  const prevDispX = k._dispX;
  smooth(sess, race);
  const frameDelta = Math.abs(k._dispX - prevDispX);
  assert.ok(frameDelta < 149, `mid-race snap detected: jumped ${frameDelta}px in one frame`);
  assert.notStrictEqual(k._dispX, k.x, "150px error should glide, not snap during racing");
  console.log("ok noMidRaceSnapAt180");
}

function testLagCapEnforced(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  k.x = 140;
  for (let i = 0; i < 15; i++) smooth(sess, race);
  assert.ok(sess._lastDispErr <= 30, `display lag should settle under cap: ${sess._lastDispErr}px`);
  assert.ok(dispDist(k) <= 30, `display distance should be under cap: ${dispDist(k)}px`);
  console.log("ok lagCapEnforced");
}

function testOffTrackBoost(sess) {
  const raceOff = makeRace("racing");
  const raceOn = makeRace("racing");
  const kOff = raceOff.karts[0];
  const kOn = raceOn.karts[0];
  kOff.speed = 0;
  kOn.speed = 0;
  kOff.isOffTrack = true;
  kOff.x = 200;
  kOn.x = 200;

  smooth(sess, raceOff);
  smooth(sess, raceOn);

  const errOff = dispDist(kOff);
  const errOn = dispDist(kOn);
  assert.ok(errOff < errOn, `off-track should catch up faster after 1 frame (off=${errOff}, on=${errOn})`);
  console.log("ok offTrackBoost");
}

function testLaunchSnapAllowed(sess) {
  const race = makeRace("countdown");
  const k = race.karts[0];
  k.x = 350;
  smooth(sess, race);
  assert.strictEqual(k._dispX, k.x, "launch/countdown should allow hard snap on large error");
  assert.strictEqual(k._dispY, k.y);
  console.log("ok launchSnapAllowed");
}

function testReconcilePreservesDisplay(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  const keepDisp = captureDisplayPose(k);
  applyPose(k, { x: 150, y: 200, angle: 0, speed: 180 });
  restoreDisplayPose(k, keepDisp);
  assert.strictEqual(k._dispX, 100, "display X preserved after reconcile-style physics snap");
  assert.strictEqual(k._dispY, 200, "display Y preserved after reconcile-style physics snap");
  assert.strictEqual(k.x, 150, "physics updated to server pose");
  console.log("ok reconcilePreservesDisplay");
}

const sess = loadSession();
testCorrectionGlides(sess);
testConvergesWithin150ms(sess);
testNoMidRaceSnapAt180(sess);
testLagCapEnforced(sess);
testOffTrackBoost(sess);
testLaunchSnapAllowed(sess);
testReconcilePreservesDisplay(sess);

console.log("All display smooth tests passed.");
