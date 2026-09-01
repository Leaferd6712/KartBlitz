/**
 * KartBlitz ML Training Lab — interactive tools (record, review, evaluate).
 * Plain script (no ES modules) so training.html works when opened locally.
 */
(function () {
  function showBootError(msg) {
    const host = document.getElementById("lab-doc-body");
    if (host) {
      host.innerHTML =
        "<h2>Training lab could not start</h2><p>" +
        msg +
        "</p><p>From the project folder run:<br><code>npm run sim:browser</code><br>Then open <code>training.html</code> again (double-click or use <code>npm run training</code>).</p>";
    }
    const statusEl = document.getElementById("lab-status");
    if (statusEl) statusEl.textContent = msg;
  }

  const Env = window.KartBlitzTrainingEnv;
  if (!Env) {
    window.initTrainingLab = function () {
      showBootError("env-browser.js failed to load. Keep the sim/rl/ folder next to training.html.");
    };
    return;
  }

  const {
    ACTIONS,
    N_ACT,
    N_OBS,
    precomputeCurvature,
    observe,
    inputsToAction,
    makeKart,
    progressAlong,
  } = Env;

  const Sim = globalThis.OnlineSim;
  if (!Sim) {
    window.initTrainingLab = function () {
      showBootError("online-sim.js failed to load. Run: npm run sim:browser");
    };
    return;
  }

const DT = Sim.FIXED_DT;
const keys = { up: false, down: false, left: false, right: false };

let state = {
  section: "tool-record",
  trackId: 0,
  track: null,
  curv: null,
  kart: null,
  recording: false,
  frames: [],
  lapStart: null,
  lastProg: 0,
  policy: null,
  evalRunning: false,
  evalGhost: [],
  demoGhost: [],
  raf: 0,
};

const canvas = document.getElementById("lab-canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("lab-status");

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function loadTrack(id) {
  state.trackId = id;
  state.track = Sim.loadTrackBake(id);
  if (!state.track) {
    setStatus(`Track ${id} not found — run npm run tracks:export`);
    return false;
  }
  state.curv = precomputeCurvature(state.track);
  resetKart();
  return true;
}

function resetKart() {
  state.kart = makeKart(Sim, state.track);
  state.lastProg = progressAlong(state.kart, state.track);
  state.lapStart = performance.now();
  state.frames = [];
}

function getKeyboardInput() {
  return {
    up: keys.up,
    down: keys.down,
    left: keys.left,
    right: keys.right,
  };
}

function stepPhysics(inp) {
  const full = Sim.emptyInput();
  full.up = inp.up;
  full.down = inp.down;
  full.left = inp.left;
  full.right = inp.right;
  full.throttle = inp.up ? 1 : 0;
  full.brake = inp.down ? 1 : 0;
  full.steer = inp.left ? -1 : inp.right ? 1 : 0;
  Sim.stepKart(state.kart, full, DT, state.track, [], {
    contact: false,
    resolveCollisions: false,
    nowMs: performance.now(),
  });
}

function recordFrame(inp) {
  const obs = observe(state.kart, state.track, state.curv);
  state.frames.push({
    inputs: { ...inp },
    obs: [...obs],
    action: inputsToAction(inp),
  });
}

function policyForward(obs) {
  const p = state.policy;
  if (!p) return 1;
  if (p.type === "mlp" && p.layers) {
    let x = obs.slice();
    for (let li = 0; li < p.layers.length; li++) {
      const layer = p.layers[li];
      const out = new Array(layer.out).fill(0);
      for (let j = 0; j < layer.out; j++) {
        let s = layer.b[j];
        for (let i = 0; i < layer.in; i++) s += layer.W[j * layer.in + i] * x[i];
        out[j] = li < p.layers.length - 1 ? Math.max(0, s) : s;
      }
      x = out;
    }
    let best = 0;
    for (let i = 1; i < x.length; i++) if (x[i] > x[best]) best = i;
    return best;
  }
  const logits = new Float64Array(N_ACT);
  for (let a = 0; a < N_ACT; a++) {
    let v = p.b[a];
    const row = a * N_OBS;
    for (let i = 0; i < N_OBS; i++) v += p.W[row + i] * obs[i];
    logits[a] = v;
  }
  let best = 0;
  for (let a = 1; a < N_ACT; a++) if (logits[a] > logits[best]) best = a;
  return best;
}

function loadPolicyJson(j) {
  if (j.type === "mlp") {
    state.policy = j;
    return;
  }
  state.policy = {
    W: Float64Array.from(j.W),
    b: Float64Array.from(j.b),
  };
}

function worldToScreen(x, y, cam) {
  const sx = (x - cam.x) * cam.scale + canvas.width * 0.5;
  const sy = (y - cam.y) * cam.scale + canvas.height * 0.5;
  return { sx, sy };
}

function drawTrack(cam) {
  const spl = state.track.spline;
  ctx.strokeStyle = "rgba(80,80,90,0.9)";
  ctx.lineWidth = Math.max(2, state.track.trackWidth * cam.scale * 0.02);
  ctx.beginPath();
  for (let i = 0; i < spl.length; i++) {
    const p = worldToScreen(spl[i].x, spl[i].y, cam);
    if (i === 0) ctx.moveTo(p.sx, p.sy);
    else ctx.lineTo(p.sx, p.sy);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < spl.length; i++) {
    const p = worldToScreen(spl[i].x, spl[i].y, cam);
    if (i === 0) ctx.moveTo(p.sx, p.sy);
    else ctx.lineTo(p.sx, p.sy);
  }
  ctx.stroke();
}

function drawGhost(ghost, color) {
  if (!ghost.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const cam = getCam();
  for (let i = 0; i < ghost.length; i++) {
    const g = ghost[i];
    const p = worldToScreen(g.x, g.y, cam);
    if (i === 0) ctx.moveTo(p.sx, p.sy);
    else ctx.lineTo(p.sx, p.sy);
  }
  ctx.stroke();
}

function getCam() {
  const k = state.kart;
  return { x: k.x, y: k.y, scale: 0.14 };
}

function drawKart(cam, color) {
  const k = state.kart;
  const p = worldToScreen(k.x, k.y, cam);
  ctx.save();
  ctx.translate(p.sx, p.sy);
  ctx.rotate(k.angle);
  ctx.fillStyle = color || "#00f5ff";
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, 7);
  ctx.lineTo(-10, -7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function render() {
  if (!state.track || !state.kart) return;
  const cam = getCam();
  ctx.fillStyle = "#1a1528";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTrack(cam);
  drawGhost(state.demoGhost, "rgba(255,220,80,0.7)");
  drawGhost(state.evalGhost, "rgba(0,245,255,0.5)");
  drawKart(cam, state.evalRunning ? "#ff6b35" : "#00f5ff");

  const prog = progressAlong(state.kart, state.track);
  const lapPct = ((prog % state.track.totalLen) / state.track.totalLen * 100).toFixed(1);
  ctx.fillStyle = "#fff";
  ctx.font = "14px Nunito, sans-serif";
  ctx.fillText(`Track ${state.trackId}  Speed ${Math.abs(state.kart.speed).toFixed(0)}  Lap ${lapPct}%`, 12, 24);
  if (state.recording) ctx.fillText(`REC ${state.frames.length} frames`, 12, 44);
}

function tick() {
  if (!state.track || !state.kart) {
    state.raf = requestAnimationFrame(tick);
    return;
  }

  if (state.section === "tool-record" && state.recording) {
    const inp = getKeyboardInput();
    stepPhysics(inp);
    recordFrame(inp);
    state.evalGhost.push({ x: state.kart.x, y: state.kart.y });
    if (state.evalGhost.length > 8000) state.evalGhost.shift();
  } else if (state.section === "tool-eval" && state.evalRunning && state.policy) {
    const obs = observe(state.kart, state.track, state.curv);
    const act = policyForward(obs);
    stepPhysics({
      up: ACTIONS[act].up,
      down: ACTIONS[act].down,
      left: ACTIONS[act].left,
      right: ACTIONS[act].right,
    });
    state.evalGhost.push({ x: state.kart.x, y: state.kart.y });
    if (state.evalGhost.length > 12000) state.evalGhost.shift();
    if (state.kart.finished || (state.kart.lap || 0) >= 1) {
      state.evalRunning = false;
      setStatus("Policy eval: lap complete or finished");
    }
  }

  render();
  state.raf = requestAnimationFrame(tick);
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportDemo() {
  if (state.frames.length < 60) {
    setStatus("Record at least ~1 second of driving before saving");
    return;
  }
  const demo = {
    version: 1,
    trackId: state.trackId,
    weather: "dry",
    tyreId: "med",
    dt: DT,
    frames: state.frames,
  };
  const name = `demo_track${state.trackId}_${Date.now()}.json`;
  downloadJson(demo, name);
  setStatus(`Saved ${name} — move to sim/rl/demos/`);
}

function loadDemoFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const demo = JSON.parse(reader.result);
      if (!demo.frames || !demo.frames.length) throw new Error("empty frames");
      if (demo.trackId != null) loadTrack(demo.trackId);
      state.demoGhost = [];
      let x = state.track.startPos.x;
      let y = state.track.startPos.y;
      for (const f of demo.frames) {
        if (f.x != null) {
          x = f.x;
          y = f.y;
        } else if (state.demoGhost.length === 0) {
          x = state.track.startPos.x;
          y = state.track.startPos.y;
        }
        state.demoGhost.push({ x, y });
      }
      const off = demo.frames.filter((f) => f.obs && f.obs[8] > 0.5).length;
      const pct = ((off / demo.frames.length) * 100).toFixed(1);
      setStatus(`Demo loaded: ${demo.frames.length} frames, off-track ${pct}%`);
      state.section = "tool-review";
      showSection("tool-review");
    } catch (e) {
      setStatus("Demo load failed: " + e.message);
    }
  };
  reader.readAsText(file);
}

function loadPolicyFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const j = JSON.parse(reader.result);
      loadPolicyJson(j);
      resetKart();
      state.evalGhost = [];
      state.evalRunning = true;
      setStatus(`Policy loaded (${j.type || "linear"}) — eval running`);
      state.section = "tool-eval";
      showSection("tool-eval");
    } catch (e) {
      setStatus("Policy load failed: " + e.message);
    }
  };
  reader.readAsText(file);
}

