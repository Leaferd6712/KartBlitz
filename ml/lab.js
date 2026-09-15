(function () {
  'use strict';

  const ENABLE_KEY = 'kartblitz_ml_lab_enabled';
  const PLAYER_MODEL_KEY = 'kartblitz_ml_player_model';
  const TRAINER_URL_KEY = 'kartblitz_ml_trainer_url';
  const TRAINER_CODE_KEY = 'kartblitz_ml_pairing_code';
  const Runtime = window.KartBlitzMLRuntime;
  if (!Runtime) { console.error('KartBlitz ML runtime did not load.'); return; }

  const state = {
    enabled: read(ENABLE_KEY) === '1',
    selectedModel: 'ours',
    selectedTrack: 0,
    ourModel: Runtime.DEFAULT_MODEL,
    playerModel: parseStoredModel(),
    trainerUrl: read(TRAINER_URL_KEY) || 'http://127.0.0.1:8765',
    pairingCode: read(TRAINER_CODE_KEY) || '',
    trainer: null,
    job: null,
    pollTimer: null,
    tracks: null,
    snapshots: [],
    frame: 0,
    raf: 0
  };

  function read(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  function parseStoredModel() {
    try {
      const parsed = JSON.parse(read(PLAYER_MODEL_KEY) || 'null');
      if (parsed) Runtime.validateModel(parsed);
      return parsed;
    } catch (_) { return null; }
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function getTracks() {
    try { if (Array.isArray(TRACKS)) return TRACKS; } catch (_) {}
    return Array.from({ length: 8 }, (_, id) => ({ id, name: `TRACK ${id + 1}` }));
  }

  function installScreen() {
    if (!document.getElementById('ml-lab-menu-btn')) {
      const actions = document.querySelector('#screen-menu .menu-actions');
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'ml-lab-menu-btn';
      button.className = 'btn btn-sm';
      button.style.color = '#67e8f9';
      button.textContent = ' ML LAB';
      button.onclick = () => { if (typeof initAudio === 'function') initAudio(); if (typeof playUIClick === 'function') playUIClick(); open(); };
      if (actions) actions.insertBefore(button, actions.lastElementChild);
    }
    if (document.getElementById('screen-ml-lab')) return;
    const screen = document.createElement('div');
    screen.id = 'screen-ml-lab';
    screen.className = 'screen hidden';
    screen.innerHTML = `
      <div class="scanlines"></div>
      <button class="back-btn" type="button" onclick="KartBlitzMLLab.close()">← BACK</button>
      <main class="ml-shell">
        <div class="ml-topbar">
          <div><div class="ml-eyebrow">LEARN · TRAIN · RACE</div><h1 class="ml-title">ML LAB</h1><div class="ml-subtitle">Build a track-relative driving policy, train it with Python and PyTorch, watch it improve, then race against its exported weights.</div></div>
          <span class="ml-badge" id="ml-device-badge">TRAINER OFFLINE</span>
        </div>
        <nav class="ml-tabs" aria-label="ML Lab steps">
          <button class="ml-tab active" data-tab="learn">1 · LEARN</button>
          <button class="ml-tab" data-tab="build">2 · BUILD</button>
          <button class="ml-tab" data-tab="train">3 · TRAIN</button>
          <button class="ml-tab" data-tab="replay">4 · WATCH</button>
          <button class="ml-tab" data-tab="race">5 · RACE</button>
        </nav>
        <section class="ml-panel active" data-panel="learn">
          <div class="ml-grid">
            <div class="ml-card"><span class="ml-badge">THE LOOP</span><h3>Teach through consequences</h3><div class="ml-lesson"><div class="ml-lesson-num">1</div><div><strong>Observe</strong><span>The model reads speed, track offset, heading, upcoming corners, progress and whether it is stuck.</span></div></div><div class="ml-lesson"><div class="ml-lesson-num">2</div><div><strong>Act</strong><span>It chooses throttle, coast or brake plus left, straight or right.</span></div></div><div class="ml-lesson"><div class="ml-lesson-num">3</div><div><strong>Reward</strong><span>Good progress earns points; leaving the circuit, reversing and stalling lose points.</span></div></div></div>
            <div class="ml-card"><span class="ml-badge player">GENERALISATION</span><h3>One driver, every circuit</h3><p>Coordinates are deliberately excluded. Every sensor is relative to the kart and nearby racing line, so the same policy can understand different circuit shapes.</p><div class="ml-note">Training rotates through all KartBlitz tracks and random starting positions. A model is only labelled release-ready after separate per-track evaluation.</div><button class="ml-btn primary" onclick="KartBlitzMLLab.tab('build')">BUILD MY MODEL →</button></div>
          </div>
        </section>
        <section class="ml-panel" data-panel="build">
          <div class="ml-grid">
            <div class="ml-card"><span class="ml-badge">FIXED CONTRACT</span><h3>Sensors and actions</h3><p>Fourteen normalized, track-relative sensors feed a small neural network. Nine discrete driving actions keep training understandable and browser inference fast.</p><div class="ml-status"><div class="ml-stat"><span>INPUTS</span><strong>14</strong></div><div class="ml-stat"><span>ACTIONS</span><strong>9</strong></div><div class="ml-stat"><span>HIDDEN</span><strong>64×64</strong></div><div class="ml-stat"><span>METHOD</span><strong>PPO</strong></div></div><div class="ml-note">The contract is fixed so exported weights cannot silently use different sensors than the game.</div></div>
            <div class="ml-card"><span class="ml-badge player">YOUR REWARD</span><h3>What should the driver value?</h3><div id="ml-reward-fields"></div><button class="ml-btn primary" onclick="KartBlitzMLLab.tab('train')">USE THIS REWARD →</button></div>
          </div>
        </section>
        <section class="ml-panel" data-panel="train">
          <div class="ml-grid">
            <div class="ml-card"><span class="ml-badge">LOCAL PYTHON</span><h3>Connect the CUDA trainer</h3><p>Start <code>python -m ml_training.server</code> from the project, then enter the pairing code printed in the terminal.</p><div class="ml-actions"><input id="ml-trainer-url" class="ml-input" aria-label="Trainer URL"><input id="ml-pairing-code" class="ml-input" maxlength="12" placeholder="PAIRING CODE" aria-label="Pairing code"><button class="ml-btn" onclick="KartBlitzMLLab.connect()">CONNECT</button></div><div class="ml-actions" style="margin-top:12px"><button class="ml-btn primary" onclick="KartBlitzMLLab.downloadTrainerPack(this)">DOWNLOAD TRAINER PACK (.ZIP)</button><a class="ml-btn" href="ml_training/KartBlitz-ML-Setup.txt" download>SETUP GUIDE (.TXT)</a></div><div id="ml-connect-note" class="ml-note">Training runs outside the browser. PyTorch selects CUDA when available and safely falls back to CPU.</div></div>
            <div class="ml-card"><span class="ml-badge player">TRAINING RUN</span><h3>Train across KartBlitz</h3><label class="ml-field"><span>Training preset</span><select class="ml-select" id="ml-preset"><option value="quick">Quick lesson · 150k steps</option><option value="standard" selected>Standard · 750k steps</option><option value="deep">Deep · 2.5m steps</option></select></label><div class="ml-actions"><button id="ml-start-btn" class="ml-btn primary" onclick="KartBlitzMLLab.startTraining()">START TRAINING</button><button class="ml-btn" onclick="KartBlitzMLLab.exportConfig()">EXPORT JOB</button></div><div class="ml-progress"><i id="ml-progress-bar"></i></div><div class="ml-status"><div class="ml-stat"><span>STATUS</span><strong id="ml-job-status">READY</strong></div><div class="ml-stat"><span>STEP</span><strong id="ml-job-step">0</strong></div><div class="ml-stat"><span>REWARD</span><strong id="ml-job-reward">—</strong></div><div class="ml-stat"><span>DEVICE</span><strong id="ml-job-device">—</strong></div></div><div class="ml-console" id="ml-console">Waiting for a training run…</div></div>
          </div>
        </section>
        <section class="ml-panel" data-panel="replay">
          <div class="ml-card"><span class="ml-badge">CHECKPOINT REPLAY</span><h3>Watch learning become a racing line</h3><p>Early, middle and final checkpoints are overlaid on a real KartBlitz circuit. Cleaner lines and fewer off-track excursions show improvement more honestly than reward alone.</p><div class="ml-canvas-wrap"><canvas id="ml-replay-canvas" width="1000" height="380"></canvas><div class="ml-canvas-label" id="ml-replay-label">BASELINE PREVIEW</div></div><div class="ml-actions" style="margin-top:12px"><button class="ml-btn" onclick="KartBlitzMLLab.replayTrack(-1)">← TRACK</button><button class="ml-btn" onclick="KartBlitzMLLab.replayTrack(1)">TRACK →</button></div></div>
        </section>
        <section class="ml-panel" data-panel="race">
          <div class="ml-grid"><div class="ml-card" id="ml-model-ours"><span class="ml-badge">OUR MODEL</span><h3 id="ml-ours-name">KartBlitz Pre-Tuned Driver</h3><p>The existing hand-tuned KartBlitz driver. Use it as a dependable reference when judging Your Model.</p><button class="ml-btn primary" onclick="KartBlitzMLLab.selectModel('ours')">SELECT OUR MODEL</button></div><div class="ml-card" id="ml-model-player"><span class="ml-badge player">YOUR MODEL</span><h3 id="ml-player-name">No trained weights</h3><p id="ml-player-copy">Train with the Python companion or import a KartBlitz model file.</p><div class="ml-actions"><button id="ml-select-player" class="ml-btn pink" onclick="KartBlitzMLLab.selectModel('player')">SELECT YOUR MODEL</button><button class="ml-btn" onclick="document.getElementById('ml-import-file').click()">IMPORT</button><button id="ml-export-model" class="ml-btn" onclick="KartBlitzMLLab.exportModel()">EXPORT</button><input hidden id="ml-import-file" type="file" accept=".json,.kartml.json"></div></div></div>
          <div class="ml-card" style="margin-top:14px"><span class="ml-badge ok">RACE SETUP</span><h3>Choose a circuit</h3><div class="ml-track-grid" id="ml-track-grid"></div><div class="ml-actions"><button class="ml-btn primary" onclick="KartBlitzMLLab.launchRace()">RACE SELECTED MODEL</button></div><div class="ml-note">This launches a standard KartBlitz race against the selected driver. “Our Model” and “Your Model” are the only ML Lab choices.</div></div>
        </section>
      </main>`;
    document.body.appendChild(screen);
    screen.querySelectorAll('.ml-tab').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
    document.getElementById('ml-import-file').addEventListener('change', importModel);
    document.getElementById('ml-trainer-url').value = state.trainerUrl;
    document.getElementById('ml-pairing-code').value = state.pairingCode;
    renderRewards(); renderRace(); updateVisibility(); loadTracks();
  }

  const rewardDefs = [
    ['progress', 'Forward progress', 1.0, 0, 2, 'Rewards moving around the circuit in the correct direction.'],
    ['speed', 'Useful speed', 0.25, 0, 1, 'Rewards speed only while aligned with the track.'],
    ['center', 'Racing-line control', 0.18, 0, 1, 'Rewards remaining near the centre without forcing a single exact line.'],
    ['offTrack', 'Off-track penalty', 1.2, 0, 3, 'Discourages cutting grass and leaving the circuit.'],
    ['stuck', 'Stuck penalty', 0.8, 0, 3, 'Discourages spinning, reversing or failing to make progress.'],
    ['lap', 'Lap completion', 2.0, 0, 5, 'Adds a sparse bonus for completing a full lap.']
  ];
  function renderRewards() {
    const host = document.getElementById('ml-reward-fields'); if (!host) return;
    host.innerHTML = rewardDefs.map(([id, label, value, min, max, desc]) => `<div class="ml-field"><label for="ml-r-${id}"><span>${label}</span><b id="ml-rv-${id}">${value.toFixed(2)}</b></label><input id="ml-r-${id}" type="range" min="${min}" max="${max}" step="0.05" value="${value}" oninput="document.getElementById('ml-rv-${id}').textContent=Number(this.value).toFixed(2)"><small>${desc}</small></div>`).join('');
  }
  function rewards() { return Object.fromEntries(rewardDefs.map(([id]) => [id, Number(document.getElementById(`ml-r-${id}`).value)])); }

  function settingsMarkup() {
    return `<div class="howto-section" style="width:min(560px,94vw);"><div class="howto-heading"> ML LAB</div><div class="ml-settings-row"><p>Show the optional machine-learning tutorial, Python/CUDA trainer and model racing tools on the main menu.</p><button type="button" class="key-btn ml-toggle${state.enabled ? ' key-btn-active' : ''}" onclick="KartBlitzMLLab.setEnabled(${!state.enabled});playUIClick();buildSettingsPane();" aria-pressed="${state.enabled}">ML LAB: ${state.enabled ? 'ON' : 'OFF'}</button></div></div>`;
  }
  function hookSettings() {
    if (window.__kartblitzMLSettingsHooked || typeof window.buildSettingsPane !== 'function') return;
    window.__kartblitzMLSettingsHooked = true;
    const original = window.buildSettingsPane;
    window.buildSettingsPane = function () {
      const result = original.apply(this, arguments);
      const pane = document.getElementById('ctrl-pane-settings');
      if (pane && !pane.querySelector('.ml-settings-row')) pane.insertAdjacentHTML('beforeend', settingsMarkup());
      return result;
    };
  }
  function setEnabled(value) { state.enabled = !!value; write(ENABLE_KEY, state.enabled ? '1' : '0'); updateVisibility(); }
  function updateVisibility() { const b = document.getElementById('ml-lab-menu-btn'); if (b) b.hidden = !state.enabled; }

  function open() { if (!state.enabled) return; if (typeof showScreen === 'function') showScreen('ml-lab'); tab('learn'); }
  function close() { stopReplay(); if (typeof showScreen === 'function') showScreen('menu'); }
  function tab(name) {
    document.querySelectorAll('#screen-ml-lab .ml-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('#screen-ml-lab .ml-panel').forEach(x => x.classList.toggle('active', x.dataset.panel === name));
    if (name === 'replay') startReplay(); else stopReplay();
    if (name === 'race') renderRace();
  }

  async function loadTracks() {
    try {
      const response = await fetch('sim/tracks/bakes.json');
      const payload = await response.json();
      const raw = payload.tracks || payload;
      state.tracks = Array.isArray(raw) ? raw : Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map(key => raw[key]);
    } catch (_) { state.tracks = null; }
  }
  async function loadOurModel() {
    try {
      const response = await fetch('ml/models/our-model.json');
      const model = await response.json(); Runtime.validateModel(model); state.ourModel = model;
    } catch (_) { state.ourModel = Runtime.DEFAULT_MODEL; }
    renderRace();
  }

  function trainingConfig() {
    const preset = document.getElementById('ml-preset').value;
    const steps = { quick: 150000, standard: 750000, deep: 2500000 }[preset];
    return { format: 'kartblitz-training-job-v1', preset, totalSteps: steps, numEnvs: preset === 'deep' ? 96 : 64, tracks: 'all', rewards: rewards(), seed: 42 };
  }
  async function connect() {
    state.trainerUrl = document.getElementById('ml-trainer-url').value.trim().replace(/\/$/, '');
    state.pairingCode = document.getElementById('ml-pairing-code').value.trim();
    write(TRAINER_URL_KEY, state.trainerUrl); write(TRAINER_CODE_KEY, state.pairingCode);
    const note = document.getElementById('ml-connect-note');
    try {
      const response = await fetch(`${state.trainerUrl}/api/status`, { signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.trainer = await response.json();
      const cuda = state.trainer.cudaAvailable;
      note.textContent = state.trainer.torchInstalled ? `${state.trainer.torchVersion} ready · ${cuda ? state.trainer.deviceName : 'CPU fallback'} · ${state.trainer.trackCount} tracks loaded` : 'PyTorch is not installed. Run the provided install script first.';
      document.getElementById('ml-device-badge').textContent = cuda ? 'CUDA READY' : (state.trainer.torchInstalled ? 'CPU READY' : 'PYTORCH MISSING');
      document.getElementById('ml-device-badge').className = `ml-badge ${state.trainer.torchInstalled ? 'ok' : 'warn'}`;
    } catch (error) { state.trainer = null; note.textContent = `Could not reach the local trainer: ${error.message}`; }
  }
  async function startTraining() {
    if (!state.trainer) await connect();
    if (!state.trainer || !state.trainer.torchInstalled) return;
    const button = document.getElementById('ml-start-btn'); button.disabled = true;
    try {
      const response = await fetch(`${state.trainerUrl}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KartBlitz-Key': state.pairingCode }, body: JSON.stringify(trainingConfig()) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      state.job = payload; pollJob();
    } catch (error) { log(`Training could not start: ${error.message}`); button.disabled = false; }
  }
  async function pollJob() {
    clearTimeout(state.pollTimer);
    if (!state.job) return;
    try {
      const response = await fetch(`${state.trainerUrl}/api/jobs/${encodeURIComponent(state.job.id)}`, { headers: { 'X-KartBlitz-Key': state.pairingCode } });
      const job = await response.json(); if (!response.ok) throw new Error(job.error || `HTTP ${response.status}`); state.job = job; updateJob(job);
      if (job.status === 'complete') {
        Runtime.validateModel(job.model); state.playerModel = job.model; write(PLAYER_MODEL_KEY, JSON.stringify(job.model)); state.snapshots = job.snapshots || [];
        document.getElementById('ml-start-btn').disabled = false; renderRace(); tab('replay'); return;
      }
      if (job.status === 'failed') { document.getElementById('ml-start-btn').disabled = false; return; }
      state.pollTimer = setTimeout(pollJob, 900);
    } catch (error) { log(`Trainer connection interrupted: ${error.message}`); state.pollTimer = setTimeout(pollJob, 2500); }
  }
  function updateJob(job) {
    const progress = Math.round(100 * (job.step || 0) / Math.max(1, job.totalSteps || 1));
    document.getElementById('ml-progress-bar').style.width = `${progress}%`;
    document.getElementById('ml-job-status').textContent = String(job.status || 'running').toUpperCase();
    document.getElementById('ml-job-step').textContent = Number(job.step || 0).toLocaleString();
    document.getElementById('ml-job-reward').textContent = Number.isFinite(job.meanReward) ? job.meanReward.toFixed(2) : '—';
    document.getElementById('ml-job-device').textContent = job.device || '—';
    log((job.logs || []).slice(-8).join('\n') || `Training ${progress}% complete…`, true);
  }
  function log(message, replace) { const el = document.getElementById('ml-console'); if (!el) return; el.textContent = replace ? message : `${el.textContent}\n${message}`; el.scrollTop = el.scrollHeight; }

  function download(name, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }
  function zipChunk(size) { return new Uint8Array(size); }
  function set16(bytes, offset, value) { new DataView(bytes.buffer).setUint16(offset, value, true); }
  function set32(bytes, offset, value) { new DataView(bytes.buffer).setUint32(offset, value >>> 0, true); }
  function makeZip(files) {
    const encoder = new TextEncoder(); const locals = []; const centrals = []; let offset = 0;
    files.forEach(file => {
      const name = encoder.encode(file.path.replace(/\\/g, '/')); const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data; const checksum = crc32(data);
      const local = zipChunk(30 + name.length + data.length); set32(local, 0, 0x04034b50); set16(local, 4, 20); set16(local, 6, 0x0800); set16(local, 8, 0); set32(local, 14, checksum); set32(local, 18, data.length); set32(local, 22, data.length); set16(local, 26, name.length); local.set(name, 30); local.set(data, 30 + name.length); locals.push(local);
      const central = zipChunk(46 + name.length); set32(central, 0, 0x02014b50); set16(central, 4, 20); set16(central, 6, 20); set16(central, 8, 0x0800); set16(central, 10, 0); set32(central, 16, checksum); set32(central, 20, data.length); set32(central, 24, data.length); set16(central, 28, name.length); set32(central, 42, offset); central.set(name, 46); centrals.push(central); offset += local.length;
    });
    const centralSize = centrals.reduce((sum, item) => sum + item.length, 0); const end = zipChunk(22); set32(end, 0, 0x06054b50); set16(end, 8, files.length); set16(end, 10, files.length); set32(end, 12, centralSize); set32(end, 16, offset);
    return new Blob([...locals, ...centrals, end], { type: 'application/zip' });
  }
  async function downloadTrainerPack(button) {
    if (button) { button.disabled = true; button.textContent = 'BUILDING ZIP…'; }
    const paths = ['ml_training/__init__.py', 'ml_training/environment.py', 'ml_training/model.py', 'ml_training/train.py', 'ml_training/server.py', 'ml_training/requirements.txt', 'ml_training/install.ps1', 'ml_training/start.ps1', 'ml_training/README.md', 'ml_training/KartBlitz-ML-Setup.txt', 'sim/tracks/bakes.json'];
    try {
      const files = await Promise.all(paths.map(async path => { const response = await fetch(path); if (!response.ok) throw new Error(`Could not fetch ${path}`); return { path, data: new Uint8Array(await response.arrayBuffer()) }; }));
      const blob = makeZip(files); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'KartBlitz-ML-Trainer.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (error) { alert(`Trainer pack download failed: ${error.message}`); }
    finally { if (button) { button.disabled = false; button.textContent = 'DOWNLOAD TRAINER PACK (.ZIP)'; } }
  }
  function exportConfig() { download('kartblitz-training-job.json', trainingConfig()); }
  function exportModel() { if (state.playerModel) download(`${state.playerModel.id || 'your-kartblitz-model'}.kartml.json`, state.playerModel); }
  async function importModel(event) {
    const file = event.target.files && event.target.files[0]; if (!file) return;
    try { const model = JSON.parse(await file.text()); Runtime.validateModel(model); model.source = 'player'; state.playerModel = model; write(PLAYER_MODEL_KEY, JSON.stringify(model)); renderRace(); }
    catch (error) { alert(`Could not import model: ${error.message}`); }
    event.target.value = '';
  }

  function selectModel(which) { if (which === 'player' && !state.playerModel) return; state.selectedModel = which; renderRace(); }
  function selectTrack(id) { state.selectedTrack = Number(id) || 0; renderRace(); }
  function renderRace() {
    const ours = document.getElementById('ml-model-ours'); if (!ours) return;
    ours.classList.toggle('selected', state.selectedModel === 'ours');
    const player = document.getElementById('ml-model-player'); player.classList.toggle('selected', state.selectedModel === 'player');
    document.getElementById('ml-ours-name').textContent = 'KartBlitz Pre-Tuned Driver';
    document.getElementById('ml-player-name').textContent = state.playerModel ? state.playerModel.name : 'No trained weights';
    document.getElementById('ml-player-copy').textContent = state.playerModel ? `${state.playerModel.training && state.playerModel.training.algorithm || 'PPO'} · ${(state.playerModel.training && state.playerModel.training.totalSteps || 0).toLocaleString()} steps` : 'Train with the Python companion or import a KartBlitz model file.';
    document.getElementById('ml-select-player').disabled = !state.playerModel;
    document.getElementById('ml-export-model').disabled = !state.playerModel;
    const grid = document.getElementById('ml-track-grid');
    grid.innerHTML = getTracks().map(track => `<button class="ml-track${Number(track.id) === state.selectedTrack ? ' selected' : ''}" onclick="KartBlitzMLLab.selectTrack(${Number(track.id)})">${esc(track.name)}</button>`).join('');
  }
  function launchRace() {
    const model = state.selectedModel === 'player' ? state.playerModel : state.ourModel;
    if (!model) return;
    Runtime.validateModel(model);
    const config = { modelType: state.selectedModel, model, trackId: state.selectedTrack };
    const pd = typeof getPlayerData === 'function' ? getPlayerData() : null;
    if (pd) { pd.selectedLaps = 3; if (typeof savePlayerData === 'function') savePlayerData(pd); }
    if (typeof window.startMLLabRace === 'function') window.startMLLabRace(state.selectedTrack, config);
    else throw new Error('KartBlitz ML race bridge is unavailable.');
  }

  function replayTrack(delta) { const count = Math.max(1, (state.tracks || getTracks()).length); state.selectedTrack = (state.selectedTrack + delta + count) % count; state.frame = 0; }
  function startReplay() { stopReplay(); state.frame = 0; drawReplay(); }
  function stopReplay() { if (state.raf) cancelAnimationFrame(state.raf); state.raf = 0; }
  function drawReplay() {
    const canvas = document.getElementById('ml-replay-canvas'); if (!canvas) return;
    const ctx = canvas.getContext('2d'); const all = state.tracks; const track = all && (all.find(t => Number(t.id) === state.selectedTrack) || all[0]);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!track || !track.spline || !track.spline.length) { ctx.fillStyle = '#9eb3c5'; ctx.font = '16px Nunito'; ctx.fillText('Loading track geometry…', 30, 50); state.raf = requestAnimationFrame(drawReplay); return; }
    const pts = track.spline; const xs = pts.map(p => p.x), ys = pts.map(p => p.y); const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys); const scale = Math.min((canvas.width - 80) / Math.max(1, maxX - minX), (canvas.height - 60) / Math.max(1, maxY - minY)); const ox = (canvas.width - (maxX - minX) * scale) / 2, oy = (canvas.height - (maxY - minY) * scale) / 2; const map = p => ({ x: ox + (p.x - minX) * scale, y: oy + (p.y - minY) * scale });
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#163448'; ctx.lineWidth = Math.max(9, (track.trackWidth || 160) * scale); ctx.beginPath(); pts.forEach((p, i) => { const q = map(p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); ctx.stroke(); ctx.strokeStyle = 'rgba(0,245,255,.32)'; ctx.lineWidth = 1.5; ctx.stroke();
    const colors = ['#f97316', '#facc15', '#4ade80']; const actual = state.snapshots.filter(snapshot => Number(snapshot.trackId) === state.selectedTrack && Array.isArray(snapshot.points) && snapshot.points.length > 1).slice(0, 3); const t = state.frame * 0.004;
    if (actual.length) {
      actual.forEach((snapshot, car) => {
        ctx.strokeStyle = colors[car] || '#4ade80'; ctx.globalAlpha = .42 + car * .18; ctx.lineWidth = 2; ctx.beginPath(); snapshot.points.forEach((point, i) => { const q = map(point); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke(); ctx.globalAlpha = 1;
        const point = snapshot.points[Math.floor((t + car * .04) * snapshot.points.length) % snapshot.points.length]; const q = map(point); ctx.fillStyle = colors[car]; ctx.shadowColor = colors[car]; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(q.x, q.y, 5 + car, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; ctx.font = '900 9px Nunito'; ctx.fillText(String(snapshot.label || `CHECKPOINT ${car + 1}`).toUpperCase(), 18, canvas.height - 52 + car * 16);
      });
    } else {
      const labels = ['EARLY', 'MIDDLE', state.playerModel ? 'YOUR FINAL MODEL' : 'PRE-TUNED BASELINE'];
      for (let car = 0; car < 3; car++) { const phase = (t + car * 0.025) % 1; const idx = Math.floor(phase * pts.length) % pts.length; const p = pts[idx], next = pts[(idx + 2) % pts.length]; const dx = next.x - p.x, dy = next.y - p.y, len = Math.hypot(dx, dy) || 1; const noise = car === 0 ? Math.sin(state.frame * .035) * (track.trackWidth || 160) * .35 : car === 1 ? Math.sin(state.frame * .02) * (track.trackWidth || 160) * .12 : 0; const q = map({ x: p.x - dy / len * noise, y: p.y + dx / len * noise }); ctx.fillStyle = colors[car]; ctx.shadowColor = colors[car]; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(q.x, q.y, 5 + car, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; ctx.fillStyle = colors[car]; ctx.font = '900 9px Nunito'; ctx.fillText(labels[car], 18, canvas.height - 52 + car * 16); }
    }
    const gameTrack = getTracks().find(t => Number(t.id) === state.selectedTrack); document.getElementById('ml-replay-label').textContent = `${gameTrack ? gameTrack.name : `TRACK ${state.selectedTrack + 1}`} · CHECKPOINT COMPARISON`;
    state.frame++; state.raf = requestAnimationFrame(drawReplay);
  }

  function boot() { installScreen(); hookSettings(); loadOurModel(); }
  window.KartBlitzMLLab = { open, close, tab, setEnabled, settingsMarkup, connect, startTraining, exportConfig, exportModel, downloadTrainerPack, selectModel, selectTrack, launchRace, replayTrack };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
