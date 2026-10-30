import { sampleLap, nearestLapTime, replayBounds } from '../sim/lap-replay.mjs';

const dialog = document.createElement('dialog');
dialog.className = 'lap-replay';
dialog.id = 'lap-replay-dialog';
dialog.setAttribute('aria-labelledby', 'lap-replay-title');
dialog.innerHTML = `
  <header><div><p>LEADERBOARD LAP REPLAY</p><h2 id="lap-replay-title">Loading lap…</h2><p id="lap-replay-detail"></p></div><button type="button" id="lap-replay-close" aria-label="Close lap replay">CLOSE</button></header>
  <p id="lap-replay-status" role="status" aria-live="polite"></p>
  <div id="lap-replay-content" hidden>
    <div class="lap-replay-views">
      <figure><canvas id="lap-replay-camera" aria-label="Recorded lap using the game follow camera"></canvas><figcaption>Game follow camera · recorded playback</figcaption></figure>
      <figure><canvas id="lap-replay-map" tabindex="0" role="img" aria-label="Recorded racing line. Click the line to seek; use arrow keys to move through the lap."></canvas><figcaption>Full track · click the line to inspect that moment</figcaption></figure>
    </div>
    <div class="lap-replay-legend"><span style="--line:#6ee7a0">Throttle</span><span style="--line:#ffb454">Brake</span><span style="--line:#88b9ff">Coast</span><span style="--line:#ff6c86">Off track</span></div>
    <div class="lap-replay-controls">
      <button type="button" id="lap-replay-play">PLAY</button><button type="button" id="lap-replay-restart">RESTART</button>
      <button type="button" id="lap-replay-back" aria-label="Back one second">−1s</button><button type="button" id="lap-replay-forward" aria-label="Forward one second">+1s</button>
      <label>Speed <select id="lap-replay-rate" aria-label="Playback speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label>
      <label><input type="checkbox" id="lap-replay-line" checked>Show line</label><label><input type="checkbox" id="lap-replay-loop">Loop</label>
      <button type="button" id="lap-replay-download">DOWNLOAD REPLAY</button><button type="button" id="lap-replay-race">RACE GHOST</button>
    </div>
    <input class="lap-replay-timeline" id="lap-replay-seek" type="range" min="0" max="1" step="0.001" value="0" aria-label="Lap replay position">
    <div class="lap-replay-readout"><output id="lap-replay-time"></output><span id="lap-replay-progress"></span></div>
    <div class="lap-replay-telemetry">
      <span>Speed<b id="lap-replay-speed"></b></span><span>Pedals<b id="lap-replay-pedals"></b></span><span>Steering<b id="lap-replay-steer"></b></span><span>Surface<b id="lap-replay-surface"></b></span><span>ERS charge<b id="lap-replay-ers"></b></span>
    </div>
    <footer><p id="lap-replay-source"></p></footer>
  </div>`;
document.body.appendChild(dialog);
const el = id => dialog.querySelector('#lap-replay-' + id);
let data = null, track = null, bounds = null, time = 0, playing = false, frame = 0, last = 0, request = 0, returnFocus = null;
let mapView = null;
const clock = seconds => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;
const color = p => p.offTrack ? '#ff6c86' : p.flags & 2 ? '#ffb454' : p.flags & 1 ? '#6ee7a0' : '#88b9ff';

