/**
 * Live integration test against local PartyServer (wrangler dev on :8787).
 * Verifies lobby/race flow over WebSocket, then simulates display smoothing
 * with the shared OnlineSim bundle (Node WebSocket may not receive binary frames from wrangler).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import vm from "vm";
import assert from "assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");
const PARTY_HOST = process.env.KARTBLITZ_PARTY_HOST || "127.0.0.1:8787";
const DT = 1 / 60;
const simJs = path.join(root, "online-sim.js");
const NativeWebSocket = globalThis.WebSocket;

function patchWebSocket(BaseWS) {
  function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new BaseWS(url, protocols) : new BaseWS(url);
    ws.binaryType = "arraybuffer";
    let handler = null;
    Object.defineProperty(ws, "onmessage", {
      configurable: true,
      enumerable: true,
      get: () => handler,
      set: (fn) => {
        handler = fn;
        ws.addEventListener("message", (ev) => {
          let data = ev.data;
          if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
            data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          }
          if (fn) fn({ data });
        });
      },
    });
    return ws;
  }
  PatchedWebSocket.prototype = BaseWS.prototype;
  return PatchedWebSocket;
}

function ensureBundle() {
  if (fs.existsSync(simJs)) return;
  const r = spawnSync(process.execPath, [path.join(root, "scripts/build-online-sim.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("sim:browser build failed");
}

function loadSandbox(hostSearch = `?partyHost=${encodeURIComponent(PARTY_HOST)}`) {
  const codecCode = fs.readFileSync(path.join(root, "online-codec.js"), "utf8");
  const onlineCode = fs.readFileSync(path.join(root, "online.js"), "utf8");
  const sandbox = {
    console,
    Math,
    Date,
    URLSearchParams,
    WebSocket: patchWebSocket(NativeWebSocket),
    setTimeout,
    clearTimeout,
    performance,
    location: { search: hostSearch },
    fetch: async (url) => fetch(url),
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    OnlineSim: {
      ONLINE_PROTOCOL: 4,
      TRACK_BAKE_VERSION: 2,
      STEPS_PER_INPUT: 2,
      FIXED_DT: DT,
    },
    getOnlineUpgrades: () => null,
    getKartBlitzDeviceToken: () => null,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(codecCode, sandbox, { filename: "online-codec.js" });
  vm.runInNewContext(onlineCode, sandbox, { filename: "online.js" });
  assert.ok(sandbox.OnlineNet, "OnlineNet missing");
  return sandbox;
}

function loadOnlineSim() {
  ensureBundle();
  const code = fs.readFileSync(simJs, "utf8");
  const sandbox = {
    console,
    Math,
    Date,
    ArrayBuffer,
    Uint8Array,
    DataView,
    Float32Array,
    Int32Array,
    OnlineCodec: {
      encodeState() {
        return new ArrayBuffer(0);
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: "online-sim.js" });
  assert.ok(sandbox.OnlineSim, "OnlineSim missing");
  return sandbox.OnlineSim;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(session, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timer);
      session.off(event, onEvent);
      resolve(payload);
    }
    session.on(event, onEvent);
  });
}

async function serverAvailable() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://${PARTY_HOST}/`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function dispDist(k) {
  return Math.hypot(k.x - k._dispX, k.y - k._dispY);
}

async function runLiveLobbyFlow(host, guest) {
  await host.hostLobby({ name: "HOST", color: "#00f5ff" });
  const roomId = host.roomId;
  assert.ok(roomId, "host room id missing");

  await guest.joinLobby(roomId, { name: "GUEST", color: "#ff8800" });
  await sleep(600);

  host.setReady(true);
  guest.setReady(true);

  for (let i = 0; i < 30; i++) {
    const readyCount = (host.players || []).filter((p) => p.ready).length;
    if (host.players.length >= 2 && readyCount >= 2) break;
    await sleep(100);
  }
  assert.ok((host.players || []).filter((p) => p.ready).length >= 2, "both players should be ready");

  const startPromise = waitFor(host, "startRace", 10000);
  host.startRace();
  await startPromise;
  await waitFor(guest, "startRace", 10000);

  assert.strictEqual(host.phase, "racing");
  assert.strictEqual(guest.phase, "racing");
  console.log("ok liveLobbyFlow room=" + roomId);
}

function simulateLiveDisplay(sess, Sim) {
  const cfg = {
    track: Sim.loadTrackBake(0),
    order: ["host", "guest"],
    players: [
      { id: "host", name: "HOST", color: "#00f5ff", upgrades: Sim.defaultUpgrades() },
      { id: "guest", name: "GUEST", color: "#ff8800", upgrades: Sim.defaultUpgrades() },
    ],
    laps: 3,
    weather: "dry",
    collisionMode: "collision",
    tyres: "med",
  };
  assert.ok(cfg.track, "track bake missing");

  const sim = new Sim.OnlineRaceSim(cfg);
  sim.phase = "racing";
  sim.applyLaunch();

  const race = {
    phase: "racing",
    karts: sim.karts.map((k) => ({
      x: k.x,
      y: k.y,
      angle: k.angle,
      speed: k.speed,
      isOffTrack: false,
      finished: false,
      _dispX: k.x,
      _dispY: k.y,
      _dispAngle: k.angle,
    })),
    _onlineLocalSim: sim.karts[0],
    _onlineSimTrack: cfg.track,
    collisionMode: "collision",
  };

  sess.localSlot = 0;
  const inp = { up: true, throttle: 1, steer: 0.12, down: false, left: false, right: false, ers: false, drs: false, brake: 0 };

  let maxDisp = 0;
  let maxFrameJump = 0;

  for (let frame = 0; frame < 120; frame++) {
    Sim.stepKart(sim.karts[0], inp, DT, cfg.track, sim.karts, {
      contact: true,
      resolveCollisions: true,
      nowMs: frame * DT * 1000,
    });

    const k = race.karts[0];
    const prevDispX = k._dispX;
    const prevDispY = k._dispY;

    k.x = sim.karts[0].x;
    k.y = sim.karts[0].y;
    k.angle = sim.karts[0].angle;
    k.speed = sim.karts[0].speed;

    if (frame > 0 && frame % 30 === 0) {
      k.x += 18;
      sim.karts[0].x += 18;
    }

    sess.smoothOnlineDisplay(race, DT);

    maxFrameJump = Math.max(maxFrameJump, Math.hypot(k._dispX - prevDispX, k._dispY - prevDispY));
    maxDisp = Math.max(maxDisp, sess._lastDispErr || dispDist(k));
  }

  assert.ok(maxDisp <= 22, `simulated live display lag too high: ${maxDisp}px`);
  assert.ok(maxFrameJump <= 25, `simulated live display jump too large: ${maxFrameJump}px`);
  console.log(`ok liveDisplaySim maxDisp=${maxDisp.toFixed(1)} maxFrameJump=${maxFrameJump.toFixed(1)}`);
}

async function runLiveSession() {
  const hostBox = loadSandbox();
  const guestBox = loadSandbox();
  const host = hostBox.OnlineNet.session;
  const guest = guestBox.OnlineNet.session;
  const Sim = loadOnlineSim();

  await runLiveLobbyFlow(host, guest);
  simulateLiveDisplay(host, Sim);

  host.leave(true);
  guest.leave(true);
}

if (!(await serverAvailable())) {
  console.log(`skip live integration — PartyServer not reachable at ${PARTY_HOST} (run: npm run party:dev)`);
  process.exit(0);
}

await runLiveSession();
console.log("Live online display integration passed.");
