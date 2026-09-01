/**
 * HTTP JSON API for KartBlitz sim — used by Python Gymnasium wrapper.
 *
 *   npm run ml:env
 *   npm run ml:env -- --port 8765
 *
 * POST /  body: { "cmd": "ping" | "list_tracks" | "reset" | "step" | "observe", ... }
 */
import http from "http";
import { KartBlitzEnv, observe, precomputeCurvature, N_OBS, N_ACT, ACTIONS } from "../sim/rl/env.mjs";
import { loadOnlineSim } from "../sim/rl/load-sim.mjs";

const DEFAULT_PORT = 8765;

function parseArgs(argv) {
  const a = { port: DEFAULT_PORT, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const n = argv[i + 1];
    if (k === "--port") a.port = Number(n);
    else if (k === "--host") a.host = n;
    else continue;
    i++;
  }
  return a;
}

const Sim = loadOnlineSim();
let env = null;
let curvCache = new Map();

function getCurv(track) {
  const id = track.id;
  if (!curvCache.has(id)) curvCache.set(id, precomputeCurvature(track));
  return curvCache.get(id);
}

function handle(body) {
  const cmd = body.cmd;
  if (cmd === "ping") {
    return { ok: true, nObs: N_OBS, nAct: N_ACT, dt: Sim.FIXED_DT, hz: Sim.SIM_HZ || 60 };
  }
  if (cmd === "list_tracks") {
    return { ok: true, tracks: Sim.listTrackIds() };
  }
  if (cmd === "reset") {
    const trackId = body.trackId ?? 0;
    const seconds = body.seconds ?? 18;
    const maxSteps = Math.max(60, Math.round(seconds / Sim.FIXED_DT));
    env = new KartBlitzEnv(Sim, trackId, { maxSteps });
    const obs = env.reset();
    return {
      ok: true,
      obs,
      trackId,
      totalLen: env.track.totalLen,
      maxSteps,
    };
  }
  if (cmd === "step") {
    if (!env) return { ok: false, error: "call reset first" };
    const action = body.action ?? 1;
    const result = env.step(action);
    return { ok: true, ...result };
  }
  if (cmd === "observe") {
    if (!env) return { ok: false, error: "call reset first" };
    return { ok: true, obs: env.getObs(), info: env.info };
  }
  if (cmd === "state") {
    if (!env) return { ok: false, error: "call reset first" };
    const k = env.kart;
    const curv = getCurv(env.track);
    return {
      ok: true,
      x: k.x,
      y: k.y,
      angle: k.angle,
      speed: k.speed,
      lap: k.lap,
      finished: k.finished,
      isOffTrack: k.isOffTrack,
      obs: observe(k, env.track, curv),
      info: env.info,
    };
  }
  if (cmd === "actions") {
    return { ok: true, actions: ACTIONS.map((a) => a.name) };
  }
  return { ok: false, error: `unknown cmd: ${cmd}` };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "POST JSON to /" }));
      return;
    }
    try {
      const body = await readJson(req);
      const out = handle(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  });

  server.listen(args.port, args.host, () => {
    console.log(`KartBlitz ML env server  http://${args.host}:${args.port}`);
    console.log(`POST { "cmd": "reset", "trackId": 0 }  then  { "cmd": "step", "action": 1 }`);
    console.log(`Tracks: ${Sim.listTrackIds().join(", ")}`);
  });
}

main();