function size(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawLine(ctx, transform, width) {
  const samples = data.unpacked.samples;
  ctx.save(); ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 1; i < samples.length; i++) {
    const a = transform(samples[i - 1]), b = transform(samples[i]);
    ctx.strokeStyle = color(samples[i - 1]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function render() {
  if (!data || !dialog.open || !track) return;
  const pose = sampleLap(data.unpacked.samples, time);
  const camera = size(el('camera'));
  window.KartBlitzReplayScene.draw(camera.ctx, track, pose, camera.w, camera.h, (ctx, view) => {
    if (el('line').checked) drawLine(ctx, p => ({ x: p.x - view.x + camera.w / 2, y: p.y - view.y + camera.h / 2 }), 3);
  });
  const map = size(el('map'));
  const scale = Math.min(map.w / bounds.width, map.h / bounds.height);
  const transform = p => ({ x: (p.x - bounds.x) * scale + map.w / 2, y: (p.y - bounds.y) * scale + map.h / 2 });
  mapView = { ...bounds, scale, w: map.w, h: map.h };
  map.ctx.lineCap = 'round'; map.ctx.lineJoin = 'round';
  map.ctx.beginPath();
  track.spline.forEach((p, i) => { const q = transform(p); i ? map.ctx.lineTo(q.x, q.y) : map.ctx.moveTo(q.x, q.y); });
  map.ctx.closePath(); map.ctx.strokeStyle = '#514b62'; map.ctx.lineWidth = Math.max(3, track.trackWidth * scale); map.ctx.stroke();
  if (el('line').checked) drawLine(map.ctx, transform, 2.5);
  const marker = transform(pose);
  map.ctx.fillStyle = '#fff'; map.ctx.beginPath(); map.ctx.arc(marker.x, marker.y, 5, 0, Math.PI * 2); map.ctx.fill();
  map.ctx.strokeStyle = '#191625'; map.ctx.lineWidth = 2; map.ctx.stroke();
  el('seek').value = String(time);
  el('seek').setAttribute('aria-valuetext', `${clock(time)} of ${clock(data.bestLap)}`);
  el('time').textContent = `${clock(time)} / ${clock(data.bestLap)}`;
  el('progress').textContent = `${Math.round(time / data.bestLap * 100)}% of lap time`;
  el('speed').textContent = `${Math.round(pose.speed * .8)} KM/H`;
  el('pedals').textContent = pose.flags & 2 ? (pose.flags & 1 ? 'THROTTLE + BRAKE' : 'BRAKE') : pose.flags & 1 ? 'THROTTLE' : 'COAST';
  el('steer').textContent = (pose.flags & 4) && !(pose.flags & 8) ? 'LEFT' : (pose.flags & 8) && !(pose.flags & 4) ? 'RIGHT' : 'STRAIGHT';
  el('surface').textContent = pose.offTrack ? 'OFF TRACK' : 'ON TRACK';
  el('ers').textContent = `${Math.round(pose.ersCharge * 100)}%`;
  el('play').textContent = playing ? 'PAUSE' : 'PLAY';
}

function tick(now) {
  frame = 0;
  if (!playing || !dialog.open || !data) return;
  time += Math.max(0, (now - last) / 1000) * Number(el('rate').value);
  last = now;
  if (time >= data.bestLap) {
    if (el('loop').checked) time %= data.bestLap;
    else { time = data.bestLap; playing = false; }
  }
  render();
  if (playing) frame = requestAnimationFrame(tick);
}

function pause() { playing = false; cancelAnimationFrame(frame); frame = 0; render(); }
function seek(t) { pause(); time = Math.max(0, Math.min(data?.bestLap || 0, Number(t) || 0)); render(); }
function toggle() {
  if (!data) return;
  if (playing) return pause();
  if (time >= data.bestLap) time = 0;
  playing = true; last = performance.now(); render(); frame = requestAnimationFrame(tick);
}

async function open(runId) {
  pause(); data = null; track = null; mapView = null;
  const token = ++request;
  if (!dialog.open) { returnFocus = document.activeElement; dialog.showModal(); }
  el('title').textContent = 'Loading lap…'; el('detail').textContent = '';
  el('content').hidden = true; el('status').textContent = 'Loading the verified lap recording…';
  el('close').focus();
  try {
    const result = await window.fetchLeaderboardGhost(runId, true);
    if (token !== request || !dialog.open) return;
    display(result);
  } catch (error) {
    if (token !== request || !dialog.open) return;
    data = null; track = null;
    el('title').textContent = 'Replay unavailable';
    el('status').textContent = String(error.message || 'Could not load this replay. Please try again.').replace(/_/g, ' ');
  }
}

function display(result) {
    const samples = result.unpacked.samples;
    // Old truncated recordings cannot honestly play the missing part of a lap.
    if (samples[0].t > .15 || samples.at(-1).t < result.bestLap - .15) throw new Error('This older recording is incomplete. A newly recorded best lap is needed.');
    track = window.KartBlitzReplayScene.getTrack(result.trackId, result.ghost.trackSnapshot);
    if (!track) throw new Error('The track for this recording is unavailable.');
    data = result; bounds = replayBounds(track, samples); time = 0;
    el('title').textContent = `${result.username} · ${clock(result.bestLap)}`;
    const archive = !!result.source;
    el('detail').textContent = archive
      ? `${track.name} · ${result.mode} · ${result.lapKind} · ${result.source === 'server-online' ? 'recorded by game server' : 'player recording (not server-verified)'}`
      : `${track.name} · leaderboard position ${result.rank} · server-verified Time Trial`;
    el('race').hidden = archive;
    el('seek').max = String(result.bestLap);
    const record = result.ghost.recording;
    el('source').textContent = archive
      ? `Archived lap · actual recorded poses, analogue control events, state checkpoints and traffic. Playback reproduces the captured path; it does not rerun current physics. Speed uses the game’s KM/H scale.`
      : `Server-reconstructed lap · timestamped positions and digital controls (nominal ${Number(result.ghost.sampleRateHz) || 15} Hz). ${record ? `Verified ${record.physicsHz} Hz input stream and recorded track layout included in download.` : 'Legacy recording: full input stream and archived track layout unavailable.'} Speed uses the game’s KM/H scale.`;
    el('status').textContent = ''; el('content').hidden = false;
    render();
}

function openFile() {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
  input.addEventListener('change', async () => {
    const file = input.files[0]; if (!file) return;
    pause(); ++request;
    if (!dialog.open) { returnFocus = document.activeElement; dialog.showModal(); }
    el('content').hidden = true; el('status').textContent = 'Opening archived lap…'; el('close').focus();
    const token = request;
    try {
      if (file.size > 4_000_000) throw new Error('Recording exceeds the supported file size');
      const payload = JSON.parse(await file.text());
      if (token !== request || !dialog.open) return;
      const unpacked = window.KartBlitzGhost.unpackLeaderboardGhost(payload.ghost);
      if (payload.format !== 'kartblitz-lap-replay-v1' || !unpacked || Number(payload.trackId) !== unpacked.trackId) throw new Error('Invalid lap recording');
      display({ ...payload, source: payload.source || 'imported-recording', bestLap: unpacked.lapTime, unpacked });
    } catch (error) {
      if (token !== request || !dialog.open) return;
      data = null; el('title').textContent = 'Replay unavailable'; el('status').textContent = error.message;
    }
  });
  input.click();
}

function cleanup() {
  ++request; playing = false; cancelAnimationFrame(frame); frame = 0;
  data = null; track = null; mapView = null;
  window.KartBlitzReplayScene?.clear();
  if (returnFocus?.isConnected) returnFocus.focus();
}
function close() { if (dialog.open) dialog.close(); }
dialog.addEventListener('close', cleanup);
// Keep menu shortcuts and driving controls out of the modal, including Escape.
dialog.addEventListener('keydown', event => event.stopPropagation());
dialog.addEventListener('keyup', event => event.stopPropagation());
dialog.addEventListener('cancel', () => { playing = false; cancelAnimationFrame(frame); });
el('close').addEventListener('click', close);
el('play').addEventListener('click', toggle);
el('restart').addEventListener('click', () => seek(0));
el('back').addEventListener('click', () => seek(time - 1));
el('forward').addEventListener('click', () => seek(time + 1));
el('seek').addEventListener('input', event => seek(event.target.value));
el('line').addEventListener('change', render);
el('map').addEventListener('click', event => {
  if (!data || !mapView) return;
  const rect = el('map').getBoundingClientRect();
  seek(nearestLapTime(data.unpacked.samples, (event.clientX - rect.left - mapView.w / 2) / mapView.scale + mapView.x,
    (event.clientY - rect.top - mapView.h / 2) / mapView.scale + mapView.y));
});
el('map').addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(time + (event.key === 'ArrowRight' ? 1 : -1)); }
});
el('download').addEventListener('click', () => {
  if (!data) return;
  const { unpacked, ...payload } = data;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'kartblitz-lap-replay-v1', ...payload })], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `kartblitz-track-${data.trackId}-${data.runId}.replay.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
el('race').addEventListener('click', () => { if (data) { const id = data.runId; close(); window.raceLeaderboardGhost(id); } });
window.addEventListener('resize', render);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.KartBlitzLapReplay = { open, openFile, close, isOpen: () => dialog.open };
