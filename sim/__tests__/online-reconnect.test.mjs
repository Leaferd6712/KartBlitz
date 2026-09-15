/**
 * Reconnect helpers + OnlineRaceSim disconnect/resume/forfeit behaviour.
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import vm from "vm";
import {
  createSeat,
  forfeitSeat,
  generateReconnectToken,
  graceRemainingMs,
  isGraceExpired,
  markSeatDisconnected,
  pickHostSeatId,
  RECONNECT_GRACE_MS,
  tokensEqual,
  validateResume,
} from "../../party/reconnect.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

// ── Pure reconnect module ─────────────────────────────────
{
  const a = generateReconnectToken(() => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]));
  const b = generateReconnectToken(() => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]));
  assert.ok(tokensEqual(a, b));
  assert.ok(!tokensEqual(a, "00" + a.slice(2)));
}

{
  const seat = createSeat({
    connId: "c1",
    upgrades: {},
    randomBytes: (n) => Uint8Array.from(Array.from({ length: n }, (_, i) => i + 1)),
  });
  assert.ok(seat.seatId.startsWith("s_"));
  assert.strictEqual(seat.status, "connected");
  assert.ok(seat.reconnectToken.length >= 32);

  const now = 1_000_000;
  const dc = markSeatDisconnected(seat, now);
  assert.strictEqual(dc.status, "disconnected");
  assert.strictEqual(dc.connId, null);
  assert.ok(graceRemainingMs(dc, now + 1000) > 0);
  assert.ok(!isGraceExpired(dc, now + 1000));
  assert.ok(isGraceExpired(dc, now + RECONNECT_GRACE_MS + 1));

  const ok = validateResume([dc], {
    token: dc.reconnectToken,
    seatId: dc.seatId,
    now: now + 5_000,
    phase: "racing",
  });
  assert.ok(ok.ok);
  assert.strictEqual(ok.seat.status, "connected");

  const hijack = validateResume([dc], {
    token: dc.reconnectToken,
    seatId: "s_other",
    now: now + 5_000,
    phase: "racing",
  });
  assert.ok(!hijack.ok);
  assert.strictEqual(hijack.code, "invalid_token");

  const bad = validateResume([dc], {
    token: "deadbeef",
    now: now + 5_000,
    phase: "racing",
  });
  assert.ok(!bad.ok);

  const expired = validateResume([dc], {
    token: dc.reconnectToken,
    now: now + RECONNECT_GRACE_MS + 50,
    phase: "racing",
  });
  assert.ok(!expired.ok);
  assert.strictEqual(expired.code, "expired");

  const forfeited = forfeitSeat(dc);
  const fo = validateResume([forfeited], {
    token: forfeited.reconnectToken,
    now: now + 1000,
    phase: "racing",
  });
  assert.ok(!fo.ok);
  assert.strictEqual(fo.code, "forfeited");
}

{
  const seats = [
    createSeat({ connId: "a", upgrades: {}, name: "A", randomBytes: (n) => new Uint8Array(n).fill(1) }),
    markSeatDisconnected(
      createSeat({ connId: "b", upgrades: {}, name: "B", randomBytes: (n) => new Uint8Array(n).fill(2) }),
      Date.now()
    ),
  ];
  seats[0].seatId = "seatA";
  seats[1].seatId = "seatB";
  assert.strictEqual(pickHostSeatId(seats, ["seatB", "seatA"]), "seatA");
  assert.strictEqual(pickHostSeatId(seats), "seatA");
}

// ── Sim: disconnect / resume / forfeit / finish gate ──────
function ensureBundle() {
  if (process.env.KARTBLITZ_SIM_PREBUILT === "1") return;
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build-online-sim.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error("sim build failed");
  }
}

function loadSim() {
  ensureBundle();
  const sandbox = { console, Math, Date, ArrayBuffer, Uint8Array, DataView, Float32Array, Int32Array };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.OnlineCodec = {
    encodeState() {
      return new ArrayBuffer(8);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "online-sim.js"), "utf8"), sandbox, {
    filename: "online-sim.js",
  });
  return sandbox.OnlineSim;
}

const Sim = loadSim();
const track = Sim.loadTrackBake(0);
assert.ok(track);

function makeRace() {
  return new Sim.OnlineRaceSim({
    track,
    order: ["seatA", "seatB"],
    players: [
      { id: "seatA", name: "A", color: "#0ff", upgrades: Sim.defaultUpgrades() },
      { id: "seatB", name: "B", color: "#f60", upgrades: Sim.defaultUpgrades() },
    ],
    laps: 1,
    weather: "dry",
    collisionMode: "nocollision",
    tyres: "med",
  });
}

{
  const race = makeRace();
  race.phase = "racing";
  const a = race.karts[0];
  const b = race.karts[1];
  assert.strictEqual(a.onlineConnId, "seatA");

  race.markDisconnected("seatA");
  assert.strictEqual(a._onlineDisconnected, true);

  // While A is disconnected, B finishing should end the race (no stall).
  b.finished = true;
  b.finishTime = 10;
  b.finishOrder = 1;
  for (let i = 0; i < 5; i++) race.step(Sim.FIXED_DT);
  assert.strictEqual(race.phase, "finished");
  assert.strictEqual(a.finished, true, "disconnected seat forfeited on race end");
}

{
  const race = makeRace();
  race.phase = "racing";
  race.markDisconnected("seatB");
  race.clearDisconnected("seatB");
  assert.strictEqual(race.karts[1]._onlineDisconnected, false);

  race.markDisconnected("seatB");
  race.forfeitDisconnected("seatB");
  assert.strictEqual(race.karts[1].finished, true);
  assert.ok(race.karts[1].finishOrder >= 1);
}

{
  // Multiple resume attempts: first disconnect, resume, disconnect again, resume again
  const seat = createSeat({
    connId: "c1",
    upgrades: {},
    randomBytes: (n) => new Uint8Array(n).fill(9),
  });
  let cur = markSeatDisconnected(seat, 1000);
  for (let i = 0; i < 3; i++) {
    const r = validateResume([cur], {
      token: seat.reconnectToken,
      seatId: seat.seatId,
      now: 1000 + i * 1000,
      phase: "racing",
    });
    assert.ok(r.ok, "resume attempt " + i);
    cur = markSeatDisconnected({ ...r.seat, connId: "c" + (i + 2) }, 2000 + i * 1000);
  }
}

console.log("online-reconnect tests: OK");
