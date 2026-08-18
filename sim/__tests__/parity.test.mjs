/**
 * Deterministic shared-sim parity: two OnlineRaceSim clones fed identical inputs
 * must stay within 1e-3 pose error after 600 fixed steps.
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
  if (fs.existsSync(simJs)) return;
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
  return sandbox.OnlineSim;
}

function poseErr(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy) + Math.abs(a.angle - b.angle) * 20 + Math.abs(a.speed - b.speed) * 0.05;
}

function cloneConfig(Sim, overrides) {
  const track = Sim.loadTrackBake(0);
  assert.ok(track, "track bake 0 missing — run npm run tracks:export");
  const upgrades = overrides.upgrades || Sim.defaultUpgrades();
  return {
    track,
    order: ["a", "b"],
    players: [
      { id: "a", name: "A", color: "#0ff", upgrades },
      { id: "b", name: "B", color: "#f60", upgrades: overrides.upgradesB || upgrades },
    ],
    laps: 3,
    weather: overrides.weather || "dry",
    collisionMode: overrides.collisionMode || "collision",
    tyres: overrides.tyres || "med",
  };
}

function makeInputStream(seed, n) {
  const out = [];
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const throttle = (s & 255) / 255;
    const steer = (((s >>> 8) & 255) / 255) * 2 - 1;
    const brake = ((s >>> 16) & 63) / 63 * 0.35;
    out.push({
      up: throttle > 0.15,
      down: brake > 0.2,
      left: steer < -0.25,
      right: steer > 0.25,
      ers: (s & 1) === 1 && i % 40 < 12,
      drs: (s & 2) === 2,
      steer,
      throttle,
      brake,
    });
  }
  return out;
}

function runTwin(Sim, cfg, inputsA, inputsB, steps) {
  const a = new Sim.OnlineRaceSim(cfg);
  const b = new Sim.OnlineRaceSim(cfg);
  a.phase = "racing";
  b.phase = "racing";
  a.applyLaunch();
  b.applyLaunch();

  for (let i = 0; i < steps; i++) {
    a.setInput("a", inputsA[i % inputsA.length], i + 1);
    a.setInput("b", inputsB[i % inputsB.length], i + 1);
    b.setInput("a", inputsA[i % inputsA.length], i + 1);
    b.setInput("b", inputsB[i % inputsB.length], i + 1);
    a.step(Sim.FIXED_DT);
    b.step(Sim.FIXED_DT);
  }
  return { a, b };
}

function assertParity(label, Sim, overrides, steps = 600) {
  const cfg = cloneConfig(Sim, overrides);
  const inputsA = makeInputStream(0xC0FFEE, steps);
  const inputsB = makeInputStream(0xBADC0DE, steps);
  const { a, b } = runTwin(Sim, cfg, inputsA, inputsB, steps);
  for (let i = 0; i < a.karts.length; i++) {
    const err = poseErr(a.karts[i], b.karts[i]);
    assert.ok(
      err < 1e-3,
      `${label} kart ${i} pose error ${err} (>= 1e-3)`
    );
  }
  console.log("ok", label);
}

const Sim = loadOnlineSim();

assertParity("stock", Sim, {});
assertParity("upgraded", Sim, {
  upgrades: Sim.sanitizeUpgrades({
    speed: 40,
    accel: 35,
    handling: 30,
    braking: 25,
    traction: 20,
    speedMult: 1.08,
    turnMult: 1.05,
    brakeMult: 1.05,
    tractBonus: 12,
  }),
});
assertParity("wet_wrong_tyre", Sim, { weather: "rain", tyres: "soft" });
assertParity("collision_2kart", Sim, { collisionMode: "collision" });

// Off-track: force throttle + hard steer for a stretch on a fresh twin pair
{
  const cfg = cloneConfig(Sim, {});
  const a = new Sim.OnlineRaceSim(cfg);
  const b = new Sim.OnlineRaceSim(cfg);
  a.phase = "racing";
  b.phase = "racing";
  a.applyLaunch();
  b.applyLaunch();
  const wild = {
    up: true,
    down: false,
    left: true,
    right: false,
    ers: true,
    drs: false,
    steer: -1,
    throttle: 1,
    brake: 0,
  };
  for (let i = 0; i < 600; i++) {
    a.setInput("a", wild, i + 1);
    a.setInput("b", wild, i + 1);
    b.setInput("a", wild, i + 1);
    b.setInput("b", wild, i + 1);
    a.step(Sim.FIXED_DT);
    b.step(Sim.FIXED_DT);
  }
  for (let i = 0; i < a.karts.length; i++) {
    const err = poseErr(a.karts[i], b.karts[i]);
    assert.ok(err < 1e-3, `offtrack kart ${i} pose error ${err}`);
  }
  console.log("ok offtrack_reset_path");
}

// Finish path: huge lap count already done via finished flags — just ensure step stays deterministic when finished
{
  const cfg = cloneConfig(Sim, { laps: 1 });
  const a = new Sim.OnlineRaceSim(cfg);
  const b = new Sim.OnlineRaceSim(cfg);
  a.phase = "racing";
  b.phase = "racing";
  a.applyLaunch();
  b.applyLaunch();
  a.karts.forEach((k) => {
    k.finished = true;
    k.finishTime = 12;
  });
  b.karts.forEach((k) => {
    k.finished = true;
    k.finishTime = 12;
  });
  const idle = Sim.emptyInput();
  for (let i = 0; i < 120; i++) {
    a.setInput("a", idle, i + 1);
    a.setInput("b", idle, i + 1);
    b.setInput("a", idle, i + 1);
    b.setInput("b", idle, i + 1);
    a.step(Sim.FIXED_DT);
    b.step(Sim.FIXED_DT);
  }
  assert.strictEqual(a.phase, b.phase);
  for (let i = 0; i < a.karts.length; i++) {
    assert.ok(poseErr(a.karts[i], b.karts[i]) < 1e-3);
  }
  console.log("ok finish_idle");
}

console.log("All sim parity tests passed.");
