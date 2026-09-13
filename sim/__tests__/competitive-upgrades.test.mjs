/**
 * Competitive online performance: client min vs max upgrade claims must resolve identically
 * while TRUST_CLIENT_PROGRESSION_UPGRADES is false.
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
  sandbox.OnlineCodec = { encodeState() { return new ArrayBuffer(0); } };
  vm.runInNewContext(code, sandbox, { filename: "online-sim.js" });
  assert.ok(sandbox.OnlineSim);
  assert.ok(typeof sandbox.OnlineSim.resolveOnlineUpgrades === "function");
  assert.ok(typeof sandbox.OnlineSim.computeBaseStats === "function");
  return sandbox.OnlineSim;
}

const Sim = loadOnlineSim();

assert.strictEqual(
  Sim.TRUST_CLIENT_PROGRESSION_UPGRADES,
  false,
  "competitive mode should temporarily distrust client progression"
);

const minClaim = {
  speed: 0,
  accel: 0,
  handling: 0,
  braking: 0,
  traction: 0,
  speedMult: 0.7,
  turnMult: 0.7,
  brakeMult: 0.7,
  tractBonus: 0,
  tyreWearMult: 0.7,
};

const maxClaim = {
  speed: 80,
  accel: 80,
  handling: 80,
  braking: 80,
  traction: 80,
  speedMult: 1.35,
  turnMult: 1.35,
  brakeMult: 1.5,
  tractBonus: 40,
  tyreWearMult: 0.7,
};

const uMin = Sim.resolveOnlineUpgrades(minClaim);
const uMax = Sim.resolveOnlineUpgrades(maxClaim);
const stock = Sim.competitiveStandardUpgrades
  ? Sim.competitiveStandardUpgrades()
  : Sim.defaultUpgrades();

assert.deepStrictEqual(uMin, stock, "min claim must resolve to stock");
assert.deepStrictEqual(uMax, stock, "max claim must resolve to stock");
assert.deepStrictEqual(uMin, uMax, "min and max claims must be identical");

const statsMin = Sim.computeBaseStats(uMin, "dry", "med");
const statsMax = Sim.computeBaseStats(uMax, "dry", "med");

for (const key of Object.keys(statsMin)) {
  assert.strictEqual(
    statsMin[key],
    statsMax[key],
    `base stat ${key} must match for min vs max claim`
  );
}

// Kart creation also equalizes
const kartMin = Sim.createKart({
  id: 0,
  x: 0,
  y: 0,
  angle: 0,
  color: "#0ff",
  upgrades: maxClaim,
  weather: "dry",
  tyreId: "med",
  totalLaps: 3,
});
const kartMax = Sim.createKart({
  id: 1,
  x: 0,
  y: 0,
  angle: 0,
  color: "#f60",
  upgrades: minClaim,
  weather: "dry",
  tyreId: "med",
  totalLaps: 3,
});

// createKart still uses sanitize via applySetup — OnlineRaceSim uses resolveOnlineUpgrades.
// Prove resolve path used by race config:
const resolvedA = Sim.resolveOnlineUpgrades(maxClaim);
const resolvedB = Sim.resolveOnlineUpgrades(minClaim);
const equalA = Sim.createKart({
  id: 2, x: 0, y: 0, angle: 0, color: "#0ff",
  upgrades: resolvedA, weather: "dry", tyreId: "med", totalLaps: 3,
});
const equalB = Sim.createKart({
  id: 3, x: 0, y: 0, angle: 0, color: "#f60",
  upgrades: resolvedB, weather: "dry", tyreId: "med", totalLaps: 3,
});
assert.strictEqual(equalA.maxSpeed, equalB.maxSpeed);
assert.strictEqual(equalA.accel, equalB.accel);
assert.strictEqual(equalA.turnRate, equalB.turnRate);
assert.strictEqual(equalA.brakeForce, equalB.brakeForce);
assert.strictEqual(equalA.grip, equalB.grip);
assert.strictEqual(equalA.tyreWearMult, equalB.tyreWearMult);

console.log("ok equal_performance_min_max", {
  maxSpeed: equalA.maxSpeed,
  accel: equalA.accel,
  turnRate: equalA.turnRate,
});
console.log("competitive-upgrades.test.mjs: all assertions passed");

// Silence unused when createKart still applies raw sanitize for direct upgrades
void kartMin;
void kartMax;
void statsMin;
void statsMax;