function bindTools() {
  const trackSel = document.getElementById("track-select");
  if (trackSel) {
    const ids = Sim.listTrackIds();
    trackSel.innerHTML = ids.map((id) => `<option value="${id}">Track ${id}</option>`).join("");
    trackSel.value = String(state.trackId);
    trackSel.onchange = () => {
      loadTrack(Number(trackSel.value));
      setStatus(`Track ${trackSel.value} loaded`);
    };
  }

  document.getElementById("btn-start-rec")?.addEventListener("click", () => {
    resetKart();
    state.recording = true;
    state.evalGhost = [];
    setStatus("Recording — drive with WASD / arrows");
  });
  document.getElementById("btn-stop-rec")?.addEventListener("click", () => {
    state.recording = false;
    setStatus(`Stopped — ${state.frames.length} frames captured`);
  });
  document.getElementById("btn-save-demo")?.addEventListener("click", exportDemo);

  document.getElementById("demo-file")?.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) loadDemoFile(f);
  });
  document.getElementById("policy-file")?.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) loadPolicyFile(f);
  });
  document.getElementById("btn-reset-eval")?.addEventListener("click", () => {
    resetKart();
    state.evalGhost = [];
    state.evalRunning = !!state.policy;
    setStatus(state.policy ? "Eval restarted" : "Load a policy first");
  });
  document.getElementById("btn-stop-eval")?.addEventListener("click", () => {
    state.evalRunning = false;
    setStatus("Eval paused");
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyW" || e.code === "ArrowUp") keys.up = true;
    if (e.code === "KeyS" || e.code === "ArrowDown") keys.down = true;
    if (e.code === "KeyA" || e.code === "ArrowLeft") keys.left = true;
    if (e.code === "KeyD" || e.code === "ArrowRight") keys.right = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "KeyW" || e.code === "ArrowUp") keys.up = false;
    if (e.code === "KeyS" || e.code === "ArrowDown") keys.down = false;
    if (e.code === "KeyA" || e.code === "ArrowLeft") keys.left = false;
    if (e.code === "KeyD" || e.code === "ArrowRight") keys.right = false;
  });
}

