/**
 * Regression tests for PIDF visual-speed display catch-up.
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
  k._pidPhysX = k.x;
  k._pidPhysY = k.y;
  k._pidAlongPrev = undefined;
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
  const prevDispY = k._dispY;
  const speedBefore = k.speed;
  smooth(sess, race);
  const frameDelta = k._dispX - prevDispX;
  assert.strictEqual(k.speed, speedBefore, "physics speed must not change");
  assert.ok(frameDelta > 0, "display should move forward along heading toward physics");
  assert.ok(frameDelta < 25, `single-frame glide too large: ${frameDelta}px`);
  assert.ok(Math.abs(k._dispY - prevDispY) < 0.5, "display should not slide sideways");
  assert.notStrictEqual(k._dispX, k.x, "display should not instantly snap to physics");
  console.log("ok correctionGlides");
}

function testConvergesAlongPath(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  k.x = 140;
  const startErr = dispDist(k);
  for (let i = 0; i < 30; i++) smooth(sess, race);
  const midErr = dispDist(k);
  assert.ok(midErr < startErr - 4, `0.5s should reduce along-error (start=${startErr}, mid=${midErr})`);
  for (let i = 0; i < 150; i++) smooth(sess, race);
  assert.ok(dispDist(k) < 6, `along-error should mostly close, err=${dispDist(k)}`);
  console.log("ok convergesAlongPath");
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

function testSpeedUntouched(sess) {
  const race = makeRace("racing");
  const k = race.karts[0];
  k.x = 140;
  const startSpeed = k.speed;
  for (let i = 0; i < 30; i++) smooth(sess, race);
  assert.strictEqual(k.speed, startSpeed, "k.speed must stay 180 after PIDF catch-up");
  assert.ok(isFinite(k._dispSpeed), "visual speed should be tracked separately");
  console.log("ok speedUntouched");
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
testConvergesAlongPath(sess);
testNoMidRaceSnapAt180(sess);
testSpeedUntouched(sess);
testLaunchSnapAllowed(sess);
testReconcilePreservesDisplay(sess);

console.log("All display smooth tests passed.");
