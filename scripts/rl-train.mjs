/**
 * Headless REINFORCE trainer for KartBlitz.
 *
 * Uses the same physics as online (`online-sim.js`). Does not replace the
 * scripted AI Race driver — this is an experiment: lots of cheap sims, tiny
 * linear policy, discrete steer/throttle/brake.
 *
 *   npm run rl:train
 *   npm run rl:train -- --episodes 3000 --track 0 --seconds 18
 *   npm run rl:train -- --eval --load sim/rl/policy.json --track 0
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const simJs = path.join(root, "online-sim.js");

const ACTIONS = [
  { name: "thr-L", up: true, down: false, left: true, right: false },
  { name: "thr", up: true, down: false, left: false, right: false },
  { name: "thr-R", up: true, down: false, left: false, right: true },
  { name: "coast-L", up: false, down: false, left: true, right: false },
  { name: "coast", up: false, down: false, left: false, right: false },
  { name: "coast-R", up: false, down: false, left: false, right: true },
  { name: "brk-L", up: false, down: true, left: true, right: false },
  { name: "brk", up: false, down: true, left: false, right: false },
  { name: "brk-R", up: false, down: true, left: false, right: true },
];
const N_ACT = ACTIONS.length;
const N_OBS = 10;

function parseArgs(argv) {
  const a = {
    episodes: 1500,
    seconds: 18,
    track: 0,
    lr: 0.004,
    gamma: 0.992,
    entropy: 0.04,
    skip: 2,
    seed: 1,
    eval: false,
    load: "",
    out: path.join(root, "sim", "rl", "policy.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const n = argv[i + 1];
    if (k === "--episodes") a.episodes = Number(n);
    else if (k === "--seconds") a.seconds = Number(n);
    else if (k === "--track") a.track = Number(n);
    else if (k === "--lr") a.lr = Number(n);
    else if (k === "--gamma") a.gamma = Number(n);
    else if (k === "--entropy") a.entropy = Number(n);
    else if (k === "--skip") a.skip = Number(n);
    else if (k === "--seed") a.seed = Number(n);
    else if (k === "--out") a.out = path.resolve(n);
    else if (k === "--load") a.load = path.resolve(n);
    else if (k === "--eval") a.eval = true;
    else continue;
    if (k !== "--eval") i++;
  }
  return a;
}

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
  sandbox.OnlineCodec = { encodeState() { return new ArrayBuffer(0); } };
  vm.runInNewContext(code, sandbox, { filename: "online-sim.js" });
  if (!sandbox.OnlineSim) throw new Error("OnlineSim global missing");
  return sandbox.OnlineSim;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function mulberry32(seed) {
  return rng(seed);
}

function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function idxAhead(track, startIdx, dist) {
  const { cum, totalLen } = track;
  const n = track.spline.length;
  let target = cum[startIdx] + dist;
  if (target >= totalLen) target -= totalLen;
  const lo0 = target < cum[startIdx] ? 0 : startIdx;
  let lo = lo0, hi = n - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

function precomputeCurvature(track) {
  const spl = track.spline;
  const n = spl.length;
  const curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = spl[(i - 5 + n) % n], c = spl[i], nx = spl[(i + 5) % n];
    const dx1 = c.x - p.x, dy1 = c.y - p.y;
    const dx2 = nx.x - c.x, dy2 = nx.y - c.y;
    const l1 = Math.hypot(dx1, dy1) || 1, l2 = Math.hypot(dx2, dy2) || 1;
    curv[i] = Math.abs((dx1 / l1) * (dy2 / l2) - (dy1 / l1) * (dx2 / l2));
  }
  return curv;
}

function observe(kart, track, curv) {
  const spl = track.spline;
  const n = spl.length;
  const idx = ((kart._nearestSplineIdx || 0) % n + n) % n;
  const p = spl[idx];
  const nxt = spl[(idx + 1) % n];
  const tx = nxt.x - p.x, ty = nxt.y - p.y;
  const tlen = Math.hypot(tx, ty) || 1;
  const tangX = tx / tlen, tangY = ty / tlen;
  const halfW = track.trackWidth * 0.5;
  const lat = (kart.x - p.x) * -tangY + (kart.y - p.y) * tangX;
  const head = wrapPi(kart.angle - Math.atan2(tangY, tangX));
  const i40 = idxAhead(track, idx, 40);
  const i80 = idxAhead(track, idx, 80);
  const i160 = idxAhead(track, idx, 160);
  const maxSpd = kart.maxSpeed || 200;
  return [
    Math.max(-1, Math.min(1, kart.speed / Math.max(1, maxSpd))),
    Math.max(-1.5, Math.min(1.5, lat / Math.max(1, halfW))),
    Math.sin(head),
    Math.cos(head),
    Math.max(0, Math.min(1, curv[idx] * 4)),
    Math.max(0, Math.min(1, curv[i40] * 4)),
    Math.max(0, Math.min(1, curv[i80] * 4)),
    Math.max(0, Math.min(1, curv[i160] * 4)),
    kart.isOffTrack ? 1 : 0,
    (track.cum[idx] || 0) / Math.max(1, track.totalLen),
  ];
}

function progressAlong(kart, track) {
  const idx = kart._nearestSplineIdx || 0;
  const lap = kart.lap || 0;
  return lap * track.totalLen + (track.cum[idx] || 0);
}

function toInput(actionIdx, Sim) {
  const a = ACTIONS[actionIdx];
  const inp = Sim.emptyInput();
  inp.up = a.up;
  inp.down = a.down;
  inp.left = a.left;
  inp.right = a.right;
  inp.throttle = a.up ? 1 : 0;
  inp.brake = a.down ? 1 : 0;
  inp.steer = a.left ? -1 : a.right ? 1 : 0;
  return inp;
}

function softmaxLogits(logits) {
  let m = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > m) m = logits[i];
  const ex = new Float64Array(logits.length);
  let s = 0;
  for (let i = 0; i < logits.length; i++) {
    ex[i] = Math.exp(logits[i] - m);
    s += ex[i];
  }
  const p = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) p[i] = ex[i] / s;
  return p;
}

function forward(W, b, obs) {
  const logits = new Float64Array(N_ACT);
  for (let a = 0; a < N_ACT; a++) {
    let v = b[a];
    const row = a * N_OBS;
    for (let i = 0; i < N_OBS; i++) v += W[row + i] * obs[i];
    logits[a] = v;
  }
  return logits;
}

function sampleAction(probs, rand) {
  let r = rand();
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i];
    if (r <= 0) return i;
  }
  return probs.length - 1;
}

function argmax(probs) {
  let bi = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bi]) bi = i;
  return bi;
}

function newPolicy() {
  const W = new Float64Array(N_ACT * N_OBS);
  const b = new Float64Array(N_ACT);
  // Bias toward throttle-straight so the first episodes actually move.
  b[1] = 1.4;
  return { W, b };
}

function clonePolicy(p) {
  return { W: Float64Array.from(p.W), b: Float64Array.from(p.b) };
}

function savePolicy(p, outPath, meta) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    nObs: N_OBS,
    nAct: N_ACT,
    actions: ACTIONS.map((a) => a.name),
    W: Array.from(p.W),
    b: Array.from(p.b),
    meta,
  }, null, 2));
}

function loadPolicy(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (j.nObs !== N_OBS || j.nAct !== N_ACT) {
    throw new Error(`policy shape mismatch: got ${j.nObs}x${j.nAct}, need ${N_OBS}x${N_ACT}`);
  }
  return { W: Float64Array.from(j.W), b: Float64Array.from(j.b) };
}

function makeKart(Sim, track) {
  return Sim.createKart({
    id: 0,
    x: track.startPos.x,
    y: track.startPos.y,
    angle: track.startAngle,
    weather: "dry",
    tyreId: "med",
    totalLaps: 1,
    upgrades: Sim.defaultUpgrades(),
  });
}

function runEpisode(Sim, track, curv, policy, opts) {
  const { dt, maxSteps, skip, greedy, rand } = opts;
  const kart = makeKart(Sim, track);
  const others = [];
  let lastProg = progressAlong(kart, track);
  let stuck = 0;
  let lastX = kart.x, lastY = kart.y;
  let rewardSum = 0;
  let offSteps = 0;
  const obsHist = [];
  const actHist = [];
  const rewHist = [];
  const probHist = [];

  for (let step = 0; step < maxSteps; step++) {
    const obs = observe(kart, track, curv);
    let action = 1;
    let probs = null;
    if (step % skip === 0) {
      const logits = forward(policy.W, policy.b, obs);
      probs = softmaxLogits(logits);
      action = greedy ? argmax(probs) : sampleAction(probs, rand);
    } else if (actHist.length) {
      action = actHist[actHist.length - 1];
    }

    const inp = toInput(action, Sim);
    Sim.stepKart(kart, inp, dt, track, others, { contact: false, nowMs: step * dt * 1000, resolveCollisions: false });

    const prog = progressAlong(kart, track);
    let dProg = prog - lastProg;
    if (dProg < -track.totalLen * 0.5) dProg += track.totalLen;
    if (dProg > track.totalLen * 0.5) dProg -= track.totalLen;
    lastProg = prog;

    const moved = Math.hypot(kart.x - lastX, kart.y - lastY);
    lastX = kart.x;
    lastY = kart.y;
    if (moved < 2.5) stuck += dt;
    else stuck = 0;

    if (kart.isOffTrack) offSteps++;

    let r = dProg * 0.035 - 0.012;
    if (kart.isOffTrack) r -= 0.35;
    if (kart._isCompletelyOff) r -= 0.55;
    const headingCos = obs[3];
    if (headingCos < 0) r -= 0.08;
    if (kart.finished || (kart.lap || 0) >= 1) r += 8;

    if (step % skip === 0) {
      obsHist.push(obs);
      actHist.push(action);
      rewHist.push(r);
      probHist.push(probs);
    } else {
      rewHist[rewHist.length - 1] += r;
    }
    rewardSum += r;

    if (kart.finished || (kart.lap || 0) >= 1) break;
    if (stuck > 1.6) {
      if (rewHist.length) rewHist[rewHist.length - 1] -= 4;
      rewardSum -= 4;
      break;
    }
  }

  return {
    reward: rewardSum,
    progress: lastProg,
    offFrac: offSteps / Math.max(1, maxSteps),
    lap: kart.lap || 0,
    finished: !!kart.finished,
    obsHist,
    actHist,
    rewHist,
    probHist,
  };
}

function discounts(rewards, gamma) {
  const G = new Float64Array(rewards.length);
  let acc = 0;
  for (let t = rewards.length - 1; t >= 0; t--) {
    acc = rewards[t] + gamma * acc;
    G[t] = acc;
  }
  return G;
}

function trainStep(policy, ep, lr, entropyCoef, baseline) {
  const G = discounts(ep.rewHist, ep.gamma);
  const { W, b } = policy;
  for (let t = 0; t < ep.actHist.length; t++) {
    const adv = G[t] - baseline;
    const obs = ep.obsHist[t];
    const a = ep.actHist[t];
    const p = ep.probHist[t];
    // ∇ log π(a|s) = 1[a] − π ; extra −π term is a cheap entropy bonus
    for (let k = 0; k < N_ACT; k++) {
      const logpi = (k === a ? 1 : 0) - p[k];
      const g = adv * logpi - entropyCoef * p[k];
      b[k] += lr * g;
      const row = k * N_OBS;
      for (let i = 0; i < N_OBS; i++) W[row + i] += lr * g * obs[i];
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const Sim = loadOnlineSim();
  const track = Sim.loadTrackBake(args.track);
  if (!track) {
    console.error(`Track ${args.track} missing. Run: npm run tracks:export`);
    process.exit(1);
  }
  const curv = precomputeCurvature(track);
  const dt = Sim.FIXED_DT;
  const maxSteps = Math.max(60, Math.round(args.seconds / dt));
  const rand = mulberry32(args.seed);

  let policy = args.load ? loadPolicy(args.load) : newPolicy();

  if (args.eval) {
    const ep = runEpisode(Sim, track, curv, policy, { dt, maxSteps, skip: args.skip, greedy: true, rand });
    console.log(JSON.stringify({
      track: args.track,
      progress: Math.round(ep.progress),
      lapFrac: ep.progress / track.totalLen,
      reward: +ep.reward.toFixed(2),
      offFrac: +ep.offFrac.toFixed(3),
      finished: ep.finished,
      totalLen: Math.round(track.totalLen),
    }, null, 2));
    return;
  }

  console.log(`REINFORCE  track=${args.track}  episodes=${args.episodes}  ${args.seconds}s  dt=${dt}  skip=${args.skip}`);
  console.log(`spline pts=${track.spline.length}  lapLen=${Math.round(track.totalLen)}  maxSteps=${maxSteps}`);

  let baseline = 0;
  let bestProg = -Infinity;
  let bestPolicy = clonePolicy(policy);
  const t0 = Date.now();
  let windowR = 0, windowP = 0, windowOff = 0, windowN = 0;
  let stepsDone = 0;

  for (let ep = 1; ep <= args.episodes; ep++) {
    const roll = runEpisode(Sim, track, curv, policy, {
      dt, maxSteps, skip: args.skip, greedy: false, rand,
    });
    roll.gamma = args.gamma;
    stepsDone += maxSteps;
    baseline = baseline * 0.97 + roll.reward * 0.03;
    trainStep(policy, roll, args.lr, args.entropy, baseline);

    windowR += roll.reward;
    windowP += roll.progress;
    windowOff += roll.offFrac;
    windowN++;

    if (roll.progress > bestProg) {
      bestProg = roll.progress;
      bestPolicy = clonePolicy(policy);
    }

    if (ep % 50 === 0 || ep === args.episodes) {
      const elapsed = (Date.now() - t0) / 1000;
      const sps = stepsDone / Math.max(0.001, elapsed);
      console.log(
        `ep ${String(ep).padStart(5)}  ` +
        `R ${ (windowR / windowN).toFixed(1).padStart(7) }  ` +
        `prog ${ Math.round(windowP / windowN).toString().padStart(6) }/${Math.round(track.totalLen)}  ` +
        `off ${(windowOff / windowN).toFixed(2)}  ` +
        `best ${Math.round(bestProg)}  ` +
        `${sps.toFixed(0)} steps/s`
      );
      windowR = windowP = windowOff = windowN = 0;
      savePolicy(bestPolicy, args.out, {
        track: args.track,
        episodes: ep,
        bestProgress: bestProg,
        lapLen: track.totalLen,
      });
    }
  }

  console.log(`Saved best policy (${Math.round(bestProg)} progress) → ${args.out}`);
  console.log(`Eval greedy: npm run rl:train -- --eval --load ${path.relative(root, args.out).replace(/\\/g, "/")} --track ${args.track}`);
}

main();
