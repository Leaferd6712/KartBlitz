/**
 * Tyre wear must be frame-rate independent: same duration → same wear at 30/60/120 Hz.
 * R&D durability scales incremental wear only (not accumulated wear).
 * Drive load: lift/coast → 0 wear; aggressive turning → elevated wear.
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
  sandbox.OnlineCodec = {
    encodeState() {
      return new ArrayBuffer(0);
    },
  };
  vm.runInNewContext(code, sandbox, { filename: "online-sim.js" });
  assert.ok(sandbox.OnlineSim, "OnlineSim global missing");
  assert.ok(typeof sandbox.OnlineSim.updateTyres === "function", "updateTyres missing");
  assert.ok(
    typeof sandbox.OnlineSim.tyreDriveLoadWearMult === "function",
    "tyreDriveLoadWearMult missing"
  );
  return sandbox.OnlineSim;
}

function simulateWear(
  updateTyres,
  { hz, durationSec, speed, wearMult, tyreId, throttle, brake, steer }
) {
  const dt = 1 / hz;
  const steps = Math.round(durationSec * hz);
  let wear = 0;
  let temp = 90;
  for (let i = 0; i < steps; i++) {
    const tick = updateTyres(
      {
        tyreId: tyreId || "med",
        tyreWear: wear,
        tyreTemp: temp,
        tyreWrongWeather: false,
        weather: "dry",
        tyreWearMult: wearMult,
      },
      dt,
      speed,
      400,
      throttle != null ? throttle : 0.5,
      brake != null ? brake : 0,
      steer != null ? steer : 0
    );
    wear = tick.wear;
    temp = 90;
  }
  return wear;
}

const Sim = loadOnlineSim();
const updateTyres = Sim.updateTyres;
const loadMult = Sim.tyreDriveLoadWearMult;
const DURATION = 10;
const SPEED = 280;
const HZ_LIST = [30, 60, 120];
const TOL = 1e-5;

function assertClose(a, b, msg) {
  assert.ok(Math.abs(a - b) <= TOL, `${msg}: ${a} vs ${b} (diff ${Math.abs(a - b)})`);
}

// ── Load helper: coast vs aggressive turn ───────────────
{
  assert.strictEqual(loadMult(0, 0, 0, 0.7), 0, "pure coast → 0");
  assert.strictEqual(loadMult(0.05, 0.05, 0, 0.7), 0, "lift → 0");
  assert.ok(loadMult(0.2, 0, 0.9, 0.8) > loadMult(0.8, 0, 0, 0.8), "turn wears more than straight throttle");
  assert.ok(loadMult(0, 0, 1, 0.85) > 0.8, "aggressive turn alone loads tyres");
  console.log("ok load_mult_coast_and_turn");
}

// ── Baseline (throttle, no steer) across Hz ─────────────
{
  const wears = HZ_LIST.map((hz) =>
    simulateWear(updateTyres, {
      hz,
      durationSec: DURATION,
      speed: SPEED,
      wearMult: 1,
      throttle: 0.5,
      brake: 0,
      steer: 0,
    })
  );
  for (let i = 1; i < wears.length; i++) {
    assertClose(wears[0], wears[i], `stock wear 30Hz vs ${HZ_LIST[i]}Hz`);
  }
  assert.ok(wears[0] > 0, "stock wear should accumulate under throttle");
  console.log("ok stock_hz_independent", wears.map((w) => w.toFixed(8)).join(" "));
}

// ── Upgraded durability across Hz ───────────────────────
{
  const wears = HZ_LIST.map((hz) =>
    simulateWear(updateTyres, {
      hz,
      durationSec: DURATION,
      speed: SPEED,
      wearMult: 0.7,
      throttle: 0.5,
      brake: 0,
      steer: 0,
    })
  );
  for (let i = 1; i < wears.length; i++) {
    assertClose(wears[0], wears[i], `upgraded wear 30Hz vs ${HZ_LIST[i]}Hz`);
  }
  console.log("ok upgraded_hz_independent", wears.map((w) => w.toFixed(8)).join(" "));
}

// ── Upgraded ≈ 0.7 × stock at same Hz ───────────────────
{
  const stock = simulateWear(updateTyres, {
    hz: 60,
    durationSec: DURATION,
    speed: SPEED,
    wearMult: 1,
    throttle: 0.5,
    brake: 0,
    steer: 0,
  });
  const upgraded = simulateWear(updateTyres, {
    hz: 60,
    durationSec: DURATION,
    speed: SPEED,
    wearMult: 0.7,
    throttle: 0.5,
    brake: 0,
    steer: 0,
  });
  assertClose(upgraded, stock * 0.7, "upgraded should be 0.7× stock wear");
  console.log("ok upgraded_scales_increment");
}

// ── Coast / lift accumulates no wear ────────────────────
{
  const coast = simulateWear(updateTyres, {
    hz: 60,
    durationSec: DURATION,
    speed: SPEED,
    wearMult: 1,
    throttle: 0,
    brake: 0,
    steer: 0,
  });
  assert.strictEqual(coast, 0, "coasting should not wear tyres");
  console.log("ok coast_zero_wear");
}

// ── Aggressive turning wears more than straight throttle ─
{
  const straight = simulateWear(updateTyres, {
    hz: 60,
    durationSec: DURATION,
    speed: SPEED,
    wearMult: 1,
    throttle: 0.7,
    brake: 0,
    steer: 0,
  });
  const turning = simulateWear(updateTyres, {
    hz: 60,
    durationSec: DURATION,
    speed: SPEED,
    wearMult: 1,
    throttle: 0.3,
    brake: 0,
    steer: 1,
  });
  assert.ok(turning > straight, `turn wear ${turning} should exceed straight ${straight}`);
  console.log("ok aggressive_turn_wears_more", {
    straight: straight.toFixed(8),
    turning: turning.toFixed(8),
  });
}

console.log("tyre-wear.test.mjs: all assertions passed");
