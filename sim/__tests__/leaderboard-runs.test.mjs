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
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
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
  const sandbox = { console, Math, Date, ArrayBuffer, Uint8Array, DataView, Float32Array, Int32Array, Buffer, btoa };
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

  // Drive a complete lap with digital controls, then reproduce it from the saved input stream.
  for (const targetSpeed of [60, 15]) {
    const radius = 500, count = 200;
    const spline = Array.from({ length: count }, (_, i) => ({ x: Math.cos(i / count * Math.PI * 2) * radius, y: Math.sin(i / count * Math.PI * 2) * radius }));
    const circle = { id: 999, spline, cum: spline.map((_, i) => i * 2 * Math.PI * radius / count), totalLen: 2 * Math.PI * radius,
      trackWidth: 200, startPos: { x: radius, y: -10 }, startAngle: Math.PI / 2, drsZones: [],
      cpLines: [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map(a => ({ x1: Math.cos(a) * (radius - 100), y1: Math.sin(a) * (radius - 100), x2: Math.cos(a) * (radius + 100), y2: Math.sin(a) * (radius + 100) })) };
    const kart = Sim.createKart({ id: 0, ...circle.startPos, angle: circle.startAngle, weather: 'dry', tyreId: 'med',
      upgrades: Sim.competitiveStandardUpgrades(), totalLaps: 99, getInput: Sim.emptyInput });
    const inputs = [];
    for (let tick = 0; tick < 20000; tick++) {
      const angle = Math.atan2(kart.y, kart.x) + .12;
      const target = Math.atan2(Math.sin(angle) * radius - kart.y, Math.cos(angle) * radius - kart.x);
      const error = Math.atan2(Math.sin(target - kart.angle), Math.cos(target - kart.angle));
      const flags = (kart.speed < targetSpeed ? 1 : 0) | (error < -.012 ? 4 : error > .012 ? 8 : 0);
      inputs.push(flags);
      Sim.stepKart(kart, Sim.unpackInputFlags(flags), Sim.FIXED_DT, circle, [], { contact: false, resolveCollisions: false, nowMs: (tick + 1) * Sim.FIXED_DT * 1000 });
      if (kart.lapTimes.length) break;
    }
    const result = Sim.verifyTrialReplay(circle, new Uint8Array(inputs));
    assert.equal(result.ok, true, 'The verifier must finish a real simulated lap');
    const ghost = result.ghost;
    assert.equal(ghost.recordingVersion, 2);
    assert.equal(ghost.recording.physicsHz, 60);
    assert.equal(ghost.recording.lapEndStep, inputs.length);
    assert.ok(ghost.recording.lapStartStep > 0, 'Keep the flying-lap lead-in');
    assert.equal(ghost.frames[0][0], 0);
    assert.ok(Math.abs(ghost.frames.at(-1)[0] / 1000 - result.bestLap) < .001);
    assert.ok(ghost.frames.length <= 2400);
    if (targetSpeed === 15) assert.ok(ghost.sampleRateHz < 15, 'Long laps retain the entire path with adaptive sampling');
    const restoredInputs = Sim.decodeTrialInputsBase64(ghost.recording.inputsBase64);
    assert.deepEqual(Array.from(restoredInputs), inputs);
    const restored = Sim.verifyTrialReplay(ghost.trackSnapshot, restoredInputs, ghost.recording);
    assert.equal(restored.bestLap, result.bestLap);
    assert.equal(JSON.stringify(restored.ghost.frames), JSON.stringify(ghost.frames), 'Downloaded data reconstructs the same lap trajectory');
  }

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

  // Public recordings remain available below the top 10, but must belong to a verified score.
  {
    const runId = "AbCdEfGhIjKlMnOpQr";
    const ghost = { v: 1, trackId: 0, lapTime: 41.25, frames: Array.from({ length: 8 }, (_, i) => [i * 100, i, 0, 0, 100, 1, 0, 1000, 0, 1000]) };
    const topTenDb = mockDb({
      first: (sql) => String(sql).includes("JOIN ghost_replays")
        ? { username_snapshot: "FASTDRIVER", track_id: 0, best_lap: 41.25, trust_level: "verified", rank: 5, ghost_json: JSON.stringify(ghost) }
        : null,
    });
    const available = await LB.getLeaderboardGhost(topTenDb, runId);
    assert.equal(available.ok, true);
    assert.equal(available.rank, 5);
    assert.equal(available.username, "FASTDRIVER");

    const lowerRankDb = mockDb({ first: sql => {
      if (!String(sql).includes('JOIN ghost_replays')) return null;
      assert.ok(!/s\.rank\s*<=\s*10/.test(sql), 'Replay retrieval must not restrict rank');
      return { username_snapshot: 'RACER', track_id: 0, best_lap: 41.25, trust_level: 'verified', rank: 35, ghost_json: JSON.stringify(ghost) };
    } });
    assert.equal((await LB.getLeaderboardGhost(lowerRankDb, runId)).rank, 35);
    const forged = await LB.getLeaderboardGhost(mockDb({ first: sql => String(sql).includes('JOIN ghost_replays')
      ? { trust_level: 'unverified' } : null }), runId);
    assert.equal(forged.ok, false);

    const droppedDb = mockDb({
      first: () => null,
    });
    const unavailable = await LB.getLeaderboardGhost(droppedDb, runId);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error, "ghost_not_found");
  }

  // New recordings retain controls/layout; retention only removes superseded scores' recordings.
  {
    const bundled = await build({ entryPoints: [path.join(root, 'party/trial-runs.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
    const Runs = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
    const statements = [];
    await Runs.storeLeaderboardGhost(mockDb({ run: (sql, args) => { statements.push({ sql, args }); return {}; } }),
      'AbCdEfGhIjKlMnOpQr', 0, 41.25, 1, { ...ghostFixture(), recordingVersion: 2 });
    assert.ok(statements.some(s => s.sql.includes('INSERT INTO ghost_replays')));
    const cleanup = statements.find(s => s.sql.includes('DELETE FROM ghost_replays'));
    assert.ok(cleanup.sql.includes("trust_level = 'verified'"));
    assert.ok(!cleanup.sql.includes('LIMIT 10'), 'A rank drop must not delete a recording');
    assert.deepEqual(cleanup.args, [0, 0]);

    const board = await LB.getLeaderboard(mockDb({ all: sql => {
      assert.ok(sql.includes('$.recordingVersion'));
      return { results: [
        { username_snapshot: 'OLD', track_id: 0, best_lap: 40, trust_level: 'verified', has_ghost: 1, recording_version: 0 },
        { username_snapshot: 'NEW', track_id: 0, best_lap: 41, trust_level: 'verified', has_ghost: 1, recording_version: 2 },
      ] };
    } }), 'trial', 0);
    assert.equal(board.scores[0].recordingVersion, 0, 'Old times remain present and identifiable as legacy');
    assert.equal(board.scores[1].recordingVersion, 2);

    // Exercise the real SQL against SQLite, including rank drops and superseded recordings.
    const sqlite = new DatabaseSync(':memory:');
    const realDb = {
      async batch(statements) { return Promise.all(statements.map(s => s.run())); },
      prepare(sql) {
        let args = [];
        return { bind(...values) { args = values; return this; },
          async run() { return sqlite.prepare(sql).run(...args); },
          async first() { return sqlite.prepare(sql).get(...args) || null; },
          async all() { return { results: sqlite.prepare(sql).all(...args) }; } };
      },
    };
    await LB.ensureLeaderboardSchema(realDb);
    const insert = sqlite.prepare(`INSERT INTO scores (device_token, username_snapshot, mode, track_id, best_lap, created_at, updated_at, trust_level, verified_run_id)
      VALUES (?, ?, 'trial', 0, ?, 1, 1, 'verified', ?)`);
    for (let i = 0; i < 12; i++) insert.run(`device${i}`, `RACER${i}`, 30 + i, `recorded-run-${String(i).padStart(6, '0')}`);
    await Runs.storeLeaderboardGhost(realDb, 'recorded-run-000011', 0, 41, 1, { ...ghostFixture(), lapTime: 41, recordingVersion: 2 });
    let retained = await LB.getLeaderboardGhost(realDb, 'recorded-run-000011');
    assert.equal(retained.ok, true);
    assert.equal(retained.rank, 12, 'A new best below the top ten is publicly watchable');
    await Runs.storeLeaderboardGhost(realDb, 'recorded-run-000000', 0, 30, 1, ghostFixture());
    retained = await LB.getLeaderboardGhost(realDb, 'recorded-run-000011');
    assert.equal(retained.ok, true, 'Another player saving a lap must not purge lower-ranked ghosts');
    const persistedBoard = await LB.getLeaderboard(realDb, 'trial', 0);
    assert.equal(persistedBoard.scores[0].recordingVersion, 0);
    assert.equal(persistedBoard.scores[11].recordingVersion, 2);
    sqlite.prepare("UPDATE scores SET verified_run_id = 'recorded-new-000011' WHERE device_token = 'device11'").run();
    await Runs.storeLeaderboardGhost(realDb, 'recorded-new-000011', 0, 41, 1, { ...ghostFixture(), recordingVersion: 2 });
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM ghost_replays WHERE run_id = 'recorded-run-000011'").get().n, 0, 'Only the superseded recording is removed');
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM ghost_replays WHERE run_id = 'recorded-run-000000'").get().n, 1);
    sqlite.close();
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

function ghostFixture() {
  return { v: 1, trackId: 0, lapTime: 41.25, frames: Array.from({ length: 8 }, (_, i) => [i * 100, i, 0, 0, 100, 1, 0, 1000, 0, 1000]) };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