function showSection(id) {
  state.section = id;
  document.querySelectorAll(".lab-panel").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.section !== id);
  });
  document.querySelectorAll(".lab-nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.section === id);
  });
  const isTool = id.startsWith("tool-");
  document.getElementById("lab-tool-wrap")?.classList.toggle("hidden", !isTool);
  document.getElementById("lab-doc-wrap")?.classList.toggle("hidden", isTool);
  if (!isTool) {
    const doc = DOC_BY_ID.get(id);
    const host = document.getElementById("lab-doc-body");
    if (doc && host) {
      host.innerHTML = doc.html;
      host.querySelectorAll("pre[data-copy]").forEach((pre) => {
        if (pre.querySelector(".copy-btn")) return;
        const code = pre.querySelector("code");
        if (!code) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "copy-btn";
        btn.textContent = "Copy";
        btn.onclick = () => navigator.clipboard.writeText(code.textContent);
        pre.style.position = "relative";
        pre.appendChild(btn);
      });
    }
  }
}

const Docs = window.TrainingLabDocs;
const DOC_BY_ID = new Map(Docs.DOC_SECTIONS.map((d) => [d.id, d]));

function initTrainingLab() {
  bindTools();
  const nav = document.getElementById("lab-nav");
  if (nav) {
    for (const item of Docs.allNavItems()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lab-nav-item";
      btn.dataset.section = item.id;
      btn.textContent = item.title;
      btn.onclick = () => showSection(item.id);
      nav.appendChild(btn);
    }
  }
  document.querySelectorAll("pre[data-copy] code").forEach((code) => {
    const pre = code.parentElement;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.onclick = () => navigator.clipboard.writeText(code.textContent);
    pre.style.position = "relative";
    pre.appendChild(btn);
  });
  loadTrack(0);
  showSection("getting-started");
  tick();
  setStatus("Ready — open Getting Started or Record Demo");
}

window.initTrainingLab = initTrainingLab;
window.showTrainingSection = showSection;
})();
