/**
 * Corner-cut slowdown: facing-preserving speed snap when off-track near high curvature.
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

function ensureBundle() {
  if (process.env.KARTBLITZ_SIM_PREBUILT === "1") return;
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build-online-sim.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error("sim:browser build failed");
  }
}

function loadOnlineSim() {
  ensureBundle();
  const code = fs.readFileSync(simJs, "utf8");
  const sandbox = { console, Math, Date, ArrayBuffer, Uint8Array, DataView, Float32Array, Int32Array };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.OnlineCodec = { encodeState() { return new ArrayBuffer(0); } };
  vm.runInNewContext(code, sandbox, { filename: "online-sim.js" });
  assert.ok(sandbox.OnlineSim);
  assert.ok(typeof sandbox.OnlineSim.localSplineCurvature === "function");
  assert.ok(typeof sandbox.OnlineSim.applyCornerCutSlowdown === "function");
  return sandbox.OnlineSim;
}

const Sim = loadOnlineSim();

// Straight segment → low curvature
{
  const straight = [];
  for (let i = 0; i < 40; i++) straight.push({ x: i * 20, y: 0 });
  const c = Sim.localSplineCurvature(straight, 20);
  assert.ok(c < 0.05, `straight curv ${c}`);
  console.log("ok straight_low_curvature", c.toFixed(5));
}

// 90° bend → high curvature
{
  const bend = [];
  for (let i = 0; i < 20; i++) bend.push({ x: i * 20, y: 0 });
  for (let i = 0; i < 20; i++) bend.push({ x: 400, y: i * 20 });
  const c = Sim.localSplineCurvature(bend, 20);
  assert.ok(c > 0.10, `bend curv ${c}`);
  console.log("ok bend_high_curvature", c.toFixed(5));
}

// Snap reduces speed, does not latch twice, clears on-track
{
  const kart = { speed: 280, _cornerCutLatched: false };
  const r1 = Sim.applyCornerCutSlowdown(kart, { offTrack: true, curvature: 0.25, dt: 1 / 60 });
  assert.strictEqual(r1.snapped, true);
  assert.ok(kart.speed < 280 * 0.6, `snapped speed ${kart.speed}`);
  const afterSnap = kart.speed;
  const r2 = Sim.applyCornerCutSlowdown(kart, { offTrack: true, curvature: 0.25, dt: 1 / 60 });
  assert.strictEqual(r2.snapped, false);
  assert.ok(kart.speed < afterSnap, "hold drag continues");
  Sim.applyCornerCutSlowdown(kart, { offTrack: false, curvature: 0.25, dt: 1 / 60 });
  assert.strictEqual(kart._cornerCutLatched, false);
  console.log("ok snap_once_then_drag");
}

// Coasting on straight off-track: no corner snap
{
  const kart = { speed: 200, _cornerCutLatched: false };
  const r = Sim.applyCornerCutSlowdown(kart, { offTrack: true, curvature: 0.02, dt: 1 / 60 });
  assert.strictEqual(r.active, false);
  assert.strictEqual(kart.speed, 200);
  console.log("ok straight_offtrack_no_snap");
}

console.log("corner-cut.test.mjs: all assertions passed");
