/**
 * Abuse-focused tests for verified Time Trial leaderboard runs.
 * Client-claimed lap times must not become board entries without a server replay.
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawnSync } from "child_process";
import vm from "vm";
import {
  classifyTrialRunCompletion,
} from "../../party/trial-run-guards.ts";

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
  const sandbox = { console, Math, Date, ArrayBuffer, Uint8Array, DataView, Float32Array, Int32Array, Buffer };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.OnlineCodec = { encodeState() { return new ArrayBuffer(0); } };
  vm.runInNewContext(code, sandbox, { filename: "online-sim.js" });
  assert.ok(sandbox.OnlineSim, "OnlineSim global missing");
  return sandbox.OnlineSim;
}

async function loadLeaderboard() {
  return import(pathToFileURL(path.join(root, "party/leaderboard.ts")).href);
}

function driveInputs(n, pattern) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pattern(i) || {};
    out.push({
      up: !!p.up,
      down: !!p.down,
      left: !!p.left,
      right: !!p.right,
      ers: !!p.ers,
      drs: !!p.drs,
      steer: p.left && !p.right ? -1 : p.right && !p.left ? 1 : 0,
      throttle: p.up ? 1 : 0,
      brake: p.down ? 1 : 0,
    });
  }
  return out;
}

function mockDb(handlers = {}) {
  return {
    async batch() {
      return [];
    },
    prepare(sql) {
      const self = {
        _sql: sql,
        _args: [],
        bind(...args) {
          self._args = args;
          return self;
        },
        async run() {
          if (handlers.run) return handlers.run(sql, self._args);
          return { success: true };
        },
        async first() {
          if (handlers.first) return handlers.first(sql, self._args);
          return null;
        },
        async all() {
          if (handlers.all) return handlers.all(sql, self._args);
          return { results: [] };
        },
      };
      return self;
    },
  };
}

async function main() {
  const Sim = loadOnlineSim();
  const LB = await loadLeaderboard();
  const track = Sim.loadTrackBake(0);
  assert.ok(track, "track bake 0 required");
  assert.ok(typeof Sim.verifyTrialReplay === "function", "verifyTrialReplay exported");

  // Pack/unpack roundtrip
  const sample = {
    up: true, down: false, left: true, right: false, ers: true, drs: false,
    steer: -1, throttle: 1, brake: 0,
  };
  const packed = Sim.packInputFlags(sample);
  const unpacked = Sim.unpackInputFlags(packed);
  assert.equal(unpacked.up, true);
  assert.equal(unpacked.left, true);
  assert.equal(unpacked.ers, true);
  assert.equal(unpacked.drs, false);

  // Short inputs rejected
  let res = Sim.verifyTrialReplay(track, new Uint8Array(10));
  assert.equal(res.ok, false);
  assert.equal(res.error, "inputs_too_short");

  // Idle stream → no lap
  const idle = Sim.encodeTrialInputs(driveInputs(120, () => ({})));
  res = Sim.verifyTrialReplay(track, idle);
  assert.equal(res.ok, false);
  assert.equal(res.error, "no_lap_completed");

  const floor = Sim.minPlausibleLapSec(track);
  assert.ok(floor > 1 && floor < 120);

  // /api/scores refuses trial (run required)
  {
    const token = "abcdefghijklmnopqrstuvwx";
    const denied = await LB.submitScore(mockDb(), {
      deviceToken: token,
      mode: "trial",
      trackId: 0,
      bestLap: 12.345,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "run_required");
    assert.equal(denied.status, 403);
  }

  // Versus accepted as unverified
  {
    const token = "abcdefghijklmnopqrstuvwx";
    let inserted = null;
    const db = mockDb({
      first: (sql) => {
        if (String(sql).includes("FROM devices")) {
          return { device_token: token, username: "TESTER", created_at: 1, last_seen_at: 1 };
        }
        return null;
      },
      run: (sql, args) => {
        if (String(sql).includes("INSERT INTO scores")) inserted = { sql, args };
        return {};
      },
    });
    const ok = await LB.submitScore(db, {
      deviceToken: token,
      mode: "versus",
      trackId: 0,
      bestLap: 55.5,
      trackName: "TEST",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.trustLevel, "unverified");
    assert.ok(inserted && inserted.args.includes("unverified"));
  }

  // Forged tiny trial time still blocked at submitScore
  {
    const forge = await LB.submitScore(mockDb(), {
      deviceToken: "abcdefghijklmnopqrstuvwx",
      mode: "trial",
      trackId: 0,
      bestLap: 0.001,
    });
    assert.equal(forge.ok, false);
    assert.equal(forge.error, "run_required");
  }

  // Public ghosts are returned only while their verified score is in the current top 10.
  {
    const runId = "AbCdEfGhIjKlMnOpQr";
    const ghost = { v: 1, trackId: 0, lapTime: 41.25, frames: Array.from({ length: 8 }, (_, i) => [i * 100, i, 0, 0, 100, 1, 0, 1000, 0, 1000]) };
    const topTenDb = mockDb({
      first: (sql) => String(sql).includes("JOIN ghost_replays")
        ? { username_snapshot: "FASTDRIVER", track_id: 0, best_lap: 41.25, trust_level: "verified", ghost_json: JSON.stringify(ghost) }
        : String(sql).includes("COUNT(*)") ? { count: 4 } : null,
    });
    const available = await LB.getLeaderboardGhost(topTenDb, runId);
    assert.equal(available.ok, true);
    assert.equal(available.rank, 5);
    assert.equal(available.username, "FASTDRIVER");

    const droppedDb = mockDb({
      first: (sql) => String(sql).includes("JOIN ghost_replays")
        ? { username_snapshot: "OLDFAST", track_id: 0, best_lap: 50, trust_level: "verified", ghost_json: JSON.stringify(ghost) }
        : String(sql).includes("COUNT(*)") ? { count: 10 } : null,
    });
    const unavailable = await LB.getLeaderboardGhost(droppedDb, runId);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error, "ghost_not_top_10");
  }

  // Lifecycle guards (unknown / mismatch / expired / consumed idempotent)
  {
    const token = "abcdefghijklmnopqrstuvwx";
    const other = "zyxwvutsrqponmlkjihgfedc";
    const rules = Sim.LEADERBOARD_RULES_VERSION;
    const bake = Sim.TRACK_BAKE_VERSION;
    const base = {
      run_id: "AbCdEfGhIjKlMnOpQr",
      device_token: token,
      mode: "trial",
      status: "open",
      expires_at: Date.now() + 60_000,
      rules_version: rules,
      track_bake_version: bake,
      verified_best_lap: null,
      consume_count: 0,
      max_consumes: 1,
    };

    assert.equal(classifyTrialRunCompletion(null, token, Date.now(), rules, bake).error, "unknown_run");
    assert.equal(
      classifyTrialRunCompletion(base, other, Date.now(), rules, bake).error,
      "run_device_mismatch"
    );
    assert.equal(
      classifyTrialRunCompletion({ ...base, expires_at: Date.now() - 1 }, token, Date.now(), rules, bake).error,
      "run_expired"
    );

    const idem = classifyTrialRunCompletion(
      { ...base, status: "consumed", verified_best_lap: 41.25, consume_count: 1 },
      token,
      Date.now(),
      rules,
      bake
    );
    assert.equal(idem.ok, true);
    assert.equal(idem.idempotent, true);
    assert.equal(idem.bestLap, 41.25);

    // Attacker cannot change the stored verified lap via classify — body bestLap is never consulted here.
    assert.notEqual(idem.bestLap, 0.01);
  }

  console.log("leaderboard-runs: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
