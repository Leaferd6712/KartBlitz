
// kart blitz - main racing engine

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const MENU_PAGE_BG = '#7b6fca';
const RACE_VIEW_MAX_EDGE = 1920;
let W = 1280, H = 720;
let _raceFillBg = null;
canvas.width = W; canvas.height = H;

function applyPageBackground() {
  const color = (canvas.style.display === 'block' && _raceFillBg) ? _raceFillBg : MENU_PAGE_BG;
  document.documentElement.style.background = color;
  document.body.style.background = color;
}

function resizeCanvas() {
  const vw = Math.max(2, window.innerWidth || 2);
  const vh = Math.max(2, window.innerHeight || 2);
  let nextW = vw;
  let nextH = vh;
  const longEdge = Math.max(nextW, nextH);
  if(longEdge > RACE_VIEW_MAX_EDGE) {
    const s = RACE_VIEW_MAX_EDGE / longEdge;
    nextW = Math.max(2, Math.round(nextW * s));
    nextH = Math.max(2, Math.round(nextH * s));
  }
  W = nextW;
  H = nextH;
  if(canvas.width !== W) canvas.width = W;
  if(canvas.height !== H) canvas.height = H;
  canvas.style.width = vw + 'px';
  canvas.style.height = vh + 'px';
  // Countdown overlay spans the full viewport; .cd-num self-centers with left/top 50%.
  // Avoid sizing+transform on the overlay — that shifted all countdown text left.
  const overlay = document.getElementById('countdownOverlay');
  if(overlay) {
    overlay.style.width = '';
    overlay.style.height = '';
    overlay.style.left = '';
    overlay.style.top = '';
    overlay.style.right = '';
    overlay.style.bottom = '';
    overlay.style.transform = 'none';
  }
  applyPageBackground();
}
window.addEventListener('resize', resizeCanvas); resizeCanvas();

// ── CRAZYGAMES SDK WRAPPER ──────────────────────────────
const CG = (() => {
  let _sdk = null;
  let _adPlaying = false;
  let _systemInfo = null;

  function _showAdBlocker() {
    const el = document.getElementById('ad-block-overlay');
    if (el) el.style.display = 'flex';
  }
  function _hideAdBlocker() {
    const el = document.getElementById('ad-block-overlay');
    if (el) el.style.display = 'none';
  }

  function _applyPlatformMute(flag) {
    if (typeof setPlatformMuted === 'function') setPlatformMuted(!!flag);
    else window._pendingPlatformMute = !!flag;
  }

  function _syncMuteFromSettings(settings) {
    const muted = !!(settings && settings.muteAudio);
    _applyPlatformMute(muted);
  }

  function _readInitialMute() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('muteAudio') === 'true') {
        _applyPlatformMute(true);
        return;
      }
    } catch(e) {}
    try {
      if (_sdk && _sdk.game && _sdk.game.settings) {
        _syncMuteFromSettings(_sdk.game.settings);
      }
    } catch(e) {}
  }

  function _applySystemDefaults() {
    try {
      const info = (_sdk && _sdk.user && _sdk.user.systemInfo) || null;
      _systemInfo = info;
      if (typeof applyDeviceQualityDefaults === 'function') {
        applyDeviceQualityDefaults(info);
      }
    } catch(e) {
      if (typeof applyDeviceQualityDefaults === 'function') applyDeviceQualityDefaults(null);
    }
  }

  async function init() {
    try {
      if (window.CrazyGames && window.CrazyGames.SDK) {
        await window.CrazyGames.SDK.init();
        _sdk = window.CrazyGames.SDK;
        try { _sdk.game.loadingStart(); } catch(e){}
        _readInitialMute();
        try {
          if (_sdk.game && typeof _sdk.game.addSettingsChangeListener === 'function') {
            _sdk.game.addSettingsChangeListener((settings) => _syncMuteFromSettings(settings));
          }
        } catch(e) {}
        _applySystemDefaults();
      } else {
        _readInitialMute();
        _applySystemDefaults();
      }
    } catch(e) {
      _readInitialMute();
      _applySystemDefaults();
    }
  }

  function _muteAudioForAd() {
    if (typeof setAdMuted === 'function') setAdMuted(true);
  }
  function _unmuteAudioForAd() {
    if (typeof setAdMuted === 'function') setAdMuted(false);
  }
  function _pauseLoop() {
    if (animId) { cancelAnimationFrame(animId); animId = null; }
  }
  function _resumeLoop() {
    if (race && (race.phase === 'racing' || race.phase === 'countdown')) {
      lastTime = null;
      animId = requestAnimationFrame(gameLoop);
    }
  }

  function _onAdStart() {
    _adPlaying = true;
    _pauseLoop();
    _muteAudioForAd();
  }
  function _onAdEnd() {
    _adPlaying = false;
    _unmuteAudioForAd();
    _resumeLoop();
  }

  function requestMidroll(callback) {
    if (!_sdk) { if (callback) callback(); return; }
    // CrazyGames enforces midroll frequency server-side; request at every natural break.
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(failsafe);
      _hideAdBlocker();
      try { _onAdEnd(); } catch(e){}
      if (callback) callback();
    };
    _showAdBlocker();
    // Never soft-lock results if the ad SDK stalls after adStarted.
    const failsafe = setTimeout(finish, 12000);
    try {
      _sdk.ad.requestAd('midgame', {
        adStarted:  () => _onAdStart(),
        adFinished: () => finish(),
        adError:    () => finish()
      });
    } catch(e) { finish(); }
  }

  function requestRewarded(callback) {
    if (!_sdk) { if (callback) callback(false); return; }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(failsafe);
      _hideAdBlocker();
      try { _onAdEnd(); } catch(e){}
      if (callback) callback(!!ok);
    };
    _showAdBlocker();
    const failsafe = setTimeout(() => finish(false), 12000);
    try {
      _sdk.ad.requestAd('rewarded', {
        adStarted:  () => _onAdStart(),
        adFinished: () => finish(true),
        adError:    () => finish(false)
      });
    } catch(e) { finish(false); }
  }

  function gameplayStart() {
    if (!_sdk) return;
    try { _sdk.game.gameplayStart(); } catch(e){}
  }
  function gameplayStop() {
    if (!_sdk) return;
    try { _sdk.game.gameplayStop(); } catch(e){}
  }

  function happytime() {
    if (!_sdk) return;
    try { _sdk.game.happytime(); } catch(e){}
  }

  // Save a score to a named CrazyGames leaderboard.
  // value should be a positive integer (e.g. lap time in ms — lower is better).
  function saveScore(boardName, value) {
    if (!_sdk) return;
    try { _sdk.leaderboard.save({ name: boardName, value }); } catch(e){}
  }
  function showBoard(boardName) {
    if (!_sdk) return;
    try { _sdk.leaderboard.show(boardName); } catch(e){}
  }

  // Stop the loading screen — call once the first menu is fully interactive
  function loadingStop() {
    if (!_sdk) return;
    try { _sdk.game.loadingStop(); } catch(e){}
  }

  // Cloud save/load via CrazyGames User Data API (syncs progress to player account)
  async function saveUserData(key, value) {
    if (!_sdk) return;
    try { await _sdk.data.set({ [key]: value }); } catch(e){}
  }
  async function loadUserData(keys, callback) {
    if (!_sdk) { if (callback) callback(null); return; }
    try {
      const data = await _sdk.data.get(keys);
      if (callback) callback(data);
    } catch(e) { if (callback) callback(null); }
  }

  function getSystemInfo() { return _systemInfo; }

  // Kick off async init immediately
  init();

  return {
    requestMidroll, requestRewarded, gameplayStart, gameplayStop, happytime,
    saveScore, showBoard, loadingStop, saveUserData, loadUserData,
    isAdPlaying: () => _adPlaying, getSystemInfo
  };
})();

// ── SCREEN ──────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  canvas.style.display = 'none';
  applyPageBackground();
  document.getElementById('countdownOverlay').style.display = 'none';
  const po = document.getElementById('pause-overlay');
  if(po) po.style.display = 'none';
  const pitUi = document.getElementById('pit-ui-overlay');
  if(pitUi) { pitUi.style.display = 'none'; pitUi.dataset.signature = ''; clearPitUiLayoutClasses(pitUi); }
  showTouchOverlay(false);
  updateLandscapeHint(false);
  const _adEl = document.getElementById('ai-difficulty'); if(_adEl) _adEl.style.display='none';
  const _soEl = document.getElementById('shootout-difficulty'); if(_soEl) _soEl.style.display='none';
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.remove('hidden');
  if (id === 'leaderboard') buildLeaderboardScreen();
  if (id === 'menu') {
    CG.gameplayStop(); // signal CrazyGames: player left gameplay
    // Signal loading complete the very first time the menu appears
    if (!window._menuShownOnce) { window._menuShownOnce = true; CG.loadingStop(); }
    const pd = getPlayerData();
    updateCurrencyDisplays(pd);
    if(typeof window.mountMenuCarStage === 'function') window.mountMenuCarStage();
    if(typeof window.buildMenuPaintStrip === 'function') window.buildMenuPaintStrip();
  } else if(typeof window.pauseMenuCarStage === 'function') {
    window.pauseMenuCarStage();
  }
  if(id !== 'garage' && typeof window.disposeGarageCarStage === 'function') {
    window.disposeGarageCarStage();
  }
  // Hide FTUE hint whenever navigating away from the canvas
  const _ftueEl = document.getElementById('ftue-hint');
  if (_ftueEl && canvas.style.display !== 'block') _ftueEl.style.display = 'none';
}
window.addEventListener('load', () => {
  showScreen('menu');
  showPatchNotesOnce();
});

let _patchNotesDismissed = false;
function showPatchNotesOnce() {
  if(_patchNotesDismissed) return;
  const el = document.getElementById('patch-notes-overlay');
  if(el) el.classList.add('open');
}
function dismissPatchNotes() {
  _patchNotesDismissed = true;
  const el = document.getElementById('patch-notes-overlay');
  if(el) el.classList.remove('open');
  try { initAudio(); playUIClick(); } catch(e) {}
}

// Show device/input selection prompt only once — persist choice in localStorage
(function(){
  const saved = localStorage.getItem('kartblitz_devicemode');
  if(saved !== null) {
    setDeviceMode(saved === 'touch');
  } else {
    const preferTouch = (navigator.maxTouchPoints > 0) ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const title = document.querySelector('#device-prompt h2');
    const body = document.querySelector('#device-prompt p');
    if(title) title.textContent = preferTouch ? 'TOUCH CONTROLS AVAILABLE' : 'CHOOSE YOUR CONTROLS';
    if(body) body.textContent = preferTouch
      ? 'Enable on-screen joysticks? You can switch anytime in Settings.'
      : 'Use keyboard, or enable on-screen joysticks? You can switch anytime in Settings.';
    document.getElementById('device-prompt').classList.add('open');
  }
})();
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('screen-menu') && !document.getElementById('screen-menu').classList.contains('hidden')) {
    const patch = document.getElementById('patch-notes-overlay');
    if(patch && patch.classList.contains('open')) {
      dismissPatchNotes();
      return;
    }
    startTimeTrial();
  }
});

// ── AUDIO ───────────────────────────────────────────────
let AC;
let masterGain = null;
let _userMuted = false;
let _platformMuted = false;
let _adMuted = false;

try { _userMuted = localStorage.getItem('kartblitz_mute') === '1'; } catch(e) {}

function isEffectivelyMuted() {
  return _platformMuted || _userMuted || _adMuted;
}
function applyMasterMute() {
  if (masterGain) {
    const g = masterGain.gain;
    const target = isEffectivelyMuted() ? 0 : 1;
    try { g.setTargetAtTime(target, AC.currentTime, 0.02); }
    catch(e) { g.value = target; }
  }
}
function setPlatformMuted(flag) {
  _platformMuted = !!flag;
  applyMasterMute();
  if (typeof refreshSettingsPane === 'function') refreshSettingsPane();
}
if (typeof window._pendingPlatformMute === 'boolean') {
  setPlatformMuted(window._pendingPlatformMute);
  delete window._pendingPlatformMute;
}
function setAdMuted(flag) {
  _adMuted = !!flag;
  applyMasterMute();
}
function setUserMuted(flag) {
  // Platform mute always wins — never unmute while CrazyGames muteAudio is true
  if (_platformMuted && !flag) return false;
  _userMuted = !!flag;
  try { localStorage.setItem('kartblitz_mute', _userMuted ? '1' : '0'); } catch(e) {}
  applyMasterMute();
  return true;
}
function toggleUserMute() {
  if (_platformMuted) return false;
  return setUserMuted(!_userMuted);
}
function isUserMuted() { return _userMuted; }
function isPlatformMuted() { return _platformMuted; }

function getAudioOut() {
  if (!AC) return null;
  if (!masterGain) {
    masterGain = AC.createGain();
    masterGain.gain.value = isEffectivelyMuted() ? 0 : 1;
    masterGain.connect(AC.destination);
  }
  return masterGain;
}

function resumeAudioContextIfNeeded() {
  if (!AC) return;
  if (AC.state === 'suspended' && !isEffectivelyMuted()) {
    try { AC.resume(); } catch(e) {}
  }
}

function initAudio() {
  if (!AC) {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    getAudioOut();
  }
  resumeAudioContextIfNeeded();
}

// iOS / portal: revive AudioContext after interrupt on next user gesture
['touchend', 'click', 'keydown'].forEach(evt => {
  document.addEventListener(evt, () => resumeAudioContextIfNeeded(), { passive: true });
});

function beep(freq, dur, vol=0.5, type='sine', when=0) {
  if (!AC) return;
  const out = getAudioOut(); if (!out) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.connect(g); g.connect(out);
  o.type = type; o.frequency.value = freq;
  const t = AC.currentTime + when;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.start(t); o.stop(t + dur + 0.01);
}
function playGo() {
  beep(880,0.15,0.6,'square'); beep(1100,0.25,0.5,'square',0.1);
  beep(1320,0.4,0.7,'sine',0.15);
}
function playLap() {
  beep(660,0.12,0.5,'square'); beep(880,0.2,0.5,'square',0.1); beep(1100,0.3,0.6,'sine',0.2);
}
function playFinish() {
  [0,0.1,0.2,0.35,0.5,0.65].forEach((t,i)=>{
    beep([880,1100,1320,1540,1760,2200][i],0.18,0.45,'square',t);
  });
}

const engines = {};
function startEngine(id) {
  if (!AC || engines[id]) return;
  const out = getAudioOut(); if (!out) return;
  const osc = AC.createOscillator();
  const gain = AC.createGain();
  const filt = AC.createBiquadFilter();
  osc.type = 'sawtooth'; osc.frequency.value = 55;
  filt.type = 'lowpass'; filt.frequency.value = 350;
  gain.gain.value = 0.006;
  osc.connect(filt); filt.connect(gain); gain.connect(out);
  osc.start();
  engines[id] = {osc, gain, filt};
}
function updateEngine(id, speed, maxSpeed, isThrottle=false, isBraking=false) {
  if (!AC || !engines[id]) return;

  const eng = engines[id];
  const speedRatio = Math.max(0, Math.min(1, Math.abs(speed) / Math.max(1, maxSpeed || 1)));
  const throttleBoost = isThrottle ? 0.22 : 0;
  const brakeDrag = isBraking ? 0.08 : 0;
  const rpm = Math.max(0, Math.min(1, 0.18 + speedRatio * 0.72 + throttleBoost - brakeDrag));

  const targetFreq = 55 + rpm * 190;
  const targetFilter = 300 + rpm * 1400;
  let targetGain = 0.004 + rpm * 0.012;
  if (isThrottle) targetGain += 0.014;
  if (!isThrottle && Math.abs(speed) < 4) targetGain = 0.003;

  eng.osc.frequency.setTargetAtTime(targetFreq, AC.currentTime, 0.05);
  eng.filt.frequency.setTargetAtTime(targetFilter, AC.currentTime, 0.06);
  eng.gain.gain.setTargetAtTime(targetGain, AC.currentTime, 0.07);
}
function stopEngine(id) {
  if(engines[id] == null) return;
  try { engines[id].osc.stop(); } catch(e){}
  delete engines[id];
}
function stopAllEngines() {
  Object.keys(engines).forEach(id => stopEngine(id));
}

// ── DRIFT SOUND (tire screech oscillator) ────────────────
const driftNodes = {};
function startDriftSnd(id) {
  if (!AC || driftNodes[id]) return;
  const out = getAudioOut(); if (!out) return;
  const osc = AC.createOscillator();
  const filt = AC.createBiquadFilter();
  const gain = AC.createGain();
  osc.type = 'sawtooth'; osc.frequency.value = 780;
  filt.type = 'bandpass'; filt.frequency.value = 1200; filt.Q.value = 0.55;
  gain.gain.value = 0;
  osc.connect(filt); filt.connect(gain); gain.connect(out);
  osc.start();
  driftNodes[id] = { osc, gain };
}
function updateDriftSnd(id, intensity) {
  if (!AC || !driftNodes[id]) return;
  const target = Math.min(0.065, intensity * 0.065);
  driftNodes[id].gain.gain.setTargetAtTime(target, AC.currentTime, 0.06);
}
function stopAllDriftSnds() {
  Object.keys(driftNodes).forEach(id => {
    try { driftNodes[id].osc.stop(); } catch(e){}
    delete driftNodes[id];
  });
}

// ── COLLISION SOUND (metallic noise burst) ───────────────
function playCollision(vol) {
  if (!AC) return;
  const out = getAudioOut(); if (!out) return;
  vol = (vol !== undefined) ? vol : 0.45;
  const sr = AC.sampleRate;
  const bufSz = Math.floor(sr * 0.28);
  const buf = AC.createBuffer(1, bufSz, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < bufSz; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.035));
  }
  const src = AC.createBufferSource();
  const flt = AC.createBiquadFilter();
  const gn  = AC.createGain();
  flt.type = 'bandpass'; flt.frequency.value = 290; flt.Q.value = 1.3;
  gn.gain.value = vol;
  src.buffer = buf;
  src.connect(flt); flt.connect(gn); gn.connect(out);
  src.start();
}

// ── UI CLICK SOUND ───────────────────────────────────────
function playUIClick() {
  if (!AC) return;
  const out = getAudioOut(); if (!out) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.connect(g); g.connect(out);
  o.type = 'sine';
  o.frequency.setValueAtTime(700, AC.currentTime);
  o.frequency.exponentialRampToValueAtTime(200, AC.currentTime + 0.065);
  g.gain.setValueAtTime(0.15, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + 0.08);
  o.start(AC.currentTime); o.stop(AC.currentTime + 0.09);
}

// ── PARTICLE SYSTEM (pooled — 100 slots, zero GC churn) ──
const POOL_SIZE = 100;
const _pPool = [];
for (let _pi = 0; _pi < POOL_SIZE; _pi++) {
  _pPool.push({ active:false, x:0, y:0, vx:0, vy:0, color:'#fff', life:0, maxLife:1, size:1 });
}
// `particles` is an alias kept so existing length-checks still read the array
const particles = _pPool;

function getQualityPreset() {
  return QUALITY_PRESETS[_qualityLevel] || QUALITY_PRESETS.high;
}

function _emit(x,y,vx,vy,color,life,size) {
  // Prefer an inactive slot; on overflow steal the nearly-dead one
  let slot = null;
  let minLife = Infinity;
  for (let i = 0; i < POOL_SIZE; i++) {
    if (!_pPool[i].active) { slot = _pPool[i]; break; }
    if (_pPool[i].life < minLife) { minLife = _pPool[i].life; slot = _pPool[i]; }
  }
  slot.active = true;
  slot.x=x; slot.y=y; slot.vx=vx; slot.vy=vy;
  slot.color=color; slot.life=life; slot.maxLife=life; slot.size=size;
}

function spawnSmoke(x,y,a) {
  const count = Math.max(1, Math.round(3 * getQualityPreset().particleSpawnMul));
  for(let i=0;i<count;i++){
    const ang = a + (Math.random()-0.5)*1.5;
    _emit(
      x+(Math.random()-0.5)*8, y+(Math.random()-0.5)*8,
      Math.cos(ang)*30*(0.5+Math.random()), Math.sin(ang)*30*(0.5+Math.random()),
      `hsl(${200+Math.random()*60},20%,70%)`, 0.6+Math.random()*0.4, 4+Math.random()*4
    );
  }
}
function spawnSpark(x,y) {
  const count = Math.max(2, Math.round(5 * getQualityPreset().particleSpawnMul));
  for(let i=0;i<count;i++){
    const ang = Math.random()*Math.PI*2;
    _emit(x,y, Math.cos(ang)*80*Math.random(), Math.sin(ang)*80*Math.random(), '#ffd700', 0.4, 2);
  }
}
function spawnDust(x,y,a) {
  const count = Math.max(1, Math.round(2 * getQualityPreset().particleSpawnMul));
  for(let i=0;i<count;i++){
    const ang = a + (Math.random()-0.5)*1.2;
    _emit(
      x+(Math.random()-0.5)*12, y+(Math.random()-0.5)*12,
      Math.cos(ang)*22*(0.4+Math.random()), Math.sin(ang)*22*(0.4+Math.random()),
      `hsl(${30+Math.random()*22},55%,52%)`, 0.5+Math.random()*0.35, 3+Math.random()*3
    );
  }
}

// ── KART CLASS ──────────────────────────────────────────
const GAME_SPEED_MULT = 0.75; // global multiplier to reduce top speeds by 25%
const GLOBAL_ACCEL_MULT = 0.45;
const COAST_DECEL_PER_SEC = 25; // 10 km/h every 500 ms (HUD uses speed * 0.8)
class Kart {
  constructor(id, spawnX, spawnY, angle, color, shadowColor, getInput) {
    this.id = id;
    this.x = spawnX; this.y = spawnY;
    this.angle = angle;
    this.speed = 0;
    this.color = color;
    this.shadowColor = shadowColor;
    this.getInput = getInput;
    // physics - roughly 350 km/h top speed (scaled by GAME_SPEED_MULT)
    this.maxSpeed = 469 * GAME_SPEED_MULT;
    this.accel = 296 * GLOBAL_ACCEL_MULT;
    this.brakeForce = 700;
    this.friction = 0.9915;
    this.turnRate = 2.88;
    this.grip = 1.0; // 1 = full mechanical grip; lower = more understeer at speed
    this.offTrackMaxSpd = 255 * GAME_SPEED_MULT;
    this.offTrackAccel = 165 * GLOBAL_ACCEL_MULT;
    this.slipstreamBoost = false;
    this.slipstreamStrength = 0;
    this._throttleAssist = 0;
    this._brakeAssist = 0;
    // state
    this.isOffTrack = false;
    this.slideParticleTimer = 0;
    // lap tracking
    this.lap = 0;
    this.checkpointsBit = 0; // bitmask of CPs hit this lap (kept for HUD rendering)
    this.nextCp = 1;          // next checkpoint index expected in order (0 = S/F)
    this.lapTimes = [];
    this.lapStart = null;
    this.bestLap = Infinity;
    this.splitTimes = [];
    this.finished = false;
    this.finishTime = null;
    this.finishOrder = null;
    this.totalLaps = 3;
    // prev pos for crossing check
    this.prevX = spawnX; this.prevY = spawnY;
    // display
    this.flashTimer = 0;
    this.rankFlash = '';
    this.lastCheckpointTime = null;
    // Tyre wear, temperature & pit stop
    this.tyreId       = 'med';
    this.tyreWear     = 0;      // 0.0=fresh → 1.0=dead
    this.tyreTemp     = 55;     // °C — starts cool; warms with driving
    this.tyreTempState = 'cold';
    this.tyreGripPct  = 1.0;    // 0–1 effective grip from temp + wear
    this.baseMaxSpeed = 352 * GAME_SPEED_MULT;   
    this.baseTurnRate = 2.88;
    this.tyreWrongWeather = false;
    this.inPit        = false;
    this._onPitLane   = false;  // true while driving through pit lane (limiter active)
    this.pitTimer     = 0;
    this.pitPhase     = null;   // null | 'selecting' | 'stopping' | 'changing'
    this.pitTyreChoice= null;
    this.pitNavIdx    = 0;      // index into TYRE_DEFS for UI navigation
    this.pitNavCooldown = 0;   // debounce for pit tyre navigation
    this._aiPitTimer  = 0;     // timer for AI auto-tyre selection in pit
    this._pitTooFarTimer = 0;   // flash timer when pressing pit key outside zone
    this._pitIntentActive = false; // true when driver has committed to pit entry
    this._pitEntryConfirmed = false; // true once kart has physically touched pit entry trigger
    this._pitExitPos = null;
    this._pitExitAngle = null;
    this._pitExiting = false; // true while leaving the box and driving to pit exit
    this._hasPitted = false;  // legacy flag — multi-stop allowed; kept for save/AI compat
    this._pitCooldown = 0;
    this._baseAccel = this.accel;
    // ERS (Energy Recovery System): X for P1, . for P2
    this.ersCharge = 1.0;       // 0.0 – 1.0 (full to empty)
    this.ersActive = false;
    this._ersPrevKey = false;   // for toggle edge detection
    this._ersToggled = false;   // toggle-mode state
    this._ersPower = 0;         // 0–1 blended deploy strength (smooth fade in/out)
    this._ersStraightTimer = 0; // seconds flat-out on a straight (passive regen)
    // DRS (Drag Reduction System): C for P1, , for P2
    this.drsAvailable = false;  // set by Race based on mode/gap
    this.drsActive = false;
    this.drsInZone = false;
    this._drsPrevKey = false;   // for toggle edge detection
    this._drsToggled = false;   // toggle-mode state
    this._nearestSplineIdx = 0; // cached nearest spline point index
    this.isAI = false;
    // Off-track reset timer (human drivers only)
    this._offTrackTimer       = 0;   // seconds spent continuously off-track
    this._offTrackEntrySpeed  = 0;   // speed at the moment they left the track
    this._isCompletelyOff     = false; // strict boundary flag (player only)
    this._penaltyTimer        = 0;   // countdown seconds before reset (player only)
    // Ghost recording (Time Trial)
    this._ghostRecord = null;   // current lap recording [{t,x,y,a},...]
    this._bestGhost   = null;   // saved recording of best lap
    this._ghostSampleTimer = 0; // decimate ghost samples to reduce GC pressure
    this._contactJamTimer = 0;
    this._contactLineTimer = 0;
    this._contactLineSign = 0;
    // ML demo recording (Time Trial export)
    this._mlDemoFrames = null;
  }

  update(dt, trackData, otherKarts) {
    if(this.finished) return;
    if(this._pitTooFarTimer > 0) this._pitTooFarTimer -= dt;

    // ── PIT STOP HANDLING ──────────────────────────────
    if(this.pitPhase === 'selecting') {
      // Gently brake to a stop while the driver selects a tyre
      this.speed *= Math.pow(0.78, dt * 60);
      if(Math.abs(this.speed) < 1) this.speed = 0;
      this.prevX = this.x; this.prevY = this.y;
      this.x += Math.cos(this.angle) * this.speed * dt;
      this.y += Math.sin(this.angle) * this.speed * dt;
      if(this.pitNavCooldown > 0) this.pitNavCooldown -= dt;
      updateEngine(this.id, this.speed, this.maxSpeed, false, false);
      return;
    }
    if(this.pitPhase === 'stopping') {
      // Kart is already at garage (speed=0) — skip deceleration and start tyre change immediately
      this.speed = 0;
      this.pitPhase = 'changing';
      this.pitTimer = 0;
      return;
    }
    if(this.pitPhase === 'changing') {
      this.pitTimer += dt;
      this.speed = 0;
      updateEngine(this.id, 0, this.maxSpeed, false, false);
      if(this.pitTimer >= 3.0) {
        // Apply chosen tyre, then drive the pit lane out — never teleport.
        this._applyNewTyre(this.pitTyreChoice || this.tyreId);
        this.pitPhase = null;
        this.inPit = false;
        // Allow multiple stops in race and qualifying.
        this._hasPitted = false;
        this._pitIntentActive = false;
        this._pitEntryConfirmed = false;
        this._pitExiting = true;
        this._pitCooldown = 2.8; // avoid instantly re-opening the box on the way out
        if(trackData && trackData.pitLane && trackData.pitLane.exitPos) {
          this._pitExitPos = trackData.pitLane.exitPos;
          this._pitExitAngle = trackData.pitLane.exitAngle !== undefined
            ? trackData.pitLane.exitAngle : this.angle;
        }
      }
      return;
    }

    // Pit intent becomes active only after the kart physically reaches the pit-entry trigger.
    if(this._pitIntentActive && !this.inPit && this.pitPhase === null && trackData && trackData.pitLane && trackData.pitLane.entryPt) {
      const entryPt = trackData.pitLane.entryPt;
      const entryTouchRadius = Math.max(150, ((trackData.pitLane.width || 60) * 1.4));
      if(Math.hypot(this.x - entryPt.x, this.y - entryPt.y) <= entryTouchRadius || this._onPitLane) {
        this._pitEntryConfirmed = true;
      }
    }

    let inp = this.getInput();
    // Pit routing overrides normal AI/player racing input so they stay on the pit path.
    // Exit steering only while actually exiting — _pitExitPos is also pre-armed on entry.
    if(!this.inPit && this.pitPhase === null && this._pitExiting && this._pitExitPos) {
      const pitExitInput = this._getPitExitInput(trackData);
      if(pitExitInput) inp = pitExitInput;
    } else if(!this.inPit && this.pitPhase === null && this._pitIntentActive) {
      const pitEntryInput = this._getPitEntryInput(trackData);
      if(pitEntryInput) inp = pitEntryInput;
    }

    // Time Trial: record inputs + obs for ML demo export
    if(!this.isAI && this._mlDemoFrames && this.lapStart !== null && !this.finished &&
        typeof race !== 'undefined' && race && race.mode === 'trial' && window.KartBlitzML) {
      const _curv = race._mlCurv || (race._mlCurv = window.KartBlitzML.precomputeCurvature(trackData));
      const _obs = window.KartBlitzML.observe(this, trackData, _curv);
      this._mlDemoFrames.push({
        inputs: { up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right },
        obs: _obs,
        action: window.KartBlitzML.inputsToAction(inp),
      });
    }

    // Surface-specific off-track physics: each track has a unique offTrackMult
    const surfMult = (trackData && trackData.surface) ? trackData.surface.offTrackMult : 1.0;
    const applyOffTrackSlowdown = this.isOffTrack;
    const maxSpd = applyOffTrackSlowdown ? (this.offTrackMaxSpd * surfMult) : this.maxSpeed;
    const acc = applyOffTrackSlowdown ? (this.offTrackAccel * surfMult) : this.accel;

    // Slipstream: +10% max speed when closely behind another kart on track
    this.slipstreamBoost = false;
    this.slipstreamStrength = 0;
    let spdLimit = maxSpd;
    if(!this.isOffTrack && otherKarts) {
      let bestWake = 0;
      for(const other of otherKarts) {
        if(other === this) continue;
        if(other.finished || other._shootoutStowed) continue;
        const dx = other.x - this.x, dy = other.y - this.y;
        const dist = Math.hypot(dx, dy);
        if(dist < 600 && dist > 20) {
          const dot = Math.cos(this.angle)*dx + Math.sin(this.angle)*dy;
          if(dot > 0) {
            const lat = Math.abs(-Math.sin(this.angle) * dx + Math.cos(this.angle) * dy);
            const wakeWidth = 18 + dist * 0.22;
            if(lat < wakeWidth) {
              const wakeStrength = Math.max(0, (1 - dist / 600) * (1 - lat / wakeWidth));
              if(wakeStrength > bestWake) bestWake = wakeStrength;
            }
          }
        }
      }
      if(bestWake > 0.08) {
        this.slipstreamBoost = true;
        this.slipstreamStrength = bestWake;
        spdLimit = this.maxSpeed * (1.04 + bestWake * 0.12);
      }
    }

    const hasAnalogDrive = typeof inp.throttle === 'number' || typeof inp.brake === 'number';
    const useDigitalAssist = !this.isAI && !touchMode && !hasAnalogDrive;
    let throttleTarget = hasAnalogDrive ? Math.max(0, Math.min(1, inp.throttle || 0)) : (inp.up ? 1 : 0);
    const brakeTarget = hasAnalogDrive ? Math.max(0, Math.min(1, inp.brake || 0)) : (inp.down ? 1 : 0);
    const opposingDrive = !hasAnalogDrive && inp.up && inp.down;
    if(opposingDrive) throttleTarget = 0;
    if(useDigitalAssist) {
      this._throttleAssist += (throttleTarget - this._throttleAssist) * (inp.up && !opposingDrive ? 0.22 : 0.34);
      if(opposingDrive) this._throttleAssist *= 0.4;
      // Smooth brake in; slower ease-off so release doesn't dump all deceleration at once.
      this._brakeAssist += (brakeTarget - this._brakeAssist) * (inp.down ? 0.16 : 0.11);
    } else {
      this._throttleAssist = throttleTarget;
      this._brakeAssist = brakeTarget;
    }
    const throttleInput = Math.max(0, Math.min(1, this._throttleAssist));
    const brakeInput = Math.max(0, Math.min(1, this._brakeAssist));

    // ── KART-TO-KART CONTACT PHYSICS ───────────────────
    // Simple circle-circle push: karts have a ~18-unit radius.
    // Both karts exchange momentum and are pushed apart on overlap.
    if(otherKarts && isKartContactEnabled()) {
      const KART_R = 18;
      let contactHits = 0;
      for(const other of otherKarts) {
        if(other === this) continue;
        // Resolve each unordered pair once to avoid double impulse.
        if(this.id >= other.id) continue;
        if(other.finished || other._shootoutStowed || this._shootoutStowed) continue;
        const dx = this.x - other.x, dy = this.y - other.y;
        const dist = Math.hypot(dx, dy);
        if(dist < KART_R * 2 && dist > 0.1) {
          contactHits++;
          // Contact line rule: when cars touch, force AI cars onto opposite lane targets briefly.
          const localLat = -Math.sin(this.angle) * dx + Math.cos(this.angle) * dy;
          const sepSignThis = localLat >= 0 ? 1 : -1;
          if(this.isAI) {
            this._contactLineSign = sepSignThis;
            this._contactLineTimer = Math.max(this._contactLineTimer || 0, 0.58);
          }
          if(other.isAI) {
            other._contactLineSign = -sepSignThis;
            other._contactLineTimer = Math.max(other._contactLineTimer || 0, 0.58);
          }
          // Penetration depth
          const pen = KART_R * 2 - dist;
          const nx = dx / dist, ny = dy / dist; // normal pointing from other → this
          // Push apart equally
          const pushShare = (this.isAI || other.isAI) ? 0.58 : 0.52;
          this.x  += nx * pen * pushShare;
          this.y  += ny * pen * pushShare;
          other.x -= nx * pen * pushShare;
          other.y -= ny * pen * pushShare;
          // Relative velocity along normal
          const relVx = this.speed * Math.cos(this.angle) - other.speed * Math.cos(other.angle);
          const relVy = this.speed * Math.sin(this.angle) - other.speed * Math.sin(other.angle);
          const relVn = relVx * nx + relVy * ny;
          // Only resolve if approaching
          if(relVn < 0) {
            const impulse = relVn * 0.70; // stronger rebound to reduce AI clumping
            // Bleed the impulse into each kart's speed along their own heading
            this.speed  -= impulse * (Math.cos(this.angle)*nx  + Math.sin(this.angle)*ny);
            other.speed += impulse * (Math.cos(other.angle)*nx + Math.sin(other.angle)*ny);
            // Clamp to avoid karts reversing from a hit
            this.speed  = Math.max(this.speed,  -maxSpd * 0.15);
            other.speed = Math.max(other.speed, -maxSpd * 0.15);
            // Collision sound (quiet, not spammy)
            try { playCollision(0.22); } catch(e){}
          }
        }
      }

      // Anti-pileup nudge for AI karts that stay in repeated low-speed contacts.
      if(this.isAI) {
        if(contactHits > 0 && Math.abs(this.speed) < 96) this._contactJamTimer += dt;
        else this._contactJamTimer = Math.max(0, this._contactJamTimer - dt * 2.2);
        if(this._contactJamTimer > 0.45 && trackData && trackData.spline) {
          const jamTang = splineTangent(trackData.spline, this._nearestSplineIdx || 0);
          this.x += jamTang.x * 8;
          this.y += jamTang.y * 8;
          this.speed = Math.max(this.speed, 90);
          this._contactJamTimer = 0.18;
        }
      }
    }

    // ── ERS (Energy Recovery System) ───────────────────
    const bp = this.id === 0 ? BINDINGS.p1 : BINDINGS.p2;
    if(bp.ersMode === 'toggle') {
      const ersEdge = inp.ers && !this._ersPrevKey;
      if(ersEdge) this._ersToggled = !this._ersToggled;
      if(this.isOffTrack || this.ersCharge <= 0) this._ersToggled = false;
      this.ersActive = this._ersToggled;
    } else {
      this.ersActive = inp.ers && this.ersCharge > 0 && !this.isOffTrack;
    }
    this._ersPrevKey = !!inp.ers;

    const ersSpdAbs = Math.abs(this.speed);
    const ersSpdRatio = ersSpdAbs / Math.max(1, this.maxSpeed || this.baseMaxSpeed || 1);
    const hasAnalogSteer = typeof inp.steer === 'number';
    const ersSteering = hasAnalogSteer ? Math.abs(inp.steer) > 0.12 : !!(inp.left || inp.right);

    if(this.ersActive) {
      this.ersCharge = Math.max(0, this.ersCharge - (1 / 5) * dt);  // 5s full drain
      if(this.ersCharge <= 0) { this.ersActive = false; this._ersToggled = false; }
      this._ersPower = 1;
      this._ersStraightTimer = 0;
    } else {
      // Smooth blend-out (~1.15s) — spdLimit eases down so speed is not hard-cut
      this._ersPower = Math.max(0, (this._ersPower || 0) - (1 / 1.15) * dt);

      // Realistic harvest: braking > coast/lift > passive straight (no free always-on regen)
      // ~35% stronger than the original map so energy returns feel rewarding without trivialising boost.
      let regen = 0;
      if(brakeInput > 0.05 && ersSpdAbs > 18) {
        const brakeHarvest = (0.057 * brakeInput + 0.126 * brakeInput * brakeInput) * (0.45 + ersSpdRatio * 0.55);
        regen += brakeHarvest;
      } else if(throttleInput < 0.08 && brakeInput < 0.05 && ersSpdAbs > 12) {
        const liftCoast = throttleInput < 0.02 ? 0.065 : 0.048;
        regen += liftCoast * (0.35 + ersSpdRatio * 0.65);
      }

      // Small passive recharge after a sustained flat-out straight
      if(!ersSteering && throttleInput > 0.55 && ersSpdRatio > 0.58 && brakeInput < 0.05) {
        this._ersStraightTimer = (this._ersStraightTimer || 0) + dt;
      } else {
        this._ersStraightTimer = Math.max(0, (this._ersStraightTimer || 0) - dt * 2);
      }
      if(this._ersStraightTimer > 1.0) {
        regen += 0.021 + Math.min(0.017, (this._ersStraightTimer - 1.0) * 0.008);
      }

      if(regen > 0) this.ersCharge = Math.min(1, this.ersCharge + regen * dt);
    }

    // ── DRS (Drag Reduction System) ─────────────────────
    const drsInZone = this._inDrsZone(trackData);
    this.drsInZone = drsInZone;
    if(bp.drsMode === 'toggle') {
      const drsEdge = inp.drs && !this._drsPrevKey;
      if(drsEdge && drsInZone && this.drsAvailable && !this.isOffTrack) this._drsToggled = !this._drsToggled;
      if(!drsInZone || !this.drsAvailable || this.isOffTrack) this._drsToggled = false;
      this.drsActive = this._drsToggled;
    } else {
      this.drsActive = inp.drs && drsInZone && this.drsAvailable && !this.isOffTrack;
    }
    this._drsPrevKey = !!inp.drs;

    // Apply speed boosts to spdLimit (ERS uses blended power for smooth exit)
    const ersPower = Math.max(0, Math.min(1, this._ersPower || 0));
    if(ersPower > 0.001) spdLimit *= (1 + 0.25 * ersPower);
    if(this.drsActive) spdLimit *= 1.15;
    // Tyre failure hard cap: 0% wear → 100 km/h max (125 internal units)
    if(this.tyreWear >= 1.0) spdLimit = Math.min(spdLimit, 125);

    // Acceleration / braking — ERS also blends extra drive, then eases back to normal
    const ersAccMult = 1 + 0.14 * ersPower;
    if(throttleInput > 0.02 && brakeInput <= 0.02) {
      this.speed += acc * throttleInput * dt * ersAccMult;
    } else if(brakeInput > 0.02) {
      const brakeMul = Math.max(1, Math.min(2.5, inp.brakeMult || 1));
      const speedBeforeBrake = this.speed;
      if(this.speed > 0) this.speed -= this.brakeForce * brakeInput * dt;
      else this.speed -= acc * 0.5 * dt;
      if(this.speed > 0) this.speed -= this.brakeForce * (brakeMul - 1) * brakeInput * dt;
      // AI: limit sudden speed dumps so they do not collapse mid-corner for no reason.
      if(this.isAI && speedBeforeBrake > 0) {
        const maxDecel = 150 + Math.min(120, (brakeMul - 1) * 95); // units/sec
        const floorSpd = speedBeforeBrake - maxDecel * dt;
        if(this.speed < floorSpd) this.speed = floorSpd;
      }
    } else if(applyOffTrackSlowdown) {
      // Grass drag: heavier than coasting but weaker than braking
      this.speed *= Math.pow(0.96, dt * 60);
      if(Math.abs(this.speed) < 0.5) this.speed = 0;
    } else {
      // Fixed coast decel keeps brake input more meaningful than simply lifting.
      const coastStep = COAST_DECEL_PER_SEC * dt;
      if(this.speed > 0) this.speed = Math.max(0, this.speed - coastStep);
      else if(this.speed < 0) this.speed = Math.min(0, this.speed + coastStep);
      if(Math.abs(this.speed) < 0.5) this.speed = 0;
    }

    // Soft ceiling: when above current limit (ERS fade / DRS exit), bleed momentum
    // instead of an instant hard cut back to normal engine power.
    if(this.isAI) {
      if(this.speed > spdLimit) {
        const over = this.speed - spdLimit;
        this.speed -= Math.min(over, Math.max(over * 2.4 * dt, 12 * dt));
      }
      this.speed = Math.max(0, this.speed);
    } else {
      if(this.speed > spdLimit) {
        const over = this.speed - spdLimit;
        this.speed -= Math.min(over, Math.max(over * 2.2 * dt, 10 * dt));
      }
      this.speed = Math.max(-maxSpd * 0.3, this.speed);
    }

    // Speed-based grip / understeer: high speed bleeds turn-in so you cannot flat-out every corner.
    let scrubHeat = 0;
    let corneringHeat = 0;
    const hasAnalogSteerYaw = typeof inp.steer === 'number';
    const steeringInput = hasAnalogSteerYaw ? Math.abs(inp.steer) > 0.05 : !!(inp.left || inp.right);
    if(Math.abs(this.speed) > 4) {
      const speedRatio = Math.abs(this.speed) / Math.max(1, this.maxSpeed);
      const grip = Math.max(0.35, Math.min(1.25, this.grip == null ? 1 : this.grip));
      // Grip falls off with speed^1.1 — gentler high-speed understeer so the kart still rotates.
      const gripFactor = Math.max(0.24, (1.0 - Math.pow(speedRatio, 1.1) * 0.68) * grip);
      const maxYawRate = this.turnRate * gripFactor;
      const dir = this.speed >= 0 ? 1 : -1;
      let wantYaw = 0;
      if(hasAnalogSteerYaw) {
        wantYaw = this.turnRate * dt * dir * Math.max(-1, Math.min(1, inp.steer));
      } else {
        if(inp.left) wantYaw -= this.turnRate * dt * dir;
        if(inp.right) wantYaw += this.turnRate * dt * dir;
      }
      const maxYaw = maxYawRate * dt;
      const appliedYaw = Math.max(-maxYaw, Math.min(maxYaw, wantYaw));
      this.angle += appliedYaw;
      if(steeringInput && speedRatio > 0.25) {
        corneringHeat = speedRatio * (0.55 + Math.min(1, Math.abs(appliedYaw) / Math.max(0.0001, maxYaw)) * 0.45);
      }
      // Light scrub only when heavily over-asking for yaw at high speed.
      if(Math.abs(wantYaw) > maxYaw * 1.15 && speedRatio > 0.58) {
        const scrub = 0.003 + (speedRatio - 0.58) * 0.012;
        this.speed *= Math.pow(1 - scrub, dt * 60);
        scrubHeat = 0.7 + (speedRatio - 0.58) * 1.4;
      }
    }

    // ── TYRE TEMPERATURE ────────────────────────────────
    const tDef = TYRE_DEFS.find(t=>t.id===this.tyreId);
    const _spdAbs = Math.abs(this.speed);
    const _spdRatio = _spdAbs / Math.max(1, this.maxSpeed || this.baseMaxSpeed || 1);
    const ambTemp = getTyreAmbientTemp(window._raceWeather || 'dry', trackData);
    if(this.tyreTemp == null || !isFinite(this.tyreTemp)) this.tyreTemp = ambTemp + 8;
    if(tDef && this.noTyreWear) {
      // Shootout / no-wear modes: hold centre of optimal window
      this.tyreTemp = ((tDef.idealMin || 85) + (tDef.idealMax || 100)) * 0.5;
      this.tyreTempState = 'optimal';
    } else if(tDef) {
      const heatScale = (tDef.heatRate != null ? tDef.heatRate : 1) * 0.72;
      const coolScale = (tDef.coolRate != null ? tDef.coolRate : 1) * 0.78;
      const wearFrac = this.noTyreWear ? 0 : (this.tyreWear || 0);
      // Excess heat only opens later in tyre life, and ramps more gently.
      const wearHeatGate = wearFrac < 0.58 ? 0 : Math.min(1, (wearFrac - 0.58) / 0.16);
      const idealMid = ((tDef.idealMin || 85) + (tDef.idealMax || 100)) * 0.5;
      let heat = 0;
      let cool = 0;
      // Heavy braking — softened so dabs don't spike temperature
      if(brakeInput > 0.12 && _spdAbs > 35) heat += brakeInput * (0.28 + _spdRatio * 0.70) * 3.1;
      // Cornering + scrub
      heat += corneringHeat * 2.05;
      heat += scrubHeat * 2.2;
      // Acceleration
      if(throttleInput > 0.12 && _spdAbs > 18) heat += throttleInput * (0.18 + _spdRatio * 0.42) * 1.45;
      // Wheelspin proxy
      if(throttleInput > 0.72 && _spdRatio < 0.32 && _spdAbs > 5) {
        heat += (throttleInput - 0.72) * (0.32 - _spdRatio) * 4.2;
      }
      // Aggressive combined inputs — higher thresholds, lower gain
      if(steeringInput && throttleInput > 0.65 && _spdRatio > 0.62) heat += 0.85;
      if(steeringInput && brakeInput > 0.45 && _spdRatio > 0.48) heat += 0.95;
      if(ambTemp >= 28) heat += (ambTemp - 28) * 0.03;

      // Warm-up toward optimal is assisted; overheating stays gated by wear
      if(this.tyreTemp < idealMid) {
        heat *= 1.18; // natural warm-up into the window
      } else {
        heat *= 0.42 * wearHeatGate;
      }

      // Cooling — stronger while near/inside the window so temps hold steadier
      if(!steeringInput && _spdRatio > 0.45) cool += 3.2 + _spdRatio * 1.7;
      else if(!steeringInput) cool += 1.8;
      if(throttleInput < 0.08 && brakeInput < 0.08) cool += 2.6 + (1 - _spdRatio) * 1.4;
      if(_spdRatio < 0.35) cool += (0.35 - _spdRatio) * 3.0;
      if(ambTemp <= 20) cool += (20 - ambTemp) * 0.07;

      const idealLo = tDef.idealMin != null ? tDef.idealMin : 85;
      const idealHi = tDef.idealMax != null ? tDef.idealMax : 100;
      if(this.tyreTemp < idealLo) cool *= 0.32;
      // Inside the optimal band, damp net change so small mistakes don't kick you out
      const inWindow = this.tyreTemp >= idealLo && this.tyreTemp <= idealHi;
      const windowDamp = inWindow ? 0.55 : 1.0;

      const net = (heat * heatScale - cool * coolScale) * dt * windowDamp;
      const ambPull = (ambTemp - this.tyreTemp) * (0.035 + (_spdRatio < 0.25 ? 0.03 : 0)) * coolScale * dt;
      this.tyreTemp = Math.max(40, Math.min(128, this.tyreTemp + net + ambPull));
      // Soft clamp toward mid-window when already near-optimal and wear is low
      if(wearFrac < 0.45 && Math.abs(this.tyreTemp - idealMid) < 14) {
        this.tyreTemp += (idealMid - this.tyreTemp) * 0.35 * dt;
      }
      this.tyreTempState = getTyreTempState(this.tyreTemp, tDef);
    }

    // ── TYRE WEAR ──────────────────────────────────────
    if(!this.noTyreWear && tDef && !this.tyreWrongWeather) {
      const distTick = Math.abs(this.speed) * dt;
      // Total track distance ~3200 units/lap; lifespan in laps
      const wearRate = 1 / (tDef.lifespan * 4200);
      const tempWear = getTyreTempWearMult(this.tyreTemp, tDef);
      this.tyreWear = Math.min(1.0, this.tyreWear + distTick * wearRate * tempWear);
    }
    // Wear degrades: speed -35%, handling -25%, accel -18% at 100% worn
    const wear = this.noTyreWear ? 0 : this.tyreWear;
    if(this.noTyreWear) this.tyreWear = 0;
    const tempGrip = tDef ? getTyreTempGripMult(this.tyreTemp, tDef) : 1;
    const tempTract = tDef ? getTyreTempTractMult(this.tyreTemp, tDef) : 1;
    const tempBrake = tDef ? getTyreTempBrakeMult(this.tyreTemp, tDef) : 1;
    this.maxSpeed = this.baseMaxSpeed * (1 - wear * 0.35);
    this.turnRate = this.baseTurnRate * (1 - wear * 0.25) * (0.92 + tempGrip * 0.08);
    this.accel    = (this._baseAccel || (304 * GLOBAL_ACCEL_MULT)) * (1 - wear * 0.18) * tempTract;
    if(this._baseBrakeForce == null) this._baseBrakeForce = this.brakeForce || 700;
    this.brakeForce = this._baseBrakeForce * tempBrake;
    // Worn tyres also lose mechanical grip (more understeer); temp modulates further.
    if(this._baseGrip == null) this._baseGrip = this.grip == null ? 1 : this.grip;
    this.grip = this._baseGrip * (1 - wear * 0.40) * tempGrip;
    this.tyreGripPct = Math.max(0, Math.min(1, (1 - wear * 0.40) * tempGrip));

    // Particles: smoke when drifting, dust when on grass
    const _spd = Math.abs(this.speed);
    const _drifting = (inp.left || inp.right) && _spd > 175 && !this.isOffTrack;
    const _driftIntensity = _drifting ? Math.min(1, (_spd - 175) / 265) : 0;
    // Drift screech oscillator disabled — engine sound stays constant
    this.slideParticleTimer -= dt;
    if(this.slideParticleTimer <= 0 && _spd > 120) {
      if(_drifting) {
        spawnSmoke(this.x, this.y, this.angle + Math.PI);
        this.slideParticleTimer = 0.08;
      } else if(this.isOffTrack) {
        spawnDust(this.x, this.y, this.angle + Math.PI);
        this.slideParticleTimer = 0.11;
      }
    }

    // Move
    this.prevX = this.x; this.prevY = this.y;
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;

    // While pit-routing, hard-pull onto the densified pit centreline so cars cannot cut the painted corners.
    // Cap pull range — leftover pit flags on the race grid must never yank cars across the map.
    // Do not treat a pre-armed _pitExitPos alone as active routing (set on entry intent too).
    const pitRoutingActive = !this.inPit && this.pitPhase === null &&
      (this._pitIntentActive || this._pitEntryConfirmed || this._pitExiting);
    if(pitRoutingActive && trackData.pitLane && trackData.pitLane.path && trackData.pitLane.path.length >= 2) {
      const _plPath = trackData.pitLane.path;
      const pitHalf = (trackData.pitLane.width || 60) * 0.42;
      const PULL_MAX = Math.max(220, (trackData.pitLane.width || 60) * 3.5);
      let bestD = Infinity, bestX = this.x, bestY = this.y, bestAng = null;
      for(let i = 0; i < _plPath.length - 1; i++) {
        const a = _plPath[i], b = _plPath[i + 1];
        const abx = b.x - a.x, aby = b.y - a.y;
        const abLen2 = abx * abx + aby * aby || 1;
        const tt = Math.max(0, Math.min(1, ((this.x - a.x) * abx + (this.y - a.y) * aby) / abLen2));
        const px = a.x + abx * tt, py = a.y + aby * tt;
        const d = Math.hypot(this.x - px, this.y - py);
        if(d < bestD) {
          bestD = d; bestX = px; bestY = py;
          bestAng = Math.atan2(aby, abx);
        }
      }
      if(bestD > pitHalf && bestD < PULL_MAX) {
        const pull = Math.min(1, (bestD - pitHalf) / Math.max(1, pitHalf));
        this.x += (bestX - this.x) * Math.min(1, 0.55 + pull * 0.35);
        this.y += (bestY - this.y) * Math.min(1, 0.55 + pull * 0.35);
        if(bestAng !== null && this.speed > 8) {
          let ad = bestAng - this.angle;
          while (ad >  Math.PI) ad -= Math.PI * 2;
          while (ad < -Math.PI) ad += Math.PI * 2;
          this.angle += ad * Math.min(1, 0.20 + pull * 0.35);
        }
        if(this.speed > 70) this.speed *= Math.pow(0.94, dt * 60);
      } else if(bestD >= PULL_MAX && this._pitExiting && !this._pitIntentActive) {
        // Stale exit routing from a prior stage (e.g. quali) — drop it on the race line.
        this._pitExitPos = null;
        this._pitExitAngle = null;
        this._pitExiting = false;
      }
    }

    // Pit lane speed limiter — cap speed only inside pit lane corridor, not on adjacent race line
    this._onPitLane = false;
    if (!this.inPit && trackData.pitLane && trackData.pitLane.path) {
      const _plPath = trackData.pitLane.path;
      const _pitHwL = (trackData.pitLane.width || 60) / 2 + 28;
      const _trackHwL = trackData.trackWidth / 2 + 10;
      const _nearP = trackData.spline[this._nearestSplineIdx || 0];
      const _distTrackCenter = Math.hypot(this.x - _nearP.x, this.y - _nearP.y);
      for (let _pli = 0; _pli < _plPath.length - 1; _pli++) {
        if (distToSeg(this.x, this.y, _plPath[_pli].x, _plPath[_pli].y, _plPath[_pli+1].x, _plPath[_pli+1].y) < _pitHwL) {
          this._onPitLane = true; break;
        }
      }
      // At pit entry/exit the corridor overlaps the race line. Keep pit-lane state while
      // entering/exiting so cars follow the pit route instead of cutting back onto the track.
      if (this._onPitLane && _distTrackCenter <= _trackHwL) {
        const pitRouting = this._pitIntentActive || this._pitEntryConfirmed || this._pitExiting;
        if(!pitRouting) this._onPitLane = false;
      }
      if (this._onPitLane && this.speed > 130) this.speed = 130;
    }
    if(this._pitExiting && this._pitExitPos && Math.hypot(this.x - this._pitExitPos.x, this.y - this._pitExitPos.y) < 52) {
      if(this._pitExitAngle !== null && this._pitExitAngle !== undefined) this.angle = this._pitExitAngle;
      this._pitExitPos = null;
      this._pitExitAngle = null;
      this._pitExiting = false;
      this._pitIntentActive = false;
      this._pitEntryConfirmed = false;
    }

    // Off-track check
    this.isOffTrack = !this.onTrack(trackData);

    // Off-track slowdown for all drivers; 3s track-limit reset for human drivers only
    if (!this.finished) {
      // Strict threshold — just track half-width + small car-body margin (no generous buffer)
      const strictHw = trackData.trackWidth / 2 + 18;
      const nearP    = trackData.spline[this._nearestSplineIdx || 0];
      // Suppress off-track penalty when the kart is inside the pit lane
      let nearPitLane = false;
      if (trackData.pitLane && trackData.pitLane.path) {
        const pitHw = (trackData.pitLane.width || 60) / 2 + 28;
        const plPath = trackData.pitLane.path;
        for (let _pi = 0; _pi < plPath.length - 1; _pi++) {
          if (distToSeg(this.x, this.y, plPath[_pi].x, plPath[_pi].y, plPath[_pi+1].x, plPath[_pi+1].y) < pitHw) { nearPitLane = true; break; }
        }
      }
      this._isCompletelyOff = !nearPitLane && Math.hypot(this.x - nearP.x, this.y - nearP.y) >= strictHw;

      if (this._isCompletelyOff) {
        // Gradual bleed toward off-track cap — no instant snap to 80 km/h
        this.speed *= Math.pow(0.978, dt * 60);
        const offCap = 100;
        if (Math.abs(this.speed) > offCap) {
          const over = Math.abs(this.speed) - offCap;
          this.speed -= Math.sign(this.speed) * Math.min(over, Math.max(over * 2.6 * dt, 18 * dt));
        }

        if (!this.isAI) {
          if (this._penaltyTimer === 0) {
            // First frame of going completely off — impact sound + sparks
            spawnSpark(this.x, this.y);
            try { playCollision(0.45); } catch(e){}
          }
          this._penaltyTimer += dt;

          if (this._penaltyTimer >= 3.0) {
            // Reset to nearest on-track point, facing forward
            const spl = trackData.spline;
            const ni  = this._nearestSplineIdx || 0;
            this.x    = spl[ni].x;
            this.y    = spl[ni].y;
            const tang = splineTangent(spl, ni);
            this.angle = Math.atan2(tang.y, tang.x);
            this.speed = 0;
            this._penaltyTimer    = 0;
            this._isCompletelyOff = false;
            this.flashTimer = 2.2;
            this.rankFlash  = 'TRACK LIMIT — RESET!';
          }
        }
      } else {
        this._penaltyTimer    = 0;
        this._isCompletelyOff = false;
      }
    }

    // Ghost frame recording for Time Trial
    if(this.lapStart !== null && !this.finished) {
      this._ghostSampleTimer += dt;
      if(this._ghostSampleTimer >= 0.033) {
        this._ghostSampleTimer = 0;
        const gElapsed = (performance.now() - this.lapStart) / 1000;
        if(!this._ghostRecord) this._ghostRecord = [];
        this._ghostRecord.push({t: gElapsed, x: this.x, y: this.y, a: this.angle});
      }
    }

    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.checkCheckpoints(trackData);
    updateEngine(this.id, this.speed, this.maxSpeed, throttleInput > 0.12, brakeInput > 0.10);
    // Always correct AI orientation — prevents wrong-facing angle from cascading
    if (this.isAI) fixAIKartOrientation(this, trackData);
  }

  // Follow the densified pit-lane centreline. Look-ahead is in world units along the path
  // so sharp 90° pit corners are taken on the painted road, not as a chord cut.
  _followPitLanePath(path, destPos, speedFar, speedNear, stopDist) {
    if(!path || path.length < 2 || !destPos) return null;

    let nearestIdx = 0, nearestDist = Infinity;
    let destIdx = 0, destDist = Infinity;
    for(let i = 0; i < path.length; i++) {
      const dKart = Math.hypot(this.x - path[i].x, this.y - path[i].y);
      if(dKart < nearestDist) { nearestDist = dKart; nearestIdx = i; }
      const dDest = Math.hypot(destPos.x - path[i].x, destPos.y - path[i].y);
      if(dDest < destDist) { destDist = dDest; destIdx = i; }
    }

    // Always progress toward the destination along the path (never reverse along pit lane).
    if(nearestIdx > destIdx) nearestIdx = destIdx;

    // Project onto the local segment for a true centreline target.
    const segI = Math.min(nearestIdx, path.length - 2);
    const a = path[segI], b = path[segI + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const abLen = Math.hypot(abx, aby) || 1;
    const t = Math.max(0, Math.min(1, ((this.x - a.x) * abx + (this.y - a.y) * aby) / (abLen * abLen)));
    const projX = a.x + abx * t, projY = a.y + aby * t;
    const latX = this.x - projX, latY = this.y - projY;
    const latDist = Math.hypot(latX, latY);

    // Short look-ahead along the polyline (~1 car length at pit speeds).
    const lookWorld = 36 + Math.min(40, Math.abs(this.speed) * 0.22);
    let walked = 0;
    let targetIdx = nearestIdx;
    for(let i = nearestIdx; i < destIdx; i++) {
      const p0 = path[i], p1 = path[Math.min(i + 1, path.length - 1)];
      walked += Math.hypot(p1.x - p0.x, p1.y - p0.y);
      targetIdx = Math.min(i + 1, destIdx);
      if(walked >= lookWorld) break;
    }

    const remaining = Math.hypot(this.x - destPos.x, this.y - destPos.y);
    let aimX, aimY;
    if(remaining < (stopDist || 80)) {
      aimX = destPos.x;
      aimY = destPos.y;
    } else {
      // Prefer the next centreline point; if off-line, aim back onto the projection first.
      aimX = path[targetIdx].x;
      aimY = path[targetIdx].y;
      if(latDist > 8) {
        const pull = Math.min(1, (latDist - 4) / 28);
        aimX = projX * pull + aimX * (1 - pull);
        aimY = projY * pull + aimY * (1 - pull);
        // Nudge further toward the opposite side of the offset so it re-centres.
        aimX -= latX * 0.55 * pull;
        aimY -= latY * 0.55 * pull;
      }
    }

    let diff = Math.atan2(aimY - this.y, aimX - this.x) - this.angle;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    // Slow for sharp pit kinks (heading change along upcoming segments).
    let kink = 0;
    if(targetIdx > nearestIdx + 1) {
      const p0 = path[nearestIdx], p1 = path[Math.min(nearestIdx + 1, path.length - 1)];
      const p2 = path[targetIdx];
      const a1 = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const a2 = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      let da = a2 - a1;
      while (da >  Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      kink = Math.abs(da);
    }

    let holdSpeed = remaining > 160 ? speedFar : (remaining > (stopDist || 80) ? (speedFar + speedNear) * 0.5 : speedNear);
    if(kink > 0.55) holdSpeed = Math.min(holdSpeed, 58);
    else if(kink > 0.30) holdSpeed = Math.min(holdSpeed, 78);
    if(latDist > 22) holdSpeed = Math.min(holdSpeed, 64);

    const needsBrake = (Math.abs(diff) > 0.55 && this.speed > 55) ||
      (remaining < (stopDist || 80) && this.speed > speedNear + 6) ||
      (kink > 0.45 && this.speed > holdSpeed + 8);
    return {
      up: this.speed < holdSpeed && !needsBrake && remaining > (stopDist ? stopDist * 0.35 : 28),
      down: needsBrake || (remaining < (stopDist || 80) && this.speed > speedNear),
      left: diff < -0.035,
      right: diff > 0.035,
      brakeMult: needsBrake ? (kink > 0.5 ? 2.0 : 1.7) : 1,
      ers:false,
      drs:false,
      pit:false
    };
  }

  _getPitExitInput(trackData) {
    const pl = trackData && trackData.pitLane;
    if(!pl || !pl.path || pl.path.length < 2 || !this._pitExitPos) return null;
    const remaining = Math.hypot(this.x - this._pitExitPos.x, this.y - this._pitExitPos.y);
    if(remaining < 96) {
      const exitLead = (this._pitExitAngle !== null && this._pitExitAngle !== undefined)
        ? { x: this._pitExitPos.x + Math.cos(this._pitExitAngle) * 56, y: this._pitExitPos.y + Math.sin(this._pitExitAngle) * 56 }
        : this._pitExitPos;
      let diff = Math.atan2(exitLead.y - this.y, exitLead.x - this.x) - this.angle;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const needsBrake = Math.abs(diff) > 0.7 && this.speed > 86;
      return {
        up: this.speed < 118 && !needsBrake,
        down: needsBrake,
        left: diff < -0.04,
        right: diff > 0.04,
        brakeMult: needsBrake ? 1.6 : 1,
        ers:false, drs:false, pit:false
      };
    }
    return this._followPitLanePath(pl.path, this._pitExitPos, 110, 78, 70);
  }

  _getPitEntryInput(trackData) {
    const pl = trackData && trackData.pitLane;
    if(!pl || !pl.path || pl.path.length < 2 || !pl.garagePos || !pl.entryPt) return null;

    // Stage 1: drive to the pit entry trigger first.
    if(!this._pitEntryConfirmed) {
      const entryTouchRadius = Math.max(150, ((pl.width || 60) * 1.4));
      const dEntry = Math.hypot(this.x - pl.entryPt.x, this.y - pl.entryPt.y);
      if(dEntry <= entryTouchRadius || this._onPitLane) {
        this._pitEntryConfirmed = true;
      }

      // Aim at the first densified path point / entry — not a chord past the kink.
      const pathAim = pl.path[Math.min(2, pl.path.length - 1)] || pl.entryPt;
      let diffToEntry = Math.atan2(pathAim.y - this.y, pathAim.x - this.x) - this.angle;
      while (diffToEntry >  Math.PI) diffToEntry -= Math.PI * 2;
      while (diffToEntry < -Math.PI) diffToEntry += Math.PI * 2;

      const needsBrakeEntry = (Math.abs(diffToEntry) > 0.85 && this.speed > 70) || (dEntry < 130 && this.speed > 52);
      const holdSpeedEntry = dEntry > 220 ? 108 : (dEntry > 120 ? 78 : 54);
      return {
        up: this.speed < holdSpeedEntry && !needsBrakeEntry,
        down: needsBrakeEntry,
        left: diffToEntry < -0.04,
        right: diffToEntry > 0.04,
        brakeMult: needsBrakeEntry ? 1.8 : 1,
        ers:false,
        drs:false,
        pit:false
      };
    }

    // Stage 2: follow the densified pit lane polyline exactly to the garage box.
    return this._followPitLanePath(pl.path, pl.garagePos, 96, 36, 50);
  }

  onTrack(td) {
    // generous buffer, clipping the edge shouldnt trigger a penalty
    const hw = td.trackWidth / 2 + 55;
    const spl = td.spline;
    const n = spl.length;
    const curIdx = this._nearestSplineIdx || 0;
    // Progressive forward-biased window — prevents jumping to a different
    // overlapping section on complex tracks.
    let bestDist = Infinity, bestIdx = curIdx;
    for (let d = -8; d <= 80; d++) {
      const idx = ((curIdx + d) % n + n) % n;
      const dist = Math.hypot(this.x - spl[idx].x, this.y - spl[idx].y);
      if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
    }
    this._nearestSplineIdx = bestIdx;
    if (bestDist < hw) return true;
    // Also treat the pit lane path as on-track to prevent off-track penalties
    if (td.pitLane && td.pitLane.path) {
      const pitHw = (td.pitLane.width || 60) / 2 + 28;
      const path = td.pitLane.path;
      for (let i = 0; i < path.length - 1; i++) {
        if (distToSeg(this.x, this.y, path[i].x, path[i].y, path[i+1].x, path[i+1].y) < pitHw) return true;
      }
    }
    return false;
  }

  _inDrsZone(td) {
    if(!td || !td.drsZones || !td.drsZones.length) return false;
    const idx = this._nearestSplineIdx;
    for(const z of td.drsZones) {
      if(z.sIdx <= z.eIdx) {
        if(idx >= z.sIdx && idx <= z.eIdx) return true;
      } else {
        // zone wraps around (near lap start)
        if(idx >= z.sIdx || idx <= z.eIdx) return true;
      }
    }
    return false;
  }

  checkCheckpoints(td) {
    const cps = td.cpLines;
    const numCps = cps.length; // index 0 = S/F, 1..n-1 = intermediates
    const pitGate = td.pitSfGate;
    const canUsePitGate = !!pitGate && (this._onPitLane || this.inPit || this.pitPhase !== null);
    const crossedPitSf = canUsePitGate && linesCross(this.prevX,this.prevY,this.x,this.y, pitGate.x1,pitGate.y1,pitGate.x2,pitGate.y2);

    for(let i = 0; i < numCps; i++) {
      const cp = cps[i];
      const crossedMain = linesCross(this.prevX,this.prevY,this.x,this.y, cp.x1,cp.y1,cp.x2,cp.y2);
      if(i !== 0 && !crossedMain) continue;
      if(i === 0 && !crossedMain && !crossedPitSf) continue;

      if(i === 0) {
        // ── Start / Finish line ──────────────────────────
        // Only counts if all intermediate CPs were hit in order
        const allInterDone = this.nextCp >= numCps;
        const lapCompletionValid = allInterDone;
        if(lapCompletionValid && this.lap >= 0) {
          if(this.lap === 0 && this.lapStart === null) {
            // First crossing: start the lap timer
            this.lapStart = performance.now();
            this._ghostRecord = [];
            this._ghostSampleTimer = 0;
            this.checkpointsBit = 1;
            this.nextCp = 1;
            this.lastCheckpointTime = this.lapStart;
          } else if(this.lapStart !== null) {
            // Complete a lap
            const lapTime = (performance.now() - this.lapStart) / 1000;
            this.lapTimes.push(lapTime);
            if(lapTime < this.bestLap) {
              this._bestGhost = this._ghostRecord ? [...this._ghostRecord] : null;
              this.bestLap = lapTime; this.flashTimer = 1.5; this.rankFlash = 'BEST LAP!'; playLap(); spawnSpark(this.x,this.y);
            }
            else { playLap(); }
            // Time Trial: every completed lap saves to the leaderboard immediately
            if(!this.isAI && typeof race !== 'undefined' && race && race.mode === 'trial' && race.track) {
              const totalSoFar = this.lapTimes.reduce((a,b)=>a+b, 0);
              autoSaveLapToLeaderboard(race.track.id, lapTime, totalSoFar);
            }
            this.lap++;
            if(!this.isAI && typeof race !== 'undefined' && race && race.mode === 'trial') {
              this.ersCharge = 1.0;
              this._ersPower = 0;
              this.ersActive = false;
              this._ersToggled = false;
            }
            // Open sessions (Time Trial) never auto-finish on lap count.
            // Qualifying push-lap cars keep circulating after their target laps.
            const keepDriving = !!this._qualiKeepDriving;
            const pushDone = keepDriving && this.lap >= (this._qualiPushTarget || this.totalLaps || 1);
            if(pushDone) this._qualiPushDone = true;
            if(Number.isFinite(this.totalLaps) && this.lap >= this.totalLaps && !keepDriving) {
              this.finished = true;
              this.finishTime = this.lapTimes.reduce((a,b)=>a+b,0);
              if(typeof race !== 'undefined' && race) {
                this.finishOrder = race._nextFinishOrder++;
              }
              playFinish();
              stopEngine(this.id);
            } else {
              this.lapStart = performance.now();
              this._ghostRecord = [];
              this._ghostSampleTimer = 0;
              this.checkpointsBit = 1;
              this.nextCp = 1;
              this.lastCheckpointTime = this.lapStart;
            }
          }
        } else if(this.lapStart === null) {
          // Race start: crossed S/F before any intermediates exist
          this.lapStart = performance.now();
          this._ghostRecord = [];
          this._ghostSampleTimer = 0;
          this.checkpointsBit = 1;
          this.nextCp = 1;
          this.lastCheckpointTime = this.lapStart;
        }
        // If allInterDone is false and lapStart is set, player crossed S/F out of order — ignore
      } else {
        // ── Intermediate checkpoint ──────────────────────
        // Only register if this is exactly the next expected checkpoint
        if(i === this.nextCp) {
          this.checkpointsBit |= (1 << i);
          this.nextCp = i + 1;
          this.lastCheckpointTime = performance.now();
        }
        // If i < nextCp: already passed (going backwards) — ignore
        // If i > nextCp: skipped one — ignore, do not light green
      }
    }
  }

  draw(ctx, camX, camY, camW, camH) {
    const vis = (typeof kartVisPose === 'function') ? kartVisPose(this) : { x: this.x, y: this.y, angle: this.angle };
    const sx = vis.x - camX + camW/2;
    const sy = vis.y - camY + camH/2;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(vis.angle);

    const flash = this.flashTimer > 0 && Math.floor(this.flashTimer*8)%2===0;
    const liv = this.livery || null;
    const chassis = liv ? getPaintColor(liv.chassis) : { body:this.color, shadow:this.shadowColor };
    const rims = (liv && liv.rims && liv.rims !== 'stock')
      ? getPaintColor(liv.rims)
      : { body:'#3c3c3c', shadow:'#555555' };
    const col = flash ? '#ffffff' : chassis.body;
    const acc = flash ? '#ffffff' : chassis.shadow;
    const rimCol = flash ? '#ffffff' : rims.body;
    const spokeCol = flash ? '#ffffff' : (rims.shadow || rims.body);

    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 3;

    // rear wing blade
    ctx.fillStyle = col;
    ctx.fillRect(-21, -9, 5, 18);
    ctx.fillStyle = acc;
    ctx.fillRect(-21, -9, 2, 18);
    ctx.fillRect(-17, -9, 2, 5);
    ctx.fillRect(-17,  4, 2, 5);

    // diffuser behind rear axle
    ctx.fillStyle = acc;
    ctx.beginPath();
    ctx.moveTo(-14,-5); ctx.lineTo(-20,-7); ctx.lineTo(-20,7); ctx.lineTo(-14,5);
    ctx.closePath(); ctx.fill();

    // sidepods
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-11,-8); ctx.lineTo(4,-8); ctx.lineTo(6,-5); ctx.lineTo(-11,-5);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-11,8); ctx.lineTo(4,8); ctx.lineTo(6,5); ctx.lineTo(-11,5);
    ctx.closePath(); ctx.fill();

    // main body/monocoque (narrow central spine)
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-12,-4);
    ctx.lineTo(8,-3);
    ctx.lineTo(13,-1.5);
    ctx.lineTo(13,1.5);
    ctx.lineTo(8,3);
    ctx.lineTo(-12,4);
    ctx.closePath();
    ctx.fill();

    // tapered nose cone
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(12,-1.8); ctx.lineTo(19,-0.6); ctx.lineTo(19,0.6); ctx.lineTo(12,1.8);
    ctx.closePath(); ctx.fill();

    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    // cockpit opening
    ctx.fillStyle = flash ? '#aaddff' : '#0c1b2a';
    ctx.beginPath();
    ctx.ellipse(1, 0, 4, 2.5, 0, 0, Math.PI*2);
    ctx.fill();

    // halo arch
    ctx.strokeStyle = acc;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-2,-2.5);
    ctx.quadraticCurveTo(2,-6.5,6,-2.5);
    ctx.stroke();

    // T-cam (yellow nub on top of halo)
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(0,-6,2,3);

    // front wing (wide)
    ctx.fillStyle = col;
    ctx.fillRect(16,-12,5,24);
    ctx.fillStyle = acc;
    ctx.fillRect(16,-12,5,4);
    ctx.fillRect(16, 8,5,4);

    // wheels - exposed round F1 style
    ctx.fillStyle = '#141414';
    [[10,-10],[10,10],[-8,-10],[-8,10]].forEach(([wx,wy])=>{
      ctx.beginPath(); ctx.arc(wx,wy,4.5,0,Math.PI*2); ctx.fill();
      ctx.fillStyle = rimCol;
      ctx.beginPath(); ctx.arc(wx,wy,2.6,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle = spokeCol; ctx.lineWidth = 0.7;
      for(let s=0;s<5;s++){
        const a=s*Math.PI*2/5;
        ctx.beginPath(); ctx.moveTo(wx,wy); ctx.lineTo(wx+Math.cos(a)*2.6,wy+Math.sin(a)*2.6); ctx.stroke();
      }
      ctx.fillStyle = '#141414';
    });

    // car number
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 8px Nunito,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.id+1, 1, 0.5);

    ctx.restore();
  }
  // Apply a freshly fitted tyre (called after pit stop)
  _applyNewTyre(tyreId, weather) {
    if(!tyreId) return;
    const w = normalizeWeatherId(weather || window._raceWeather || 'dry');
    this.tyreId = tyreId;
    this.tyreWear = 0;
    // Rebuild speed/handling from scratch using stored base upgrade values
    // Re-apply weather + tyre combo
    const savedBase = this._upgradeBase || {maxSpeed:469, turnRate:2.22, accel:304 * GLOBAL_ACCEL_MULT, grip:0.78};
    this.maxSpeed  = savedBase.maxSpeed;
    this.turnRate  = savedBase.turnRate;
    this.accel     = savedBase.accel || (304 * GLOBAL_ACCEL_MULT);
    this.grip      = savedBase.grip == null ? 0.72 : savedBase.grip;
    this._baseGrip = this.grip;
    this._baseAccel = this.accel;
    if(savedBase.brakeForce != null) this._baseBrakeForce = savedBase.brakeForce;
    applyWeatherToKart(this, w, tyreId);
    // Fresh set comes out of blankets just below the optimal window
    const freshDef = TYRE_DEFS.find(t => t.id === tyreId) || TYRE_DEFS[1];
    const amb = getTyreAmbientTemp(w, null);
    const blanket = freshDef.idealMin != null ? freshDef.idealMin - 2 : amb + 18;
    this.tyreTemp = Math.max(amb + 10, Math.min(blanket, (freshDef.idealMin || 85) - 2));
    this.tyreTempState = getTyreTempState(this.tyreTemp, freshDef);
    this.tyreGripPct = getTyreTempGripMult(this.tyreTemp, freshDef);
    this.flashTimer = 1.2;
    this.rankFlash  = 'TYRES FITTED!';
    beep(660,0.1,0.4,'square'); beep(880,0.15,0.4,'square',0.08); beep(1100,0.2,0.5,'sine',0.14);
  }
}

// ── SCENERY RENDERER ────────────────────────────────────
function drawScenery(ctx, td, ofx, ofy) {
  const sc = td.scenery;
  if(!sc) return;
  const accent = td.accentColor || '#00f5ff';
  const treeBaseA = td.treeColor || '#1a4010';
  const treeHiA = td.treeColor2 || '#2a6018';
  // Derive a slightly darker/lighter pair when only one tree colour is set
  const treeBaseB = td.treeColor || '#224818';
  const treeHiB = td.treeColor2 || '#347520';

  // ── Trees ──────────────────────────────────────────────
  if(sc.trees) {
    for(const t of sc.trees) {
      const sx = t.x + ofx, sy = t.y + ofy;
      // Skip off-screen
      if(sx < -80 || sx > 1360 || sy < -80 || sy > 800) continue;
      // Shadow
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(sx + 4, sy + 5, t.r * 0.9, t.r * 0.55, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
      // Canopy — two layers for depth (track-tinted)
      const darkG = t.shade < 0.5;
      const base = darkG ? treeBaseA : treeBaseB;
      const hi   = darkG ? treeHiA : treeHiB;
      ctx.beginPath();
      ctx.arc(sx, sy, t.r, 0, Math.PI*2);
      ctx.fillStyle = base;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx - t.r*0.2, sy - t.r*0.2, t.r * 0.65, 0, Math.PI*2);
      ctx.fillStyle = hi;
      ctx.fill();
    }
  }

  // ── Advertising boards ─────────────────────────────────
  const adPalette = [accent, '#ff2200', '#ffdd00', '#00ddff', '#ff00cc', '#ffffff'];
  const adTexts   = ['TURBO','APEX','BLITZ','SPEED','BOOST','VOLT','NEON','MAX'];
  if(sc.adboards) {
    sc.adboards.forEach((ab, ai) => {
      const sx = ab.x + ofx, sy = ab.y + ofy;
      if(sx < -120 || sx > 1400 || sy < -80 || sy > 800) return;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(ab.angle);
      const bw = 72, bh = 22;
      // Board background
      ctx.fillStyle = adPalette[ai % adPalette.length];
      ctx.fillRect(-bw/2, -bh/2, bw, bh);
      // Dark border
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 2;
      ctx.strokeRect(-bw/2, -bh/2, bw, bh);
      // Text
      ctx.fillStyle = '#000';
      ctx.font = 'bold 10px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(adTexts[ai % adTexts.length], 0, 0);
      ctx.restore();
    });
  }

  // ── Grandstands + crowds ───────────────────────────────
  const defaultSeatPalettes = [
    ['#cc2222','#2244cc','#22aa44','#ccaa00'],
    ['#aa00cc','#cc6600','#006688','#bb3300'],
    ['#993333','#334499','#116611','#998800'],
  ];
  const trackSeatPalette = td.seatPalette || null;
  const crowdColors = td.crowdColors || ['#e8d4b8','#c4a882','#8b6914','#f5c6a0','#d4a574','#2a2a2a','#1a3a6a','#8b2020','#eeeeee'];
  const standRoof = td.standRoof || '#1e1e28';
  const standConcrete = td.standConcrete || '#2a2a35';
  if(sc.stands) {
    sc.stands.forEach((st, si) => {
      const sx = st.x + ofx, sy = st.y + ofy;
      // Cull off-screen stands
      if(sx < -350 || sx > 1630 || sy < -350 || sy > 1070) return;
      ctx.save();
      ctx.translate(sx, sy);
      // Stands face the track: rotate so the "front" faces toward track center
      ctx.rotate(st.angle + (st.perpSign >= 0 ? Math.PI/2 : -Math.PI/2));

      const rows = st.rows || 3;
      const rowH = 18;
      const totalH = rows * rowH + 14;
      const w = st.width;
      const palette = trackSeatPalette || defaultSeatPalettes[si % defaultSeatPalettes.length];

      // Concrete foundation/back wall
      ctx.fillStyle = standConcrete;
      ctx.fillRect(-w/2 - 4, 0, w + 8, totalH + 4);

      // Stepped tiers
      for(let r = 0; r < rows; r++) {
        const rowY = 8 + r * rowH;
        const stepIn = r * 5;
        // Tier backing
        ctx.fillStyle = r % 2 === 0 ? '#383845' : '#303040';
        ctx.fillRect(-w/2 + stepIn, rowY, w - stepIn*2, rowH);
        // Individual seats — colored blocks
        const seatW = 11, seatH = rowH - 5, seatGap = 3;
        for(let s = 0; s < w - stepIn*2 - seatW; s += seatW + seatGap) {
          const col = palette[Math.floor(s / ((w - stepIn*2) / palette.length)) % palette.length];
          ctx.fillStyle = col;
          ctx.fillRect(-w/2 + stepIn + s + 2, rowY + 4, seatW, seatH);
          // Seatback highlight
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fillRect(-w/2 + stepIn + s + 2, rowY + 4, seatW, 3);
        }
      }

      // Crowds — packed spectators in the seats (seeded per stand for stable cache)
      let cr = ((si * 9973) ^ (Math.floor(st.x) * 7919) ^ (Math.floor(st.y) * 104729)) >>> 0;
      const crand = () => { cr = (Math.imul(cr, 1664525) + 1013904223) >>> 0; return cr / 4294967296; };
      for(let r = 0; r < rows; r++) {
        const rowY = 8 + r * rowH;
        const stepIn = r * 5;
        const usable = w - stepIn * 2;
        for(let s = 0; s < usable - 6; s += 6.5) {
          if(crand() > 0.82) continue; // leave some empty seats
          const px = -w/2 + stepIn + s + 3;
          const py = rowY + 9 + (crand() - 0.5) * 2;
          // torso / jersey
          ctx.fillStyle = crowdColors[Math.floor(crand() * crowdColors.length) % crowdColors.length];
          ctx.fillRect(px - 2.2, py, 4.4, 5);
          // head
          ctx.fillStyle = crowdColors[Math.floor(crand() * crowdColors.length) % crowdColors.length];
          ctx.beginPath();
          ctx.arc(px, py - 1.5, 2.1 + crand() * 0.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Roof canopy
      ctx.fillStyle = standRoof;
      ctx.fillRect(-w/2 - 8, -16, w + 16, 18);
      // Roof edge highlight
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(-w/2 - 8, -16);
      ctx.lineTo(w/2 + 8, -16);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Support struts
      ctx.strokeStyle = '#555566';
      ctx.lineWidth = 3;
      const strutCount = Math.max(1, Math.floor(w / 80));
      for(let sv = 0; sv <= strutCount; sv++) {
        const sx2 = -w/2 + sv * (w / strutCount);
        ctx.beginPath();
        ctx.moveTo(sx2, -14);
        ctx.lineTo(sx2, totalH);
        ctx.stroke();
      }

      // Occasional flag on roof
      if(si % 3 === 0) {
        const fx = w/4;
        ctx.strokeStyle = '#aaaacc';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(fx, -16); ctx.lineTo(fx, -36); ctx.stroke();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(fx, -36); ctx.lineTo(fx + 18, -30); ctx.lineTo(fx, -24);
        ctx.closePath(); ctx.fill();
      }

      ctx.restore();
    });
  }
}

let _trackBaseCache = null;

function clearTrackBaseCache() {
  _trackBaseCache = null;
}

function buildTrackBaseCache(td) {
  const spl = td && td.spline;
  if(!td || !spl || !spl.length) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pad = Math.max(220, (td.trackWidth || 0) + 180);
  const addPoint = (x, y, extra = 0) => {
    minX = Math.min(minX, x - extra);
    minY = Math.min(minY, y - extra);
    maxX = Math.max(maxX, x + extra);
    maxY = Math.max(maxY, y + extra);
  };

  spl.forEach(p => addPoint(p.x, p.y, pad));
  if(td.pitLane && td.pitLane.path) td.pitLane.path.forEach(p => addPoint(p.x, p.y, pad));
  if(td.scenery) {
    (td.scenery.stands || []).forEach(s => addPoint(s.x, s.y, 140));
    (td.scenery.trees || []).forEach(t => addPoint(t.x, t.y, (t.r || 24) + 40));
    (td.scenery.adboards || []).forEach(a => addPoint(a.x, a.y, 120));
  }

  if(!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;

  minX = Math.floor(minX);
  minY = Math.floor(minY);
  maxX = Math.ceil(maxX);
  maxY = Math.ceil(maxY);

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const cacheCanvas = document.createElement('canvas');
  cacheCanvas.width = width;
  cacheCanvas.height = height;
  const cacheCtx = cacheCanvas.getContext('2d');
  const ofx = -minX;
  const ofy = -minY;

  cacheCtx.fillStyle = td.bgColor;
  cacheCtx.fillRect(0, 0, width, height);
  cacheCtx.fillStyle = td.grassColor;
  cacheCtx.fillRect(0, 0, width, height);

  const stripeSize = 60;
  cacheCtx.save();
  cacheCtx.globalAlpha = 0.3;
  const worldMinX = Math.floor(minX / stripeSize) * stripeSize;
  const worldMinY = Math.floor(minY / stripeSize) * stripeSize;
  const worldMaxX = maxX + stripeSize;
  const worldMaxY = maxY + stripeSize;
  for(let wx = worldMinX; wx < worldMaxX; wx += stripeSize) {
    for(let wy = worldMinY; wy < worldMaxY; wy += stripeSize) {
      if((Math.floor(wx / stripeSize) + Math.floor(wy / stripeSize)) % 2 === 0) {
        cacheCtx.fillStyle = td.grassColor2;
        cacheCtx.fillRect(wx + ofx, wy + ofy, stripeSize, stripeSize);
      }
    }
  }
  cacheCtx.restore();

  drawScenery(cacheCtx, td, ofx, ofy);
  drawPitLane(cacheCtx, td, ofx, ofy);

  cacheCtx.beginPath();
  cacheCtx.moveTo(spl[0].x + ofx, spl[0].y + ofy);
  for(let i = 1; i < spl.length; i++) cacheCtx.lineTo(spl[i].x + ofx, spl[i].y + ofy);
  cacheCtx.closePath();
  cacheCtx.strokeStyle = td.borderColor;
  cacheCtx.lineWidth = td.trackWidth + 8;
  cacheCtx.lineCap = 'round';
  cacheCtx.lineJoin = 'round';
  cacheCtx.stroke();

  cacheCtx.beginPath();
  cacheCtx.moveTo(spl[0].x + ofx, spl[0].y + ofy);
  for(let i = 1; i < spl.length; i++) cacheCtx.lineTo(spl[i].x + ofx, spl[i].y + ofy);
  cacheCtx.closePath();
  cacheCtx.strokeStyle = td.trackColor;
  cacheCtx.lineWidth = td.trackWidth;
  cacheCtx.stroke();

  cacheCtx.setLineDash([24, 16]);
  cacheCtx.strokeStyle = 'rgba(255,255,255,0.25)';
  cacheCtx.lineWidth = 2;
  cacheCtx.beginPath();
  cacheCtx.moveTo(spl[0].x + ofx, spl[0].y + ofy);
  for(let i = 1; i < spl.length; i++) cacheCtx.lineTo(spl[i].x + ofx, spl[i].y + ofy);
  cacheCtx.closePath();
  cacheCtx.stroke();
  cacheCtx.setLineDash([]);

  cacheCtx.strokeStyle = td.borderColor;
  cacheCtx.lineWidth = 5;
  cacheCtx.globalAlpha = 0.5;
  cacheCtx.beginPath();
  cacheCtx.moveTo(spl[0].x + ofx, spl[0].y + ofy);
  for(let i = 1; i < spl.length; i++) cacheCtx.lineTo(spl[i].x + ofx, spl[i].y + ofy);
  cacheCtx.closePath();
  cacheCtx.stroke();
  cacheCtx.globalAlpha = 1;

  const sf = td.cpLines[0];
  const sfAngle = Math.atan2(sf.y2 - sf.y1, sf.x2 - sf.x1);
  cacheCtx.save();
  cacheCtx.translate(sf.cx + ofx, sf.cy + ofy);
  cacheCtx.rotate(sfAngle);
  const sfW = Math.hypot(sf.x2 - sf.x1, sf.y2 - sf.y1);
  const sqSize = 8;
  for(let ci = 0; ci < sfW / sqSize + 1; ci++) {
    for(let ri = 0; ri < 3; ri++) {
      cacheCtx.fillStyle = (ci + ri) % 2 === 0 ? '#ffffff' : '#000000';
      cacheCtx.fillRect(ci * sqSize - sfW / 2, ri * sqSize - sqSize * 1.5, sqSize, sqSize);
    }
  }
  cacheCtx.restore();

  if(td.drsZones) {
    for(const zone of td.drsZones) {
      cacheCtx.save();
      cacheCtx.lineCap = 'round';
      cacheCtx.setLineDash([]);
      cacheCtx.beginPath();
      cacheCtx.moveTo(zone.x1 + ofx, zone.y1 + ofy);
      cacheCtx.lineTo(zone.x2 + ofx, zone.y2 + ofy);
      cacheCtx.strokeStyle = 'rgba(0,120,255,0.32)';
      cacheCtx.lineWidth = 20;
      cacheCtx.stroke();
      cacheCtx.beginPath();
      cacheCtx.moveTo(zone.x1 + ofx, zone.y1 + ofy);
      cacheCtx.lineTo(zone.x2 + ofx, zone.y2 + ofy);
      cacheCtx.strokeStyle = '#2299ff';
      cacheCtx.lineWidth = 4;
      cacheCtx.stroke();
      cacheCtx.fillStyle = '#66bbff';
      cacheCtx.font = 'bold 10px Nunito,sans-serif';
      cacheCtx.textAlign = 'center';
      cacheCtx.textBaseline = 'middle';
      cacheCtx.fillText('DRS', zone.cx + ofx, zone.cy + ofy - 16);
      cacheCtx.restore();
    }
  }

  drawPitGarage(cacheCtx, td, ofx, ofy);

  return {
    trackId: td.id,
    canvas: cacheCanvas,
    minX,
    minY,
    maxX,
    maxY
  };
}

function ensureTrackBaseCache(td) {
  if(!_trackBaseCache || _trackBaseCache.trackId !== td.id) {
    _trackBaseCache = buildTrackBaseCache(td);
  }
  return _trackBaseCache;
}

function clampCamToTrack(cam, td, kart) {
  if(!cam) return;
  const fx = (kart && isFinite(kart.x)) ? kart.x : ((td && td.startPos && td.startPos.x) || 0);
  const fy = (kart && isFinite(kart.y)) ? kart.y : ((td && td.startPos && td.startPos.y) || 0);
  if(!isFinite(cam.x) || !isFinite(cam.y)) {
    cam.x = fx;
    cam.y = fy;
  }
  const cache = td ? ensureTrackBaseCache(td) : null;
  if(cache && isFinite(cache.minX) && isFinite(cache.maxX) && isFinite(cache.minY) && isFinite(cache.maxY)) {
    const m = 90;
    const minX = cache.minX + m;
    const maxX = cache.maxX - m;
    const minY = cache.minY + m;
    const maxY = cache.maxY - m;
    if(maxX > minX) cam.x = Math.max(minX, Math.min(maxX, cam.x));
    if(maxY > minY) cam.y = Math.max(minY, Math.min(maxY, cam.y));
  }
}

function drawTrackBaseCache(ctx, td, camX, camY, camW, camH) {
  const cache = ensureTrackBaseCache(td);
  if(!cache || !cache.canvas) return false;
  const worldLeft = camX - camW * 0.5;
  const worldTop = camY - camH * 0.5;
  const srcX = worldLeft - cache.minX;
  const srcY = worldTop - cache.minY;
  const sx = Math.max(0, Math.floor(srcX));
  const sy = Math.max(0, Math.floor(srcY));
  const dx = Math.max(0, Math.floor(sx - srcX));
  const dy = Math.max(0, Math.floor(sy - srcY));
  const sw = Math.min(camW - dx, cache.canvas.width - sx);
  const sh = Math.min(camH - dy, cache.canvas.height - sy);
  ctx.fillStyle = td.bgColor;
  ctx.fillRect(0, 0, camW, camH);
  if(sw <= 0 || sh <= 0) return false;
  ctx.drawImage(cache.canvas, sx, sy, sw, sh, dx, dy, sw, sh);
  return true;
}

function drawTrack(ctx, td, camX, camY, camW, camH, kartBits) {
  const spl = td.spline;
  const ofx = camW/2 - camX, ofy = camH/2 - camY;
  drawTrackBaseCache(ctx, td, camX, camY, camW, camH);

  // Checkpoint lines — bright yellow (pending) → green (passed this lap)
  for(let i=1;i<td.cpLines.length;i++) {
    const cp = td.cpLines[i];
    const passed = kartBits !== undefined && (kartBits & (1<<i));
    const col  = passed ? 'rgba(0,255,90,0.95)'  : 'rgba(255,220,0,0.95)';
    const glow = passed ? 'rgba(0,255,90,0.28)'  : 'rgba(255,220,0,0.28)';
    ctx.save();
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    // outer glow
    ctx.beginPath();
    ctx.moveTo(cp.x1+ofx, cp.y1+ofy);
    ctx.lineTo(cp.x2+ofx, cp.y2+ofy);
    ctx.strokeStyle = glow;
    ctx.lineWidth = 18;
    ctx.stroke();
    // bright core line
    ctx.beginPath();
    ctx.moveTo(cp.x1+ofx, cp.y1+ofy);
    ctx.lineTo(cp.x2+ofx, cp.y2+ofy);
    ctx.strokeStyle = col;
    ctx.lineWidth = 5;
    ctx.stroke();
    // small CP number label
    ctx.fillStyle = col;
    ctx.font = 'bold 11px Nunito,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(i, cp.cx+ofx, cp.cy+ofy);
    ctx.restore();
  }

}

// ── PIT LANE ROAD DRAW ──────────────────────────────────
function drawPitLane(ctx, td, ofx, ofy) {
  const pl = td.pitLane;
  if (!pl || !pl.path || pl.path.length < 2) return;
  const path = pl.path;
  const pw = pl.width || 60;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Border (matches track border colour)
  ctx.strokeStyle = td.borderColor || '#ff9500';
  ctx.lineWidth = pw + 8;
  ctx.beginPath();
  ctx.moveTo(path[0].x + ofx, path[0].y + ofy);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x + ofx, path[i].y + ofy);
  ctx.stroke();
  // Pit road asphalt (slightly lighter than main track so it reads as a separate surface)
  ctx.strokeStyle = '#252018';
  ctx.lineWidth = pw;
  ctx.beginPath();
  ctx.moveTo(path[0].x + ofx, path[0].y + ofy);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x + ofx, path[i].y + ofy);
  ctx.stroke();
  // Speed-limit centre dashes
  ctx.setLineDash([14, 10]);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(path[0].x + ofx, path[0].y + ofy);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x + ofx, path[i].y + ofy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ── PIT GARAGE DRAW (called inside drawTrack context) ───
function drawPitGarage(ctx, td, ofx, ofy) {
  if(!td.pitPos && !td.pitLane) return;
  const pl = td.pitLane;
  const garagePos = pl ? pl.garagePos : td.pitPos;
  const px = garagePos.x + ofx, py = garagePos.y + ofy;
  const now = performance.now();

  // Visual-only offset: push boards further into the pit lane so they sit
  // clear of the racing line. Detection/entryPt/exitPos logic is untouched.
  const offsetAlong = (from, toward, dist) => {
    if(!from || !toward) return from;
    const dx = toward.x - from.x, dy = toward.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: from.x + (dx / len) * dist, y: from.y + (dy / len) * dist };
  };

  if (pl) {
    // ── PIT IN board at entry point ──
    const pathTowardEntry = (pl.path && pl.path.length > 1) ? pl.path[1] : (pl.garagePos || pl.entryPt);
    const ep = offsetAlong(pl.entryPt, pathTowardEntry, 72);
    const ex = ep.x + ofx, ey = ep.y + ofy;
    ctx.save();
    // Orange board above track edge
    ctx.fillStyle = 'rgba(255,149,0,0.95)';
    ctx.fillRect(ex - 30, ey - 52, 60, 20);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.strokeRect(ex - 30, ey - 52, 60, 20);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 10px Nunito,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PIT ENTRY', ex, ey - 42);
    // downward arrow from board to track edge
    ctx.strokeStyle = 'rgba(255,149,0,0.8)'; ctx.lineWidth = 2;
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(ex, ey - 32); ctx.lineTo(ex, ey - 8);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();

    // ── PIT EXIT board at exit point ──
    const pathTowardExit = (pl.path && pl.path.length > 1) ? pl.path[pl.path.length - 2] : (pl.garagePos || pl.exitPos);
    const xp = offsetAlong(pl.exitPos, pathTowardExit, 72);
    const xx = xp.x + ofx, xy = xp.y + ofy;
    ctx.save();
    // Green board (standard motorsport pit exit colour)
    ctx.fillStyle = 'rgba(0,190,50,0.95)';
    ctx.fillRect(xx - 34, xy - 52, 68, 20);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.strokeRect(xx - 34, xy - 52, 68, 20);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px Nunito,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PIT EXIT', xx, xy - 42);
    // upward arrow from track edge to board
    ctx.strokeStyle = 'rgba(0,210,60,0.8)'; ctx.lineWidth = 2;
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(xx, xy - 8); ctx.lineTo(xx, xy - 32);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();

    // ── Pit speed limit sign along pit lane ──
    // place it at the midpoint of path segment 1→2
    if(pl.path.length >= 3) {
      const mid = pl.path[Math.floor(pl.path.length / 2)];
      const mx = mid.x + ofx, my = mid.y + ofy;
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(mx, my - 50, 14, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = '#cc0000'; ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#cc0000';
      ctx.font = 'bold 10px Nunito,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('80', mx, my - 50);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '7px Nunito,sans-serif';
      ctx.fillText('KM/H', mx, my - 37);
      ctx.restore();
    }
  }

  // ── Garage box with pulsing "PIT HERE" zone ──
  const pulse = 0.55 + 0.45 * Math.sin(now / 400);
  const gw = 110, gh = 52;
  ctx.save();
  // Pulsing highlight circle behind garage
  ctx.globalAlpha = pulse * 0.35;
  ctx.fillStyle = '#ff9500';
  ctx.beginPath(); ctx.arc(px, py, 80, 0, Math.PI*2); ctx.fill();
  ctx.globalAlpha = 1;
  // Shadow + garage floor
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 16;
  ctx.fillStyle = '#0e0e16';
  ctx.fillRect(px - gw/2, py - gh/2, gw, gh);
  ctx.shadowBlur = 0;
  // Animated orange border
  ctx.strokeStyle = `rgba(255,149,0,${0.7 + 0.3*pulse})`; ctx.lineWidth = 3;
  ctx.strokeRect(px - gw/2, py - gh/2, gw, gh);
  // Chevron stripes on floor
  ctx.save();
  ctx.rect(px - gw/2, py - gh/2, gw, gh);
  ctx.clip();
  for(let si = -2; si < 7; si++) {
    ctx.fillStyle = si % 2 === 0 ? 'rgba(255,149,0,0.10)' : 'rgba(255,149,0,0.04)';
    ctx.beginPath();
    ctx.moveTo(px - gw/2 + si*18, py - gh/2);
    ctx.lineTo(px - gw/2 + si*18 + 14, py - gh/2);
    ctx.lineTo(px - gw/2 + si*18 + 14 - 10, py + gh/2);
    ctx.lineTo(px - gw/2 + si*18 - 10, py + gh/2);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // "PIT HERE" label
  ctx.fillStyle = `rgba(255,175,0,${0.85 + 0.15*pulse})`;
  ctx.font = 'bold 13px Nunito,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('PIT HERE', px, py - 9);
  // Sub-label: auto-trigger info
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '7px Nunito,sans-serif';
  ctx.fillText('DRIVE IN · PICK TYRES', px, py + 7);
  // small tyre icon dots
  const dotCols = ['#ff3333','#cccccc','#ffee00','#0099ff'];
  for(let di=0;di<4;di++) {
    ctx.fillStyle = dotCols[di];
    ctx.beginPath(); ctx.arc(px - 22 + di*15, py + 19, 5, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(0,0,0,0.5)'; ctx.lineWidth=1; ctx.stroke();
  }
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}

// ── HUD RENDERER ────────────────────────────────────────
function fmtTime(s) {
  if(s === null || s === undefined || !isFinite(s)) return '--:--.---';
  const m = Math.floor(s/60);
  const sec = s%60;
  return `${m}:${sec.toFixed(3).padStart(6,'0')}`;
}

function drawHUD(ctx, kart, track, x, y, w, h, player, mode) {
  const now = performance.now();
  const pad = 12;
  const narrow = w < 700;
  const totalLapsDisplay = kart.totalLaps || track.laps;
  // No pre-race pit strategy / HUD pit-wall callouts — pick tyres when you box.

  // === TOP LEFT: Lap info ===
  ctx.save();
  ctx.translate(x, y);
  // Launch/grid drawing often leaves textAlign=center; reset so lap/speed labels stay left-aligned.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const lapW = narrow ? 118 : 180;
  const lapH = narrow ? 78 : 100;
  const hudR = 12;
  ctx.beginPath();
  ctx.roundRect(pad, pad, lapW, lapH, hudR);
  ctx.fillStyle = 'rgba(50,42,90,0.82)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Player label
  const playerColors = ['#6ee7f7','#c37af0'];
  ctx.fillStyle = playerColors[player];
  ctx.font = 'bold 11px Nunito,sans-serif';
  ctx.fillText(`P${player+1}`, pad+8, pad+18);

  // Lap counter (Time Trial is open-ended — no lap total)
  // Qualifying push sessions keep driving after the target, so show push target as the goal.
  const qualiPushTarget = (kart._qualiKeepDriving && kart._qualiPushTarget) ? kart._qualiPushTarget : null;
  const currentLapNum = mode === 'trial'
    ? ((kart.lapStart !== null || kart.lap > 0) ? (kart.lap + 1) : 0)
    : (kart.finished ? totalLapsDisplay : Math.min(kart.lap + 1, qualiPushTarget || totalLapsDisplay));
  ctx.fillStyle = '#ffffff';
  ctx.font = narrow ? 'bold 11px Nunito,sans-serif' : 'bold 13px Nunito,sans-serif';
  ctx.fillText('LAP', pad+8, pad+(narrow ? 36 : 40));
  ctx.font = narrow ? 'bold 24px Nunito,sans-serif' : 'bold 32px Nunito,sans-serif';
  ctx.fillStyle = '#f5c518';
  let lapLabel;
  if(mode === 'trial') {
    lapLabel = currentLapNum > 0 ? String(currentLapNum) : '—';
  } else if(qualiPushTarget) {
    lapLabel = `${Math.min(kart.lap + (kart.lapStart !== null ? 1 : 0), Math.max(qualiPushTarget, kart.lap))}/${qualiPushTarget}`;
    if(kart._qualiPushDone) lapLabel = `${qualiPushTarget}/${qualiPushTarget}`;
  } else {
    lapLabel = `${currentLapNum}/${totalLapsDisplay}`;
  }
  ctx.fillText(lapLabel, pad+8, pad+(narrow ? 62 : 78));

  // === TOP RIGHT: Timers ===
  const timerW = narrow ? Math.min(168, Math.max(140, w - lapW - pad * 3 - 8)) : (mode === 'versus' ? 200 : 260);
  const timerX = w - timerW - pad;
  const timerH = mode === 'trial' ? 140 : (narrow ? 86 : 100);
  ctx.beginPath();
  ctx.roundRect(timerX, pad, timerW, timerH, hudR);
  ctx.fillStyle = 'rgba(50,42,90,0.82)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Current lap time
  let currentLapTime = null;
  if(kart.lapStart !== null && !kart.finished) {
    currentLapTime = (now - kart.lapStart) / 1000;
  }
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = narrow ? '9px Nunito,sans-serif' : '10px Nunito,sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(narrow ? 'LAP' : 'CURRENT LAP', timerX + timerW - 8, pad+16);
  ctx.fillStyle = '#ffffff';
  ctx.font = narrow ? 'bold 16px Nunito,sans-serif' : 'bold 22px Nunito,sans-serif';
  ctx.fillText(fmtTime(currentLapTime), timerX + timerW - 8, pad+(narrow ? 36 : 42));

  // Best lap
  ctx.fillStyle = 'rgba(245,197,24,0.8)';
  ctx.font = narrow ? '9px Nunito,sans-serif' : '10px Nunito,sans-serif';
  ctx.fillText('BEST', timerX + timerW - 8, pad+(narrow ? 52 : 60));
  ctx.fillStyle = kart.bestLap < Infinity ? '#f5c518' : 'rgba(255,255,255,0.4)';
  ctx.font = narrow ? 'bold 13px Nunito,sans-serif' : 'bold 16px Nunito,sans-serif';
  ctx.fillText(kart.bestLap < Infinity ? fmtTime(kart.bestLap) : '--:--.---', timerX + timerW - 8, pad+(narrow ? 70 : 80));

  if(mode === 'trial') {
    ctx.fillStyle = 'rgba(195,122,240,0.8)';
    ctx.font = '10px Nunito,sans-serif';
    ctx.fillText('TARGET', timerX + timerW - 8, pad+100);
    ctx.fillStyle = '#c37af0';
    ctx.font = 'bold 14px Nunito,sans-serif';
    ctx.fillText(fmtTime(track.targetLap), timerX + timerW - 8, pad+120);
    if(kart.bestLap < Infinity) {
      const diff = kart.bestLap - track.targetLap;
      ctx.fillStyle = diff < 0 ? '#4ade80' : '#f87171';
      ctx.font = 'bold 13px Nunito,sans-serif';
      ctx.fillText((diff < 0 ? '-' : '+') + fmtTime(Math.abs(diff)), timerX + timerW - 8, pad+140);
    }
  }

  ctx.textAlign = 'left';

  // Track name ribbon — only when there is a clear gap between lap + timer panels
  // Single-player: leave room on the right of the ribbon for the FPS badge.
  // During the race, also leave room on the left for the master elapsed timer.
  const showHudFps = mode !== 'versus';
  const fpsBadgeW = showHudFps ? 70 : 0;
  const fpsBadgeGap = showHudFps ? 8 : 0;
  const masterTimerReserve = (mode !== 'versus' && race &&
    (race.phase === 'racing' || race.phase === 'finished')) ? 140 : 0;
  const ribbonGapL = pad + lapW + 10 + masterTimerReserve;
  const ribbonGapR = timerX - 10;
  const ribbonAvail = ribbonGapR - ribbonGapL;
  if(ribbonAvail >= 120) {
    const ribbonW = Math.min(320, ribbonAvail - fpsBadgeW - fpsBadgeGap);
    // Bias left a touch so FPS sits beside the title without hitting the lap-timer panel.
    const clusterW = ribbonW + fpsBadgeW + fpsBadgeGap;
    const ribbonX = ribbonGapL + Math.max(0, (ribbonAvail - clusterW) / 2);
    ctx.beginPath();
    ctx.roundRect(ribbonX, pad, ribbonW, 28, 8);
    ctx.fillStyle = 'rgba(50,42,90,0.8)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Nunito,sans-serif';
    ctx.textAlign = 'center';
    const trackLabel = track.name || '';
    let drawName = trackLabel;
    while(drawName.length > 4 && ctx.measureText(drawName).width > ribbonW - 16) {
      drawName = drawName.slice(0, -1);
    }
    if(drawName !== trackLabel) drawName = drawName.slice(0, Math.max(1, drawName.length - 1)) + '…';
    ctx.fillText(drawName, ribbonX + ribbonW / 2, pad + 18);
    ctx.textAlign = 'left';

    if(showHudFps && ribbonW >= 80) {
      const fpsX = ribbonX + ribbonW + fpsBadgeGap;
      const fpsColor = _fpsDisplay >= 55 ? '#4ade80' : _fpsDisplay >= 30 ? '#ffd700' : '#f87171';
      ctx.beginPath();
      ctx.roundRect(fpsX, pad, fpsBadgeW, 28, 8);
      ctx.fillStyle = 'rgba(50,42,90,0.8)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = fpsColor;
      ctx.font = 'bold 11px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${_fpsDisplay} FPS`, fpsX + fpsBadgeW / 2, pad + 18);
      ctx.textAlign = 'left';
    }
  }

  // === BOTTOM-LEFT PANEL: Speed + Tyre wear + ERS ===
  const spd = Math.abs(kart.speed);
  const spdPct = spd / (kart.baseMaxSpeed || kart.maxSpeed);
  const barW = narrow ? Math.min(156, w - pad * 2) : 170;

  // Layout: stack from bottom upward — speed, tyre (wear + temp colour), ERS
  const spdBarY   = h - pad - 28;
  const tyreBarY  = spdBarY - 34;
  const ersBarY   = tyreBarY - 34;
  const statusY   = ersBarY - 28;
  const warnY     = statusY - 26;

  // ── Speed bar ──
  ctx.beginPath();
  ctx.roundRect(pad, spdBarY, barW, 28, 8);
  ctx.fillStyle = 'rgba(50,42,90,0.8)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth=2;
  ctx.stroke();
  const grad = ctx.createLinearGradient(pad+4, 0, pad+4+(barW-8)*Math.min(spdPct,1), 0);
  grad.addColorStop(0, '#6ee7f7');
  grad.addColorStop(0.6, '#f5c518');
  grad.addColorStop(1, '#c37af0');
  ctx.beginPath();
  ctx.roundRect(pad+4, spdBarY+4, (barW-8)*Math.min(spdPct,1), 20, 6);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px Nunito,sans-serif';
  const spdLabel = `${Math.round(spd * 0.8)} KM/H`;
  ctx.fillText(spdLabel, pad+8, spdBarY+18);
  if(!kart.finished && !kart.inPit && track && track.pitLane) {
    const _pitRef = track.pitLane.entryPt;
    const pitDist = Math.hypot(kart.x - _pitRef.x, kart.y - _pitRef.y);
    const pitHint = kart._onPitLane ? 'PIT' : (pitDist < 420 ? 'ENTRY' : 'PIT');
    ctx.font = '8px Nunito,sans-serif';
    const spdTw = ctx.measureText(spdLabel).width;
    const hintTw = ctx.measureText(pitHint).width;
    if(spdTw + hintTw + 24 < barW) {
      ctx.textAlign = 'right';
      ctx.fillStyle = kart._onPitLane || pitDist < 420 ? '#ff9500' : 'rgba(255,200,0,0.30)';
      ctx.fillText(pitHint, pad + barW - 4, spdBarY+18);
      ctx.textAlign = 'left';
    }
  }

  // ── Tyre bar (wear fill + temperature colour) ──
  const tyreDef    = TYRE_DEFS.find(t=>t.id===kart.tyreId) || TYRE_DEFS[1];
  const wearPct    = kart.tyreWear || 0;
  const lifeRemain = 1 - wearPct;
  const tempState  = kart.tyreTempState || getTyreTempState(kart.tyreTemp || 60, tyreDef);
  const tempColor  = (TYRE_TEMP_COLORS && TYRE_TEMP_COLORS[tempState]) || TYRE_TEMP_COLORS.optimal;
  const wearColor  = wearPct > 0.75 ? '#ff4444' : wearPct > 0.45 ? '#ffd700' : '#4ade80';
  ctx.beginPath();
  ctx.roundRect(pad, tyreBarY, barW, 28, 8);
  ctx.fillStyle = 'rgba(50,42,90,0.8)';
  ctx.fill();
  ctx.strokeStyle = tempColor;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  const wearFillW = Math.max(40, barW - 74);
  ctx.fillStyle = wearColor;
  ctx.globalAlpha = 0.72;
  ctx.fillRect(pad+4, tyreBarY+4, wearFillW * lifeRemain, 20);
  ctx.globalAlpha = 1;
  const blockW = 4, blockH = 8, blockGap = 2;
  const blocksX = pad + 4 + wearFillW + 4;
  const blocksY = tyreBarY + 6;
  for(let bi = 0; bi < 4; bi++) {
    ctx.fillStyle = tempColor;
    ctx.globalAlpha = 0.55 + (bi % 2) * 0.2;
    ctx.fillRect(blocksX + bi * (blockW + blockGap), blocksY + (bi < 2 ? 0 : 10), blockW, blockH);
  }
  ctx.globalAlpha = 1;
  const tyreLabelX = pad + barW - 4;
  ctx.textAlign = 'right';
  ctx.fillStyle = tyreDef.color;
  ctx.font = 'bold 9px Nunito,sans-serif';
  ctx.fillText((tyreDef.label || '').slice(0, narrow ? 3 : 6), tyreLabelX, tyreBarY+12);
  ctx.fillStyle = 'rgba(255,255,255,0.50)';
  ctx.font = '8px Nunito,sans-serif';
  ctx.fillText(`${Math.round(lifeRemain*100)}%`, tyreLabelX, tyreBarY+23);
  ctx.textAlign = 'left';

  // ── ERS charge bar ──
  const ersCharge = kart.ersCharge !== undefined ? kart.ersCharge : 1;
  const ersActive = !!kart.ersActive || (kart._ersPower > 0.08);
  const ersColor  = ersCharge < 0.2 ? '#ff4444' : ersCharge < 0.5 ? '#f5c518' : '#6ee7f7';
  ctx.beginPath();
  ctx.roundRect(pad, ersBarY, barW, 28, 8);
  ctx.fillStyle = 'rgba(50,42,90,0.8)';
  ctx.fill();
  ctx.strokeStyle = ersActive ? 'rgba(110,231,247,0.85)' : 'rgba(255,255,255,0.25)';
  ctx.lineWidth = ersActive ? 2.5 : 2;
  ctx.stroke();
  const ersFillW = Math.max(48, barW - 52);
  ctx.fillStyle = ersColor;
  ctx.globalAlpha = ersActive ? 0.95 : 0.72;
  ctx.fillRect(pad+4, ersBarY+4, ersFillW * Math.min(ersCharge, 1), 20);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'right';
  ctx.fillStyle = ersActive ? '#6ee7f7' : 'rgba(255,255,255,0.6)';
  ctx.font = `bold ${ersActive ? 10 : 9}px Nunito,sans-serif`;
  ctx.fillText(ersActive ? 'BOOST' : 'ERS', pad + barW - 4, ersBarY+11);
  ctx.fillStyle = ersActive ? '#6ee7f7' : 'rgba(255,255,255,0.55)';
  ctx.font = '9px Nunito,sans-serif';
  ctx.fillText(`${Math.round(ersCharge * 100)}%`, pad + barW - 4, ersBarY+22);
  ctx.textAlign = 'left';

  // ── Status badges row ──
  const badgeGap = 6;
  let badgeX = pad;
  const drawBadge = (label, bg, fg, bw) => {
    const width = Math.min(bw, w - badgeX - pad);
    if(width < 56) return;
    ctx.beginPath();
    ctx.roundRect(badgeX, statusY, width, 22, 6);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.font = 'bold 9px Nunito,sans-serif';
    ctx.fillText(label, badgeX + 6, statusY + 15);
    badgeX += width + badgeGap;
  };
  if(kart._onPitLane && !kart.inPit) {
    const pitPulse = 0.80 + 0.20 * Math.sin(performance.now() / 260);
    ctx.globalAlpha = pitPulse;
    drawBadge('PIT LIMIT', 'rgba(255,149,0,0.92)', '#000', 104);
    ctx.globalAlpha = 1;
  } else if(kart.isOffTrack && !kart.inPit) {
    drawBadge('OFF TRACK', 'rgba(255,50,50,0.88)', '#fff', 104);
  }
  if(kart.drsActive) {
    drawBadge('DRS OPEN', 'rgba(0,88,220,0.92)', '#aaddff', 108);
  } else if(kart.drsInZone && kart.drsAvailable) {
    const drsKey = player === 0 ? '[C]' : '[,]';
    drawBadge(`DRS ${drsKey}`, 'rgba(0,60,160,0.82)', 'rgba(120,180,255,0.9)', 108);
  } else if(kart.drsInZone && !kart.drsAvailable) {
    drawBadge('DRS LOCK', 'rgba(50,50,100,0.75)', 'rgba(120,140,200,0.7)', 108);
  } else if(kart.slipstreamBoost) {
    drawBadge('SLIPSTREAM', 'rgba(0,210,255,0.92)', '#000', 118);
  }

  // ── Tyre failure flashing warning ──
  if(kart.tyreWear >= 1.0) {
    const tyreFlash = Math.floor(performance.now() / 330) % 2 === 0;
    if(tyreFlash) {
      const failW = Math.min(344, w - pad * 2);
      const failX = (w - failW) / 2;
      ctx.beginPath();
      ctx.roundRect(failX, h/2 - 124, failW, 32, 10);
      ctx.fillStyle = 'rgba(200,0,0,0.92)';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = narrow ? 'bold 11px Nunito,sans-serif' : 'bold 14px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(narrow ? 'TYRE FAILURE' : 'TYRE FAILURE — 100 KM/H LIMIT', w/2, h/2 - 103);
      ctx.textAlign = 'left';
    }
  }

  // ── Wrong-weather / pit-call warnings (stack when narrow) ──
  let warnRow = 0;
  const warnMaxW = Math.min(220, w - pad * 2);
  if(kart.tyreWrongWeather) {
    const wy = warnY - warnRow * 26;
    ctx.beginPath();
    ctx.roundRect(pad, wy, warnMaxW, 22, 6);
    ctx.fillStyle = 'rgba(220,20,20,0.92)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px Nunito,sans-serif';
    ctx.fillText(narrow ? 'WRONG TYRES' : 'WRONG TYRES — EXTREMELY SLOW', pad+5, wy+15);
    warnRow++;
  }

  // Canvas pit selector is unused — HTML #pit-ui-overlay handles tyre picks (one-sided in versus).

  // ── PIT CHANGING OVERLAY ──
  if(kart.pitPhase === 'changing') {
    const progress = Math.min(1, kart.pitTimer / 3.0);
    const ow = Math.min(240, w - pad * 2), oh = 80;
    const ox = w/2 - ow/2, oy = h/2 - oh/2;
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.fillRect(ox, oy, ow, oh);
    ctx.strokeStyle = '#00f5ff'; ctx.lineWidth=2;
    ctx.strokeRect(ox, oy, ow, oh);
    const newTyre = TYRE_DEFS.find(t=>t.id===kart.pitTyreChoice) || TYRE_DEFS[1];
    ctx.fillStyle = '#00f5ff';
    ctx.font = narrow ? 'bold 10px Nunito,sans-serif' : 'bold 12px Nunito,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(narrow ? `${newTyre.label}` : `FITTING ${newTyre.label} TYRES...`, w/2, oy+22);
    // Progress bar
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(ox+12, oy+34, ow-24, 14);
    ctx.fillStyle = newTyre.color;
    ctx.fillRect(ox+12, oy+34, (ow-24)*progress, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '9px Nunito,sans-serif';
    ctx.fillText(`${Math.round((1-progress)*3)} SEC`, w/2, oy+60);
    ctx.textAlign = 'left';
  }

  // FINISHED banner
  if(kart.finished) {
    const t = (now % 1000) / 1000;
    ctx.globalAlpha = 0.85 + Math.sin(t * Math.PI * 2) * 0.15;
    ctx.fillStyle = '#ffd700';
    ctx.font = narrow ? 'bold 24px Nunito,sans-serif' : 'bold 36px Nunito,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('FINISHED!', w/2, h/2 - 10);
    ctx.font = narrow ? '12px Nunito,sans-serif' : '14px Nunito,sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(`TOTAL: ${fmtTime(kart.finishTime)}`, w/2, h/2+22);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }

  // Flash message (e.g. BEST LAP!)
  if(kart.flashTimer > 0 && kart.rankFlash) {
    const ft = kart.flashTimer / 1.5;
    ctx.globalAlpha = Math.min(1, ft * 3);
    ctx.fillStyle = '#ffd700';
    ctx.font = narrow ? 'bold 18px Nunito,sans-serif' : 'bold 28px Nunito,sans-serif';
    ctx.textAlign = 'center';
    const yOff = ft > 0.5 ? 0 : (0.5-ft)*80;
    ctx.fillText(kart.rankFlash, w/2, h/2 - 60 - yOff);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }

  // "Too far from pit" flash banner
  if(kart._pitTooFarTimer > 0) {
    const ft2 = Math.min(1, kart._pitTooFarTimer / 2.5);
    ctx.globalAlpha = Math.min(1, ft2 * 3);
    ctx.fillStyle = '#ff3333';
    ctx.font = narrow ? 'bold 12px Nunito,sans-serif' : 'bold 20px Nunito,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(narrow ? 'NOT AT PIT ENTRY' : 'NOT AT PIT ENTRY — COMPLETE THE LAP TO REACH PIT LANE', w/2, h/2 - 92);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }

  // Pit zone proximity indicator — show when near pit entry OR on pit lane
  if(!kart.finished && !kart.inPit && track && track.pitLane) {
    const pl = track.pitLane;
    const entryDist = Math.hypot(kart.x - pl.entryPt.x, kart.y - pl.entryPt.y);
    const garageDist = pl.garagePos ? Math.hypot(kart.x - pl.garagePos.x, kart.y - pl.garagePos.y) : 9999;
    if(entryDist < 420) {
      const pulse = 0.72 + 0.28 * Math.sin(performance.now() / 220);
      const banW = Math.min(296, w - pad * 2);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#ff9500';
      ctx.fillRect(w/2 - banW/2, h - 56, banW, 24);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 10px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(narrow ? 'PIT ENTRY — DRIVE IN' : 'PIT ENTRY AHEAD — DRIVE IN', w/2, h - 40);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    } else if(kart._onPitLane && garageDist < 400) {
      const pulse2 = 0.80 + 0.20 * Math.sin(performance.now() / 180);
      const banW = Math.min(280, w - pad * 2);
      ctx.globalAlpha = pulse2;
      ctx.fillStyle = '#ff9500';
      ctx.fillRect(w/2 - banW/2, h - 56, banW, 24);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 10px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(narrow ? 'DRIVE TO GARAGE' : 'DRIVE TO GARAGE — AUTO STOP', w/2, h - 40);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
  }

  // ── OFF-TRACK PENALTY WARNING ─────────────────────────
  if (!kart.isAI && kart._isCompletelyOff && kart._penaltyTimer > 0) {
    const remaining = Math.max(0, 3.0 - kart._penaltyTimer);
    const urgency   = Math.min(1, kart._penaltyTimer / 0.8); // ramps to full in 0.8s
    const pulse     = 0.80 + 0.20 * Math.sin(performance.now() / Math.max(60, 200 - urgency * 140));
    const boxW = Math.min(460, w - pad * 2);
    const boxX = (w - boxW) / 2;
    ctx.globalAlpha = Math.min(1, 0.4 + urgency * 0.6) * pulse;
    // Background bar — reddens as time runs out
    ctx.fillStyle = remaining < 1.0 ? '#cc0000' : '#dd4400';
    ctx.fillRect(boxX, h / 2 - 124, boxW, 54);
    // Border flash when critical
    if (remaining < 1.0) {
      ctx.strokeStyle = '#ff2222';
      ctx.lineWidth = 2;
      ctx.strokeRect(boxX, h / 2 - 124, boxW, 54);
    }
    // Countdown text
    ctx.fillStyle = '#ffffff';
    ctx.font = narrow ? 'bold 11px Nunito,sans-serif' : 'bold 15px Nunito,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const offMsg = remaining > 0
      ? (narrow ? `OFF TRACK  ${remaining.toFixed(1)}s` : `OFF TRACK — RETURN TO TRACK  ${remaining.toFixed(1)}s`)
      : '  RESETTING…';
    ctx.fillText(offMsg, w / 2, h / 2 - 97);
    // Speed penalty note
    if (remaining > 0) {
      ctx.fillStyle = 'rgba(255,200,100,0.9)';
      ctx.font = '10px Nunito,sans-serif';
      ctx.fillText(narrow ? 'SPEED PENALTY' : 'SPEED PENALTY ACTIVE', w / 2, h / 2 - 79);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
// ── AI ORIENTATION GUARD ────────────────────────────────────────────────────
// Runs every frame for every AI kart after physics. Prevents the car from ever
// driving backward and corrects any wrong-facing angle before it can cascade.
function fixAIKartOrientation(k, td) {
  // Never snap heading while on a pit route — that is what caused AI to cut the track.
  if (k.finished || k.inPit || k.pitPhase !== null) return;
  if (k._pitIntentActive || k._pitEntryConfirmed || k._pitExiting || k._pitExitPos || k._onPitLane) return;

  // Hard floor: AI speed must never go negative
  if (k.speed < 0) k.speed = 0;

  // Angle sanity: if the car is pointing more than ~120° away from the
  // forward spline direction, snap to the correct heading and zero speed
  // so the AI controller can drive away cleanly on the next frame.
  const spl = td.spline;
  const ni  = k._nearestSplineIdx || 0;
  const tang = splineTangent(spl, ni);
  const trackAngle = Math.atan2(tang.y, tang.x);
  let diff = trackAngle - k.angle;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) > Math.PI * 0.72) {
    k.angle = trackAngle;
    k.speed  = Math.max(48, k.speed * 0.55);
  }
}

// ── ML POLICY AI ────────────────────────────────────────
let _mlPolicyCache = null;
let _mlPolicyLoadPromise = null;

function loadMLPolicy(path) {
  path = path || 'sim/rl/policy.json';
  if (_mlPolicyLoadPromise) return _mlPolicyLoadPromise;
  _mlPolicyLoadPromise = fetch(path)
    .then(r => { if(!r.ok) throw new Error('policy not found'); return r.json(); })
    .then(j => { _mlPolicyCache = j; return j; })
    .catch(e => { console.warn('ML policy load failed:', e); _mlPolicyCache = null; return null; });
  return _mlPolicyLoadPromise;
}

function makeMLInput(track, policyPath) {
  const curv = window.KartBlitzML ? window.KartBlitzML.precomputeCurvature(track) : null;
  let kartRef = null;
  loadMLPolicy(policyPath);
  return {
    set(k) { kartRef = k; },
    fn() {
      if (!kartRef || !window.KartBlitzML || !_mlPolicyCache) {
        return { up: true, down: false, left: false, right: false, brakeMult: 1 };
      }
      const obs = window.KartBlitzML.observe(kartRef, track, curv);
      const act = window.KartBlitzML.policyForward(_mlPolicyCache, obs);
      return window.KartBlitzML.actionToInput(act);
    },
  };
}

function makeAIInput(track, difficulty, aiIndex, opts) {
  aiIndex = aiIndex || 0; // 0, 1, 2 for the three AI cars
  opts = opts || {};

  // AI behaviour tuning. sf = overall speed fraction, curvK = braking aggression, brDist = lookahead
  // Ultra Easy/Easy/Medium are deliberately slow and cautious
  const sfBase  = {ultraeasy: 0.46, easy: 0.58, medium: 0.72, hard: 0.84, extreme: 0.94}[difficulty] || 0.72;
  const sf      = sfBase * 1.18;
  // Lower curvK a bit (more corner braking). Shorter brDist still avoids early panic.
  const curvK   = {ultraeasy: 0.165, easy: 0.132, medium: 0.092, hard: 0.028, extreme: 0.012}[difficulty] || 0.100;
  const brBase  = {ultraeasy: 840, easy: 700, medium: 580, hard: 480, extreme: 300}[difficulty] || 580;
  const brDist  = brBase * (track.aiBrakeLookaheadScale || 1);
  
  // ── AI PIT STRATEGY ────────────────────────────────────
  // AI will choose pit strategy based on race length and difficulty
  // Longer races = more strategic pit planning
  let _lastPitLap = -999;   // Track which lap AI last pitted
  let _pitStrategy = 'single'; // single-stop or two-stop for longer races
  let _lastSeenLap = 0;     // Detect completed push laps
  let _pitAfterPushLap = false; // Queue pit after a completed push lap in qualifying

  // ── AI MISTAKES SYSTEM ─────────────────────────────────
  // AI occasionally makes realistic mistakes (take corners too wide, brake early, etc.)
  // Harder difficulties = fewer mistakes. Cost: 0.5-1.5s per mistake.
  let _mistakeTimer = 0;        // countdown to next possible mistake
  let _mistakeActive = false;   // currently in mistake sequence
  let _mistakeDuration = 0;     // how long mistake lasts
  let _mistakeType = '';        // 'wide-corner' | 'early-brake' | 'late-accel'
  const mistakeRates = {
    ultraeasy: 0.12,  // 12% chance per 3-second opportunity
    easy: 0.08,       // 8% chance
    medium: 0.05,     // 5% chance
    hard: 0.02,       // 2% chance (skilled drivers)
    extreme: 0.01     // 1% chance (expert drivers)
  };
  const mistakeChance = mistakeRates[difficulty] || 0.05;

  // per car variations, just braking agressivness and lookahead dist
  const carVariations = [
    { speedMul: 0.99, brakeBias: 1.04, lookDist: 255 },
    { speedMul: 1.00, brakeBias: 1.00, lookDist: 235 },
    { speedMul: 1.01, brakeBias: 0.96, lookDist: 285 },
  ];
  const v = carVariations[aiIndex % 3];
  const aiPersonalities = [
    { name:'smooth', aggression:0.84, exitAttack:0.92, lanePatience:1.18, ersBias:1.08 },
    { name:'opportunist', aggression:1.06, exitAttack:1.20, lanePatience:0.92, ersBias:0.94 },
    { name:'defender', aggression:0.92, exitAttack:0.84, lanePatience:1.30, ersBias:1.12 },
    { name:'showboat', aggression:1.14, exitAttack:1.28, lanePatience:0.88, ersBias:0.86 },
  ];
  const _personality = aiPersonalities[aiIndex % aiPersonalities.length];
  const cruiseLanePattern = [-1.12, -0.72, -0.28, 0.28, 0.72, 1.12, -0.90, -0.46, 0.46, 0.90];
  const _cruiseLaneBias = cruiseLanePattern[aiIndex % cruiseLanePattern.length];
  const _pitStrategyId = getAiPitStrategyId(aiIndex, difficulty, 3);
  // Global AI pace. Shootout gets an extra scale so a strong player lap (~56s Neon)
  // faces an AI around ~54s instead of alien ~49s.
  const AI_SPEED_MULT = 1.5; // 1.00 = baseline, 1.25 = +25%
  const shootoutPace = opts.mode === 'shootout'
    ? ({ ultraeasy: 0.82, easy: 0.86, medium: 0.91, hard: 0.93, extreme: 0.95 }[difficulty] || 0.91)
    : 1;
  const effectiveSF    = sf * v.speedMul * AI_SPEED_MULT * shootoutPace;
  const effectiveCurvK = curvK * v.brakeBias * (opts.mode === 'shootout' ? 1.12 : 1);

  const spl = track.spline;
  const cum = track.cum;
  const n = spl.length;
  const totalLen = track.totalLen;

  // returns spline idx `dist` units ahead, wraps at lap end
  function idxAhead(startIdx, dist) {
    let target = cum[startIdx] + dist;
    if (target >= totalLen) target -= totalLen; // lap wrap
    const lo0 = target < cum[startIdx] ? 0 : startIdx;
    let lo = lo0, hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid; else hi = mid;
    }
    return lo;
  }

  // precompute curvature, +-5 index gap works good for tight corners
  const curvature = new Float32Array(n);
  const signedCurvature = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = spl[(i - 5 + n) % n], c = spl[i], nx = spl[(i + 5) % n];
    const dx1 = c.x - p.x,  dy1 = c.y - p.y;
    const dx2 = nx.x - c.x, dy2 = nx.y - c.y;
    const l1 = Math.hypot(dx1, dy1) || 1, l2 = Math.hypot(dx2, dy2) || 1;
    const cr = (dx1/l1)*(dy2/l2) - (dy1/l1)*(dx2/l2);
    signedCurvature[i] = cr;
    curvature[i] = Math.abs(cr);
  }

  let kart = null;
  let _stuckTimer = 0, _stuckX = 0, _stuckY = 0;
  let _laneBias = (aiIndex % 2 === 0) ? -1 : 1;
  let _laneHoldTimer = 0;
  let _passCommitTimer = 0;
  let _steerFilter = 0;
  let _trainTimer = 0;
  let _targetSpeedSmooth = null;

  const fn = function() {
    if (!kart) return { up:false, down:false, left:false, right:false, ers:false, drs:false };
    const k = kart;
    const nearIdx = k._nearestSplineIdx || 0;
    if(k._contactLineTimer > 0) k._contactLineTimer = Math.max(0, k._contactLineTimer - 0.016);
    else k._contactLineSign = 0;
    _laneHoldTimer = Math.max(0, _laneHoldTimer - 0.016);
    _passCommitTimer = Math.max(0, _passCommitTimer - 0.016);
    _trainTimer = Math.max(0, _trainTimer - 0.010);

    // stuck check
    const moved = Math.hypot(k.x - _stuckX, k.y - _stuckY);
    if (moved < 6) { _stuckTimer += 0.016; }
    else           { _stuckTimer = 0; _stuckX = k.x; _stuckY = k.y; }
    const isStuck = _stuckTimer > 0.85;

    // off track or stuck, steer back to nearest point on track
    if (k.isOffTrack || isStuck) {
      // find nearest spline point thats ahead of us
      let bestIdx = nearIdx, bestScore = Infinity;
      for (let d = -8; d < 80; d++) {
        const idx = ((nearIdx + d) % n + n) % n;
        const dx = spl[idx].x - k.x, dy = spl[idx].y - k.y;
        const dist = Math.hypot(dx, dy);
        const dot  = Math.cos(k.angle)*dx + Math.sin(k.angle)*dy;
        const score = dist + (dot > 0 ? 0 : dist * 0.5) + (d < 0 ? 40 : 0);
        if (score < bestScore) { bestScore = score; bestIdx = idx; }
      }
      const dx = spl[bestIdx].x - k.x, dy = spl[bestIdx].y - k.y;
      let diff = Math.atan2(dy, dx) - k.angle;
      while (diff >  Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // Only allow reverse as an off-track recovery to avoid hairpins causing back-driving.
      const rev = k.isOffTrack && isStuck && Math.abs(k.speed) < 38 && Math.abs(diff) > Math.PI * 0.72;
      return {
        up:    !rev && Math.abs(diff) < Math.PI * 0.5,
        down:  rev  || (k.speed > 80 && Math.abs(diff) > 0.8),
        left:  rev  ? diff > 0.05 : diff < -0.05,
        right: rev  ? diff < -0.05 : diff > 0.05,
        brakeMult: 1.35,
        ers: false, drs: false
      };
    }

    // ── CURVATURE SCAN (braking look-ahead) ────────────
    // Scan `brDist` world-units ahead and record the worst curvature found.
    const brakeEndIdx = idxAhead(nearIdx, brDist);
    let maxCurv = 0;
    let maxCurvIdx = nearIdx;
    let maxCurvSigned = 0;
    let maxBrakeTag = 0;
    let scanCount = 0;
    const brakePlan = track.brakePlan;
    for (let idx = nearIdx; idx !== brakeEndIdx && scanCount < 180; idx = (idx + 1) % n, scanCount++) {
      if (curvature[idx] > maxCurv) {
        maxCurv = curvature[idx];
        maxCurvIdx = idx;
        maxCurvSigned = signedCurvature[idx];
      }
      if (brakePlan && brakePlan[idx] > maxBrakeTag) maxBrakeTag = brakePlan[idx];
    }

    // ── SPEED TARGET ───────────────────────────────────
    // Geometry + brake plan + racing-line adherence.
    const halfW = track.trackWidth * 0.5;
    const tangNear = splineTangent(spl, nearIdx);
    const perpX0 = -tangNear.y, perpY0 = tangNear.x;
    const lateralErr = (k.x - spl[nearIdx].x) * perpX0 + (k.y - spl[nearIdx].y) * perpY0;

    // Carry more mid-corner when an authored racing line + brake plan exist.
    const curvFloor = {ultraeasy: 0.64, easy: 0.72, medium: 0.82, hard: 0.90, extreme: 0.95}[difficulty] || 0.80;
    const curvGain = track.hasBrakePlan ? 5.2 : 7.6; // brake tags own slowing; geometry is a softer backup
    let curvFactor  = Math.max(curvFloor, 1.0 - maxCurv * effectiveCurvK * curvGain);

    // How well we are already on the authored racing line (0..1).
    let onLineScore = 0;
    if(track.racingLineOffset && track.racingLineOffset.length === n) {
      const lineNear = track.racingLineOffset[nearIdx] || 0;
      const lineErr = Math.abs(lateralErr - lineNear);
      onLineScore = Math.max(0, 1 - lineErr / Math.max(18, halfW * 0.42));
    }

    // Authored brake plan (0 none … 5 max) is the main corner-speed authority.
    // Higher factors = faster through corners; only hard tags really dump speed.
    if (track.hasBrakePlan) {
      if (maxBrakeTag >= 0.5) {
        // 1→~0.96  2→~0.90  3→~0.80  4→~0.62  5→~0.42
        const t = Math.max(0, Math.min(1, (Math.min(5, maxBrakeTag) - 1) / 4));
        let planFactor = 0.96 - t * 0.54;
        // On the racing line, commit later / carry more (especially tags 1–3).
        if (onLineScore > 0.35 && maxBrakeTag < 4.2) {
          planFactor = Math.min(1.0, planFactor + 0.04 + onLineScore * 0.06);
        }
        // Prefer plan over harsh curvature; only pull down slightly if geometry is extreme.
        curvFactor = Math.min(Math.max(curvFactor, planFactor * 0.92), planFactor);
      } else {
        // No-brake zone: full send; racing line lets them keep even more.
        curvFactor = Math.max(curvFactor, 0.94 + onLineScore * 0.04);
      }
    } else if (onLineScore > 0.4) {
      // Racing line only: small corner-carry bump vs pure curvature.
      curvFactor = Math.min(1.0, curvFactor + 0.04 + onLineScore * 0.05);
    }
    let targetSpeed = k.maxSpeed * effectiveSF * curvFactor;
    // Extra apex/exit carry when locked to the line and not in a hard brake zone.
    if (onLineScore > 0.45 && maxBrakeTag < 3.5) {
      targetSpeed *= 1.0 + onLineScore * (maxBrakeTag < 1 ? 0.06 : 0.035);
    }

    // ── PURE-PURSUIT TARGET POINT ──────────────────────
    const speedRatio = Math.abs(k.speed) / (k.maxSpeed || 469);
    const lookDist   = v.lookDist * (1 + speedRatio * 1.5);
    const tgtIdx     = idxAhead(nearIdx, lookDist);

    // Low-speed racing line: outside on approach, inside near apex, then unwind.
    const laneSpreadScale = track.aiLaneSpreadScale || 1;
    const cornerSeverity = Math.min(1, Math.max(0, (maxCurv - 0.07) / 0.22));
    // Allow racing closer to kerbs — smaller buffer = more usable track width.
    const edgeBuffer = Math.max(6, halfW * 0.04);
    const clampLaneOffset = (value) => Math.max(-(halfW - edgeBuffer), Math.min(halfW - edgeBuffer, value));
    // Give each AI car a stable preferred lane so they do not collapse into one centerline train.
    const cruiseLaneOffset = clampLaneOffset(_cruiseLaneBias * Math.min(Math.max(48, halfW * 0.48 * laneSpreadScale), Math.max(48, halfW - 10)));
    let lateralOffset = 0;
    let approachFrac = 1;
    if(cornerSeverity > 0.12) {
      const turnSign = Math.sign(maxCurvSigned) || 1;
      let distToApex = cum[maxCurvIdx] - cum[nearIdx];
      if(distToApex < 0) distToApex += totalLen;
      approachFrac = Math.max(0, Math.min(1, distToApex / Math.max(60, brDist)));
      const usable = Math.max(14, halfW - 8);
      const outsideAmt = usable * (0.38 + 0.16 * speedRatio);
      // Deeper apex (near red/white kerb) lets them carry more corner speed.
      const insideAmt  = usable * (0.40 + 0.42 * cornerSeverity);
      if(approachFrac > 0.55) lateralOffset = -turnSign * outsideAmt;
      else if(approachFrac > 0.18) lateralOffset = turnSign * insideAmt;
      else lateralOffset = turnSign * insideAmt * 0.42;
    }
    const cruiseBlend = cornerSeverity > 0.12 ? 0.46 : 0.92;
    lateralOffset = clampLaneOffset(lateralOffset + cruiseLaneOffset * cruiseBlend);

    // Optional authored racing line: 95% human line, 5% procedural lane offsets.
    if(track.racingLineOffset && track.racingLineOffset.length === n) {
      const authored = track.racingLineOffset[tgtIdx] != null
        ? track.racingLineOffset[tgtIdx]
        : (track.racingLineOffset[nearIdx] || 0);
      const prefer = 0.95;
      lateralOffset = clampLaneOffset(lateralOffset * (1 - prefer) + authored * prefer);
    }

    const laneShift = Math.min(Math.max(64, halfW * 0.64 * laneSpreadScale), Math.max(64, halfW - 8));

    const contactLineActive = (k._contactLineTimer || 0) > 0.02;
    if(contactLineActive) {
      const contactSign = Math.sign(k._contactLineSign || _laneBias || 1) || 1;
      const contactStrength = Math.min(1, (k._contactLineTimer || 0) / 0.58);
      const forcedLane = clampLaneOffset(contactSign * Math.min(Math.max(72, halfW * 0.66 * laneSpreadScale), Math.max(72, halfW - 6)));
      const blend = 0.68 + contactStrength * 0.26;
      lateralOffset = clampLaneOffset(lateralOffset * (1 - blend) + forcedLane * blend);
      _laneBias = contactSign;
      _laneHoldTimer = Math.max(_laneHoldTimer, 0.42 + contactStrength * 0.50);
    }

    // Traffic scan: detect slower or clustered karts ahead and choose alternate lane.
    let trafficAhead = false;
    let nearestTrafficArc = Infinity;
    let laneVotes = 0;
    let blockingCarArc = Infinity;
    let blockingCarSpeed = Infinity;
    const allKarts = (typeof race !== 'undefined' && race && race.karts) ? race.karts : null;
    const candidateOffsets = [
      clampLaneOffset(lateralOffset - laneShift),
      clampLaneOffset(lateralOffset),
      clampLaneOffset(lateralOffset + laneShift)
    ];
    const candidateScores = candidateOffsets.map((offset, idx) => {
      let score = -Math.abs(offset - lateralOffset) * 0.10;
      if(idx === 1) score += 6 + _personality.lanePatience * 2.0;
      else score += 2.5 + _personality.aggression * 3.0;
      const edgeRatio = Math.abs(offset) / Math.max(1, halfW - edgeBuffer);
      // Mild kerb-lane penalty only — AI may use outer/inner kerbs when racing.
      if(edgeRatio > 0.94) score -= (edgeRatio - 0.94) * 70;
      return score;
    });
    if(allKarts) {
      const laneTolerance = Math.max(24, halfW * 0.18);
      const laneClearance = Math.max(34, halfW * 0.22);
      const trafficLookArc = Math.max(170, lookDist * 1.1);
      const trafficLookDist = Math.max(140, lookDist);
      for(const other of allKarts) {
        if(other === k || other.finished || other._shootoutStowed) continue;
        if(other.inPit || other.pitPhase !== null) continue;
        const directDist = Math.hypot(other.x - k.x, other.y - k.y);
        if(directDist > trafficLookDist) continue;
        const otherIdx = other._nearestSplineIdx || 0;
        let arcAhead = cum[otherIdx] - cum[nearIdx];
        if(arcAhead < 0) arcAhead += totalLen;
        if(arcAhead < 8 || arcAhead > trafficLookArc) continue;

        const otherTang = splineTangent(spl, otherIdx);
        const otherPerpX = -otherTang.y, otherPerpY = otherTang.x;
        const otherLat = (other.x - spl[otherIdx].x) * otherPerpX + (other.y - spl[otherIdx].y) * otherPerpY;
        const trafficWeight = Math.max(0, trafficLookArc - arcAhead);
        const speedDelta = Math.max(0, k.speed - other.speed);
        for(let ci = 0; ci < candidateOffsets.length; ci++) {
          const latGap = Math.abs(otherLat - candidateOffsets[ci]);
          if(latGap < laneClearance) {
            const gapFactor = 1 - latGap / laneClearance;
            candidateScores[ci] -= trafficWeight * (0.34 + gapFactor * 0.48) + speedDelta * 0.08;
          }
        }
        if(Math.abs(otherLat - lateralErr) > laneTolerance) continue;

        trafficAhead = true;
        nearestTrafficArc = Math.min(nearestTrafficArc, arcAhead);
        laneVotes += (otherLat >= lateralErr) ? -1 : 1;
        if(speedDelta < 14 && arcAhead < Math.max(128, lookDist * 0.72)) {
          _trainTimer = Math.min(3.2, _trainTimer + 0.016 * (1.0 + _personality.aggression * 0.45));
        }
        if(k.speed > other.speed + 8 && arcAhead < Math.max(95, lookDist * 0.82) && arcAhead < blockingCarArc) {
          blockingCarArc = arcAhead;
          blockingCarSpeed = Math.abs(other.speed);
        }
      }
    }

    if(!trafficAhead) _trainTimer = Math.max(0, _trainTimer - 0.06);
    if(_trainTimer > 1.35) {
      const trainBoost = 7 + (_trainTimer - 1.35) * 10;
      candidateScores[1] -= trainBoost * 1.2;
      candidateScores[0] += trainBoost * (0.82 + _personality.aggression * 0.18);
      candidateScores[2] += trainBoost * (0.82 + _personality.aggression * 0.18);
    }

    const bestLaneIdx = candidateScores[0] > candidateScores[2]
      ? (candidateScores[0] > candidateScores[1] ? 0 : 1)
      : (candidateScores[2] > candidateScores[1] ? 2 : 1);
    const centerLaneScore = candidateScores[1];
    const bestLaneScore = candidateScores[bestLaneIdx];
    const bestLaneBias = bestLaneIdx === 0 ? -1 : bestLaneIdx === 2 ? 1 : 0;
    const highSpeedBend = cornerSeverity > 0.14 && cornerSeverity < 0.42 && approachFrac > 0.34 && speedRatio > 0.76;
    const cornerExitWindow = cornerSeverity > 0.18 && approachFrac < 0.24 && speedRatio > 0.46;
    const passMargin = Math.max(8, 16 + (highSpeedBend ? 8 : 0) - (cornerExitWindow ? 4 * _personality.exitAttack : 0) - Math.min(6, _trainTimer * 2.4));
    const canCommitPass = bestLaneBias !== 0 && bestLaneScore > centerLaneScore + passMargin;

    if(blockingCarArc < Infinity && canCommitPass) {
      _laneBias = bestLaneBias;
      _laneHoldTimer = Math.max(_laneHoldTimer, (1.05 + cornerSeverity * 0.46) * _personality.lanePatience);
      _passCommitTimer = Math.max(_passCommitTimer, 0.95 + Math.min(0.70, blockingCarArc / 220) + (cornerExitWindow ? 0.24 * _personality.exitAttack : 0));
    } else if(trafficAhead && _trainTimer > 1.9 && bestLaneBias !== 0) {
      _laneBias = bestLaneBias;
      _laneHoldTimer = Math.max(_laneHoldTimer, 1.20 * _personality.lanePatience);
      _passCommitTimer = Math.max(_passCommitTimer, 1.10 + _personality.aggression * 0.12);
    } else if(trafficAhead && _laneHoldTimer <= 0) {
      _laneBias = laneVotes === 0 ? (bestLaneBias || -_laneBias) : Math.sign(laneVotes);
      _laneHoldTimer = (0.88 + cornerSeverity * 0.42) * _personality.lanePatience;
    }

    if(trafficAhead || _laneHoldTimer > 0 || _passCommitTimer > 0) {
      lateralOffset = clampLaneOffset(lateralOffset + _laneBias * laneShift * Math.min(1.18, 0.92 + _personality.aggression * 0.20));
      if((trafficAhead || _passCommitTimer > 0) && nearestTrafficArc < 110 && Math.abs(k.speed) > 80) {
        lateralOffset = clampLaneOffset(lateralOffset + _laneBias * Math.min(26, halfW * 0.18 * laneSpreadScale));
      }
    }
    lateralOffset = clampLaneOffset(lateralOffset);

    const tang = splineTangent(spl, tgtIdx);
    const normX = -tang.y, normY = tang.x;
    const targetX = spl[tgtIdx].x + normX * lateralOffset;
    const targetY = spl[tgtIdx].y + normY * lateralOffset;

    // ── STEERING ───────────────────────────────────────
    let diff = Math.atan2(targetY - k.y, targetX - k.x) - k.angle;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    // Lateral correction: light pull toward centre — allow riding kerbs mid-corner.
    let latCorr = (lateralErr / Math.max(1, halfW)) * 0.34;
    if(Math.abs(lateralErr) > halfW * 0.90) latCorr *= 1.18;
    diff -= latCorr;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    const steerThresh = Math.max(0.02, 0.035 - maxCurv * 0.2);

    // ── THROTTLE / BRAKE ───────────────────────────────
    // Overshoot-aware braking: if heading/lateral error indicates corner miss, brake harder.
    const overSpeed = Math.max(0, k.speed - targetSpeed);
    const headingErr = Math.abs(diff);
    const lateralNorm = Math.min(2.0, Math.abs(lateralErr) / (track.trackWidth / 2));
    const overshootRisk =
      Math.max(0, (headingErr - 0.58) / 1.15) * 0.48 +
      Math.max(0, lateralNorm - 0.82) * 0.42 +
      Math.min(1, overSpeed / 140) * 0.62 +
      cornerSeverity * 0.26;

    // Edge safety: only panic when truly leaving asphalt — kerb proximity is OK.
    const projDist = 48 + Math.abs(k.speed) * 0.34;
    const projX = k.x + Math.cos(k.angle) * projDist;
    const projY = k.y + Math.sin(k.angle) * projDist;
    const projIdx = idxAhead(nearIdx, projDist);
    const projErr = Math.hypot(projX - spl[projIdx].x, projY - spl[projIdx].y);
    const strictHalf = Math.max(halfW * 1.06, halfW + 22);
    const projectedOffTrack = projErr > strictHalf;
    const edgeNorm = Math.abs(lateralErr) / Math.max(1, halfW);
    // Soft edge penalty: only kick in very near the limit, and never cut more than ~10%.
    const edgePenalty = Math.max(0.94, 1.0 - Math.max(0, edgeNorm - 0.90) * 0.28);
    let safeTargetSpeed = targetSpeed * edgePenalty;
    // Higher corner momentum floor — keep more pace mid-corner.
    const momentumFloor = k.maxSpeed * (0.44 + cornerSeverity * 0.16 + onLineScore * 0.08);
    safeTargetSpeed = Math.max(safeTargetSpeed, momentumFloor);
    if(trafficAhead && nearestTrafficArc < 120 && !projectedOffTrack && edgeNorm < 0.94) {
      safeTargetSpeed *= highSpeedBend ? 1.02 : (cornerExitWindow ? (1.10 + (_personality.exitAttack - 1) * 0.05) : 1.06);
    }
    if(blockingCarArc < Infinity && _passCommitTimer <= 0 && nearestTrafficArc < 125) {
      const followBuffer = Math.max(6, Math.min(20, blockingCarArc * (0.08 + _personality.lanePatience * 0.015)));
      safeTargetSpeed = Math.min(safeTargetSpeed, Math.max(momentumFloor, blockingCarSpeed + followBuffer));
    }

    // Smooth target speed — keep more pace into mild corners / brake 0–2 zones.
    if(_targetSpeedSmooth === null) _targetSpeedSmooth = Math.max(k.speed, safeTargetSpeed);
    const softCorner = cornerSeverity < 0.40 || (track.hasBrakePlan && maxBrakeTag < 2.5);
    const dropBlend = softCorner ? 0.06 : (cornerSeverity > 0.55 ? 0.18 : 0.10);
    const riseBlend = 0.24 + onLineScore * 0.08;
    if(safeTargetSpeed < _targetSpeedSmooth) {
      _targetSpeedSmooth += (safeTargetSpeed - _targetSpeedSmooth) * dropBlend;
      const maxDrop = softCorner ? 1.6 : (cornerSeverity > 0.55 ? 3.6 : 2.4);
      _targetSpeedSmooth = Math.max(safeTargetSpeed, _targetSpeedSmooth - maxDrop);
      if(softCorner || onLineScore > 0.5) {
        _targetSpeedSmooth = Math.max(_targetSpeedSmooth, k.speed * 0.93);
      }
    } else {
      _targetSpeedSmooth += (safeTargetSpeed - _targetSpeedSmooth) * riseBlend;
    }
    safeTargetSpeed = _targetSpeedSmooth;

    let needsBrake  = k.speed > safeTargetSpeed + (14 + cornerSeverity * 6);
    if(overshootRisk > 0.90 && k.speed > safeTargetSpeed + 18) needsBrake = true;
    // Force brake only when nearly off or projected fully off — not just near kerbs.
    if(projectedOffTrack || edgeNorm > 0.98) needsBrake = true;
    // Authored brake zones: only hard tags force early; light tags wait longer (carry speed).
    if(track.hasBrakePlan && maxBrakeTag >= 4.5 && k.speed > safeTargetSpeed + 8) needsBrake = true;
    if(track.hasBrakePlan && maxBrakeTag >= 3.2 && maxBrakeTag < 4.5 && k.speed > safeTargetSpeed + 14) needsBrake = true;
    if(track.hasBrakePlan && maxBrakeTag >= 1.5 && maxBrakeTag < 3.2 && k.speed > safeTargetSpeed + 22) needsBrake = true;
    // On-line + light brake: prefer lift/coast over hard pedal.
    if(onLineScore > 0.55 && maxBrakeTag < 2.5 && k.speed < safeTargetSpeed + 28) needsBrake = false;
    if(trafficAhead && nearestTrafficArc < 90 && !projectedOffTrack && edgeNorm < 0.92 && k.speed < safeTargetSpeed + 18) {
      needsBrake = false;
    }
    let shouldAccel = !projectedOffTrack && edgeNorm < 0.99 && (k.speed < safeTargetSpeed - (1 + cornerSeverity * 1.8));
    if(cornerSeverity > 0.40 && k.speed < momentumFloor + 22 && headingErr < 1.20) {
      needsBrake = false;
      shouldAccel = true;
    }
    // Earlier / stronger exit throttle once past apex, especially on the racing line.
    if(cornerExitWindow && !projectedOffTrack && headingErr < 0.78 && edgeNorm < 0.97) {
      needsBrake = false;
      shouldAccel = true;
    }
    if(onLineScore > 0.5 && approachFrac < 0.30 && maxBrakeTag < 3.5 && !projectedOffTrack && headingErr < 0.85) {
      needsBrake = false;
      shouldAccel = true;
    }
    const adaptiveBrakeMulBase = 1 + Math.min(1.35, overshootRisk * (0.75 + cornerSeverity * 0.85));
    
    // ── AI PIT DECISION ────────────────────────────────────
    // Commit internally to a pit entry, then drive the pit lane — never teleport.
    const PIT_RADIUS = 380;
    const pitPos = track.pitPos;
    const pitEntry = track.pitLane ? track.pitLane.entryPt : pitPos;
    const distToPitEntry = pitEntry ? Math.hypot(k.x - pitEntry.x, k.y - pitEntry.y) : Infinity;
    const inPitZone = distToPitEntry <= PIT_RADIUS;
    const nearPitApproach = distToPitEntry <= 1100;
    const totalLaps = k.totalLaps || 3;
    const inQualifying = !!(typeof race !== 'undefined' && race &&
      (race.phase === 'qualifying' || race.phase === 'quali-turn'));

    // Stage teleports (quali→grid, versus driver swap) zero lap while this
    // closure still holds the previous stage's pit bookkeeping — reset it.
    if(k.lap < _lastSeenLap) {
      _lastSeenLap = k.lap;
      _lastPitLap = -999;
      _pitAfterPushLap = false;
    }

    if(k.lap > _lastSeenLap) {
      _lastSeenLap = k.lap;
    }

    _pitStrategy = getAiPitStrategyId(aiIndex, difficulty, totalLaps);
    k.aiPitPlan = _pitStrategy;

    const lapsSinceLastPit = k.lap - _lastPitLap;
    // Qualifying uses staggered pit releases — AI should not auto-box mid-session.
    if(!inQualifying && !k.inPit && k.pitPhase === null && !k._pitIntentActive && !k._pitExiting && (k._pitCooldown || 0) <= 0) {
      let wantPit = false;
      const aiPitCall = getPitCallStatus(k, totalLaps, _pitStrategy, window._raceWeather || 'dry');
      if(aiPitCall && aiPitCall.level !== 'window' && lapsSinceLastPit > 0) {
        wantPit = true;
      }
      // Start routing once close enough to the entry so they peel off cleanly.
      if(wantPit && (inPitZone || nearPitApproach)) {
        k._pitIntentActive = true;
        k._pitEntryConfirmed = false;
        // Exit target is set when the box opens — keep entry routing clean.
        _lastPitLap = k.lap;
        _pitAfterPushLap = false;
      }
    }

    // ── AI MISTAKES ────────────────────────────────────────
    // Mistakes cost time: 0.5-1.5s depending on when they occur
    _mistakeTimer -= 0.016; // decrement each frame (~60fps)
    
    if(_mistakeActive) {
      _mistakeDuration -= 0.016;
      if(_mistakeDuration <= 0) {
        _mistakeActive = false; // mistake over
      }
    } else if(_mistakeTimer <= 0 && Math.random() < mistakeChance) {
      // Trigger a new mistake
      _mistakeActive = true;
      _mistakeDuration = 0.5 + Math.random() * 1.0; // 0.5-1.5s
      const types = ['wide-corner', 'early-brake', 'late-accel'];
      _mistakeType = types[Math.floor(Math.random() * types.length)];
      _mistakeTimer = 3.0; // cooldown: next mistake at least 3s away
    }
    
    // Apply mistake effects to current frame
    let mistakeSteering = 1.0;   // steering mult (1.0 = normal)
    let mistakeBraking = 1.0;    // braking mult
    let mistakeAccel = 1.0;      // accel mult
    
    if(_mistakeActive) {
      switch(_mistakeType) {
        case 'wide-corner':
          // Take corner too wide: reduce steering response by 40-60%
          mistakeSteering = 0.4 + Math.random() * 0.2;
          break;
        case 'early-brake':
          // Brake too early: increase braking by 30-50%
          mistakeBraking = 1.3 + Math.random() * 0.2;
          break;
        case 'late-accel':
          // Late acceleration response: reduce accel by 50-70%
          mistakeAccel = 0.3 + Math.random() * 0.2;
          break;
      }
    }
    
    // Compute final steering with mistake
    let steerBias = 0;
    if(projectedOffTrack || edgeNorm > 0.98) {
      const cdx = spl[nearIdx].x - k.x;
      const cdy = spl[nearIdx].y - k.y;
      let cDiff = Math.atan2(cdy, cdx) - k.angle;
      while (cDiff >  Math.PI) cDiff -= Math.PI * 2;
      while (cDiff < -Math.PI) cDiff += Math.PI * 2;
      steerBias = cDiff * 0.58;
    }
    const targetSteer = (diff + steerBias) * mistakeSteering;
    const steerSmoothing = projectedOffTrack ? 0.52 : (trafficAhead ? 0.40 : 0.32);
    _steerFilter += (targetSteer - _steerFilter) * steerSmoothing;
    const finalSteer = _steerFilter;
    const finalSteering = {
      left: finalSteer < -steerThresh,
      right: finalSteer > steerThresh
    };
    
    // Compute final throttle/brake with mistakes + adaptive overshoot braking
    const finalAccel = shouldAccel && !needsBrake && mistakeAccel > 0.5;
    const finalBrake = needsBrake || mistakeBraking > 1.15;
    let brakeMult = 1;
    if(finalBrake) {
      brakeMult = adaptiveBrakeMulBase * mistakeBraking;
      // Soft recovery brake near absolute edge — not a kerb panic dump.
      if(projectedOffTrack || edgeNorm > 0.98) brakeMult = Math.max(brakeMult, 1.45);
      brakeMult = Math.max(1, Math.min(2.2, brakeMult));
    }

    const straightEnough = maxCurv < 0.055 && cornerSeverity < 0.2;
    const ersReserve = {ultraeasy: 0.55, easy: 0.46, medium: 0.34, hard: 0.24, extreme: 0.16}[difficulty] || 0.34;
    const useERS = !k.isOffTrack &&
      !needsBrake &&
      !projectedOffTrack &&
      edgeNorm < 0.92 &&
      headingErr < 0.58 &&
      k.ersCharge > Math.max(0.08, ersReserve * _personality.ersBias) &&
      (straightEnough || k.speed > k.maxSpeed * 0.86);
    const useDRS = !!k.drsAvailable &&
      !!k.drsInZone &&
      !k.isOffTrack &&
      !needsBrake &&
      !projectedOffTrack &&
      edgeNorm < 0.90 &&
      headingErr < 0.50 &&
      straightEnough;

    return {
      up:    finalAccel,
      down:  finalBrake,
      left:  finalSteering.left,
      right: finalSteering.right,
      brakeMult,
      ers:   useERS,
      drs:   useDRS,
      // Intent is set on the kart above; never fire a teleporting pit key.
      pit:   false
    };
  };

  return { fn, set: (k) => { kart = k; if(k) { k.aiPitPlan = _pitStrategyId; k.aiStyle = _personality.name; } } };
}

// ── GHOST KART RENDERER ─────────────────────────────────
function kartVisPose(k) {
  if(typeof race !== 'undefined' && race && race.mode === 'online' && k) {
    const localIdx = (typeof onlineCameraIndex === 'function') ? onlineCameraIndex() : 0;
    const isLocal = race.karts && race.karts[localIdx] === k;
    if(isLocal && isFinite(k._visOffX) && isFinite(k._visOffY)) {
      return {
        x: k.x + k._visOffX,
        y: k.y + k._visOffY,
        angle: k.angle + (isFinite(k._visOffA) ? k._visOffA : 0)
      };
    }
  }
  return { x: k.x, y: k.y, angle: k.angle };
}

function drawGhost(ctx, kart, camX, camY, W, H) {
  if(typeof race !== 'undefined' && race && race.mode === 'online') return;
  if(!kart._bestGhost || kart._bestGhost.length < 2) return;
  if(kart.lapStart === null) return;
  const elapsed = (performance.now() - kart.lapStart) / 1000;
  const ghost = kart._bestGhost;
  if(elapsed > ghost[ghost.length - 1].t + 1) return; // ghost finished, don't linger
  let lo = 0, hi = ghost.length - 1;
  while(lo < hi - 1) { const mid = (lo + hi) >> 1; if(ghost[mid].t <= elapsed) lo = mid; else hi = mid; }
  const f0 = ghost[lo], f1 = ghost[hi];
  const span = f1.t - f0.t;
  const alpha2 = span > 0.0001 ? Math.min(1, (elapsed - f0.t) / span) : 0;
  const gx = f0.x + (f1.x - f0.x) * alpha2;
  const gy = f0.y + (f1.y - f0.y) * alpha2;
  const ga = f0.a + (f1.a - f0.a) * alpha2;
  const sx = gx - camX + W/2, sy = gy - camY + H/2;
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.translate(sx, sy);
  ctx.rotate(ga);
  ctx.fillStyle = '#00f5ff';
  // body
  ctx.beginPath();
  ctx.moveTo(-12,-4); ctx.lineTo(8,-3); ctx.lineTo(13,-1.5); ctx.lineTo(13,1.5); ctx.lineTo(8,3); ctx.lineTo(-12,4);
  ctx.closePath(); ctx.fill();
  // sidepods
  ctx.beginPath();
  ctx.moveTo(-11,-8); ctx.lineTo(4,-8); ctx.lineTo(6,-5); ctx.lineTo(-11,-5); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-11,8); ctx.lineTo(4,8); ctx.lineTo(6,5); ctx.lineTo(-11,5); ctx.closePath(); ctx.fill();
  // nose
  ctx.beginPath();
  ctx.moveTo(12,-1.8); ctx.lineTo(19,-0.6); ctx.lineTo(19,0.6); ctx.lineTo(12,1.8); ctx.closePath(); ctx.fill();
  // front wing
  ctx.fillRect(16,-12,5,24);
  // rear wing
  ctx.fillRect(-21,-9,5,18);
  // wheels
  ctx.fillStyle = 'rgba(0,60,80,0.6)';
  [[10,-10],[10,10],[-8,-10],[-8,10]].forEach(([wx,wy])=>{
    ctx.beginPath(); ctx.arc(wx,wy,4.5,0,Math.PI*2); ctx.fill();
  });
  ctx.restore();
}

// ── RACE POSITION RANKING ───────────────────────────────
function kartRaceProgress(kart, track) {
  const cum = track.cum, totalLen = track.totalLen;
  if(!cum || !totalLen) return kart.lap || 0;
  return (kart.lap || 0) + (cum[kart._nearestSplineIdx || 0] || 0) / totalLen;
}

function isKartRankedFinished(kart) {
  return !!(kart.finished && kart.finishTime != null);
}

function compareKartRacePosition(a, b, track) {
  const aFin = isKartRankedFinished(a);
  const bFin = isKartRankedFinished(b);
  if(aFin && !bFin) return -1;
  if(!aFin && bFin) return 1;
  if(aFin && bFin) {
    const dt = a.finishTime - b.finishTime;
    if(dt !== 0) return dt;
    const fo = (a.finishOrder ?? 9999) - (b.finishOrder ?? 9999);
    if(fo !== 0) return fo;
    return (a.id ?? 0) - (b.id ?? 0);
  }
  return kartRaceProgress(b, track) - kartRaceProgress(a, track);
}

function buildRaceRankings(karts, track) {
  return karts.map((kart, i) => ({ kart, i }))
    .sort((a, b) => compareKartRacePosition(a.kart, b.kart, track));
}

// ── POSITION TRACKER ────────────────────────────────────
function drawPositionTracker(ctx, karts, W, H) {
  if(!race || !race.track) return;
  const track = race.track;
  const cum = track.cum, totalLen = track.totalLen;
  if(!cum || !totalLen) return;
  const sorted = karts.slice().sort((a, b) => compareKartRacePosition(a, b, track));
  const leaderK = sorted[0];
  // Draw above minimap in bottom-right
  const rowH = 17;
  const bw = 130;
  const bh = 14 + karts.length * rowH;
  const bx = W - 140;          // same x as minimap
  const by = H - 140 - bh - 4; // 4px gap above minimap
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.76)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = 'rgba(0,245,255,0.32)'; ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);
  // Header
  ctx.fillStyle = 'rgba(0,245,255,0.75)';
  ctx.font = 'bold 8px Nunito,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('POSITIONS', bx + bw/2, by + 11);
  // Each kart row
  const rankColors = ['#ffd700','#c0c0c0','#cd7f32'];
  sorted.forEach((k, rank) => {
    const localIdx = (race.mode === 'online') ? onlineCameraIndex() : 0;
    const isHuman = k === karts[localIdx];
    const ry = by + 14 + (rank + 1) * rowH;
    ctx.fillStyle = isHuman ? '#00f5ff' : (rankColors[rank] || 'rgba(255,255,255,0.5)');
    ctx.font = isHuman ? 'bold 9px Nunito,sans-serif' : '9px Nunito,sans-serif';
    ctx.textAlign = 'left';
    let name = isHuman ? 'YOU' : (karts.length > 2 ? `AI ${k.id}` : 'P2');
    if(race.mode === 'online') name = isHuman ? 'YOU' : (k.onlineName || ('P' + (k.id + 1)));
    ctx.fillText(`P${rank+1}  ${name}`, bx + 6, ry);
    if(isHuman && rank > 0) {
      ctx.fillStyle = '#ff9500';
      ctx.textAlign = 'right';
      ctx.font = '8px Nunito,sans-serif';
      if(isKartRankedFinished(k) && isKartRankedFinished(leaderK)) {
        ctx.fillText('+' + fmtTime(k.finishTime - leaderK.finishTime), bx + bw - 4, ry);
      } else if(isKartRankedFinished(k)) {
        ctx.fillText('FIN', bx + bw - 4, ry);
      } else {
        const gapDist = Math.max(0, (kartRaceProgress(leaderK, track) - kartRaceProgress(k, track)) * totalLen);
        const avgSpd = Math.max(1, Math.abs(k.speed));
        ctx.fillText('+' + (gapDist / avgSpd).toFixed(1) + 's', bx + bw - 4, ry);
      }
    } else if(isHuman) {
      ctx.fillStyle = '#4ade80';
      ctx.textAlign = 'right';
      ctx.font = '8px Nunito,sans-serif';
      ctx.fillText('LEAD', bx + bw - 4, ry);
    }
  });
  ctx.textAlign = 'left';
  ctx.restore();
}

// ── MINIMAP ─────────────────────────────────────────────
function drawMinimap(ctx, track, karts, x, y, size) {
  const spl = track.spline;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  spl.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
  const scX=(size-20)/(maxX-minX), scY=(size-20)/(maxY-minY), sc=Math.min(scX,scY);
  const ofx = 10+(size-20-(maxX-minX)*sc)/2-minX*sc;
  const ofy = 10+(size-20-(maxY-minY)*sc)/2-minY*sc;

  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeStyle = 'rgba(0,245,255,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(0,0,size,size); ctx.fill(); ctx.stroke();

  // track
  ctx.beginPath();
  ctx.moveTo(spl[0].x*sc+ofx, spl[0].y*sc+ofy);
  spl.forEach(p=>ctx.lineTo(p.x*sc+ofx, p.y*sc+ofy));
  ctx.closePath();
  ctx.strokeStyle = track.borderColor;
  ctx.lineWidth = track.trackWidth*sc*0.9;
  ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.globalAlpha=0.5; ctx.stroke(); ctx.globalAlpha=1;

  ctx.strokeStyle = track.trackColor;
  ctx.lineWidth = track.trackWidth*sc*0.7;
  ctx.beginPath();
  ctx.moveTo(spl[0].x*sc+ofx, spl[0].y*sc+ofy);
  spl.forEach(p=>ctx.lineTo(p.x*sc+ofx, p.y*sc+ofy));
  ctx.closePath();
  ctx.stroke();

  // karts
  const kartColors = ['#00f5ff','#ff6b35'];
  karts.forEach((k,i)=>{
    const vis = (typeof kartVisPose === 'function') ? kartVisPose(k) : { x: k.x, y: k.y };
    ctx.fillStyle = kartColors[i];
    ctx.beginPath();
    ctx.arc(vis.x*sc+ofx, vis.y*sc+ofy, 4, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth=1; ctx.stroke();
  });
  // Pit garage / entry marker
  const _pitMarkerPos = track.pitLane ? track.pitLane.garagePos : track.pitPos;
  if(_pitMarkerPos) {
    const mpx = _pitMarkerPos.x*sc+ofx;
    const mpy = _pitMarkerPos.y*sc+ofy;
    ctx.fillStyle = '#ff9500';
    ctx.beginPath(); ctx.arc(mpx, mpy, 4, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth=1; ctx.stroke();
    ctx.fillStyle = '#ff9500';
    ctx.font = 'bold 7px Nunito,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('P', mpx, mpy+3);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

function getRaceDirectorMessages(raceState, kart) {
  if(!raceState || !kart || !raceState.track) return [];
  const messages = [];
  const weatherId = normalizeWeatherId(raceState.weather || 'dry');
  const weather = WEATHER_DEFS.find(w => w.id === weatherId) || WEATHER_DEFS[0];
  messages.push({ level:'info', text:`RACE CONTROL · ${weather.label}` });

  const cum = raceState.track.cum;
  const totalLen = raceState.track.totalLen;
  if(cum && totalLen && raceState.karts && raceState.karts.length > 1) {
    const track = raceState.track;
    const ranking = raceState.karts.map((entryKart, index) => ({
      kart: entryKart,
      index,
    })).sort((a, b) => compareKartRacePosition(a.kart, b.kart, track));
    const myIndex = ranking.findIndex(row => row.kart === kart);
    if(myIndex === 0 && ranking[1]) {
      const leader = ranking[0].kart;
      const p2 = ranking[1].kart;
      if(isKartRankedFinished(leader) && isKartRankedFinished(p2)) {
        messages.push({ level:'info', text:`LEADING · +${fmtTime(p2.finishTime - leader.finishTime)} OVER P2` });
      } else {
        const gapDist = Math.max(0, (kartRaceProgress(leader, track) - kartRaceProgress(p2, track)) * totalLen);
        const avgSpeed = Math.max(120, (Math.abs(kart.speed) + Math.abs(p2.speed)) * 0.5);
        messages.push({ level:'info', text:`LEADING · +${(gapDist / avgSpeed).toFixed(1)}s OVER P2` });
      }
    } else if(myIndex > 0) {
      const ahead = ranking[myIndex - 1];
      const me = ranking[myIndex];
      if(isKartRankedFinished(ahead.kart) && isKartRankedFinished(me.kart)) {
        const gap = me.kart.finishTime - ahead.kart.finishTime;
        messages.push({ level:gap < 1.2 ? 'warn' : 'info', text:`P${myIndex + 1} · +${fmtTime(gap)} TO CAR AHEAD` });
      } else {
        const gapDist = Math.max(0, (kartRaceProgress(ahead.kart, track) - kartRaceProgress(me.kart, track)) * totalLen);
        const avgSpeed = Math.max(120, (Math.abs(kart.speed) + Math.abs(ahead.kart.speed)) * 0.5);
        const gap = gapDist / avgSpeed;
        messages.push({ level:gap < 1.2 ? 'warn' : 'info', text:`P${myIndex + 1} · ${gap.toFixed(1)}s TO CAR AHEAD` });
      }
    }
  }

  if(kart === raceState.karts[0]) {
    if(kart._pitIntentActive) {
      messages.push({ level:'warn', text:'PIT ASSIST ACTIVE · PRESS V TO CLEAR' });
    }
  }

  if(kart.tyreWrongWeather) messages.push({ level:'critical', text:'TYRE WARNING · WRONG COMPOUND' });
  if(kart.tyreTempState === 'cold' && (kart.lap || 0) < 2) {
    messages.push({ level:'info', text:'TYRES COLD · BUILD TEMP GENTLY' });
  } else if(kart.tyreTempState === 'overheated') {
    messages.push({ level:'warn', text:'TYRES OVERHEATING · MANAGE PACE' });
  }
  if(raceState.track.surface && raceState.track.surface.offTrackMult < 0.72) {
    messages.push({ level:'warn', text:`SURFACE ALERT · ${raceState.track.surface.label}` });
  }
  return messages.slice(0, 4);
}

function drawRaceDirectorPanel(ctx, raceState, kart) {
  const messages = getRaceDirectorMessages(raceState, kart);
  if(!messages.length) return;
  const panelW = 308;
  const rowH = 22;
  const panelH = 14 + messages.length * rowH;
  const px = 12;
  const py = 122;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.76)';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = 'rgba(0,245,255,0.26)';
  ctx.strokeRect(px, py, panelW, panelH);
  messages.forEach((msg, idx) => {
    const y = py + 6 + idx * rowH;
    const color = msg.level === 'critical' ? '#ff5a5a' : msg.level === 'warn' ? '#ffd700' : '#aaddff';
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(px + 6, y, panelW - 12, rowH - 3);
    ctx.fillStyle = color;
    ctx.font = 'bold 9px Nunito,sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(msg.text, px + 12, y + 14);
  });
  ctx.restore();
}

function drawOnlineHostBanner(ctx, raceState) {
  const b = raceState && raceState._onlineHostBanner;
  if(!b || !b.text) return;
  if(performance.now() > (b.until || 0)) {
    raceState._onlineHostBanner = null;
    return;
  }
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(W / 2 - 260, 48, 520, 32);
  ctx.strokeStyle = 'rgba(255,215,0,0.55)';
  ctx.strokeRect(W / 2 - 260, 48, 520, 32);
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 12px Nunito,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(b.text, W / 2, 70);
  ctx.textAlign = 'left';
  ctx.restore();
}

function drawPitIntentGuide(ctx, raceState, kart, camX, camY, viewW, viewH) {
  if(!raceState || !raceState.track || !raceState.track.pitLane || !kart || !kart._pitIntentActive) return;
  const pl = raceState.track.pitLane;
  const points = [pl.entryPt, pl.garagePos].filter(Boolean);
  if(points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,149,0,0.95)';
  ctx.lineWidth = 4;
  ctx.setLineDash([14, 10]);
  ctx.beginPath();
  ctx.moveTo(points[0].x - camX + viewW / 2, points[0].y - camY + viewH / 2);
  for(let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x - camX + viewW / 2, points[i].y - camY + viewH / 2);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  points.forEach((p, idx) => {
    const sx = p.x - camX + viewW / 2;
    const sy = p.y - camY + viewH / 2;
    ctx.fillStyle = idx === 0 ? '#ffd700' : '#ff9500';
    ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 9px Nunito,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(idx === 0 ? 'IN' : 'BOX', sx, sy + 3);
  });
  ctx.fillStyle = 'rgba(255,149,0,0.92)';
  ctx.fillRect(viewW / 2 - 138, viewH - 64, 276, 24);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 10px Nunito,sans-serif';
  ctx.fillText('PIT ASSIST ACTIVE · FOLLOW ORANGE GUIDE', viewW / 2, viewH - 48);
  ctx.textAlign = 'left';
  ctx.restore();
}

function getDebugOverlayRect(viewW) {
  return {
    x: Math.max(12, viewW - 258),
    y: 122,
    w: 246,
    h: 110
  };
}

function drawDebugOverlay(ctx, kart, viewW, viewH) {
  if(!_showDebugOverlay || !kart) return;
  const activeParticles = _pPool.reduce((sum, p) => sum + (p.active ? 1 : 0), 0);
  const { x: panelX, y: panelY, w: panelW, h: panelH } = getDebugOverlayRect(viewW);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeStyle = 'rgba(0,245,255,0.32)';
  ctx.strokeRect(panelX, panelY, panelW, panelH);
  ctx.fillStyle = '#00f5ff';
  ctx.font = 'bold 10px Nunito,sans-serif';
  ctx.fillText('DEBUG / PERF', panelX + 8, panelY + 14);
  ctx.fillStyle = '#dbeaff';
  ctx.font = '9px Nunito,sans-serif';
  ctx.fillText(`QUALITY ${_qualityLevel.toUpperCase()}`, panelX + 8, panelY + 32);
  ctx.fillText(`PARTICLES ${activeParticles}/${POOL_SIZE}`, panelX + 8, panelY + 48);
  ctx.fillText(`SLIPSTREAM ${(kart.slipstreamStrength * 100).toFixed(0)}%`, panelX + 8, panelY + 64);
  ctx.fillText(`PIT ASSIST ${kart._pitIntentActive ? 'ON' : 'OFF'}`, panelX + 8, panelY + 80);
  ctx.fillText('F9 DEBUG · F8 QUALITY · ALT+V PIT ASSIST', panelX + 8, panelY + 98);
  ctx.restore();
}

/** Race elapsed timer parked under the debug/perf panel (versus per-viewport). */
function drawViewportRaceTimer(ctx, elapsed, viewW) {
  const dbg = getDebugOverlayRect(viewW);
  const timerW = 130, timerH = 24;
  const timerX = dbg.x + (dbg.w - timerW) / 2;
  const timerY = (_showDebugOverlay ? dbg.y + dbg.h + 6 : dbg.y);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(timerX, timerY, timerW, timerH);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(timerX, timerY, timerW, timerH);
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.font = '12px Nunito,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(fmtTime(elapsed), timerX + timerW / 2, timerY + 16);
  ctx.textAlign = 'left';
  ctx.restore();
}

// ── RACE STATE ──────────────────────────────────────────
let race = null;
let animId = null;
let lastTime = null;
let _fpsFrames = 0, _fpsTimer = 0, _fpsDisplay = 0;
let _qualityLevel = 'high';
let _showDebugOverlay = false;

const QUALITY_PRESETS = {
  low: { particleSpawnMul:0.45, trailLines:4, rainDrops:90, screenShakeMul:0.60, speedLineAlpha:0.22 },
  medium: { particleSpawnMul:0.72, trailLines:7, rainDrops:150, screenShakeMul:0.82, speedLineAlpha:0.32 },
  high: { particleSpawnMul:1.00, trailLines:10, rainDrops:220, screenShakeMul:1.00, speedLineAlpha:0.45 },
};

function saveRuntimePrefs() {
  try {
    localStorage.setItem('kartblitz_quality', _qualityLevel);
    localStorage.setItem('kartblitz_debugoverlay', _showDebugOverlay ? '1' : '0');
  } catch(e) {}
}

function setQualityLevel(level) {
  if (!QUALITY_PRESETS[level]) return;
  _qualityLevel = level;
  saveRuntimePrefs();
  if (typeof refreshSettingsPane === 'function') refreshSettingsPane();
}

function cycleQualityLevel() {
  const order = ['low', 'medium', 'high'];
  const idx = order.indexOf(_qualityLevel);
  _qualityLevel = order[(idx + 1 + order.length) % order.length];
  saveRuntimePrefs();
  if (typeof refreshSettingsPane === 'function') refreshSettingsPane();
}

let _qualityDefaultsApplied = false;
function applyDeviceQualityDefaults(systemInfo) {
  if (_qualityDefaultsApplied) return;
  let saved = null;
  try { saved = localStorage.getItem('kartblitz_quality'); } catch(e) {}
  if (saved && QUALITY_PRESETS[saved]) {
    _qualityDefaultsApplied = true;
    return;
  }
  // Prefer low/medium on Chromebooks, mobile, and low-RAM devices for 4GB smoothness
  let preferLow = false;
  try {
    const mem = navigator.deviceMemory;
    const cores = navigator.hardwareConcurrency || 4;
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const device = (systemInfo && (systemInfo.device || systemInfo.deviceType || '') + '').toLowerCase();
    const os = (systemInfo && (systemInfo.os || '') + '').toLowerCase();
    if (coarse || device.includes('mobile') || device.includes('tablet')) preferLow = true;
    if (os.includes('chrome') && os.includes('os')) preferLow = true;
    if (typeof mem === 'number' && mem > 0 && mem <= 4) preferLow = true;
    if (cores <= 4 && (typeof mem !== 'number' || mem <= 8)) preferLow = true;
  } catch(e) {}
  _qualityLevel = preferLow ? 'medium' : 'high';
  if (preferLow && (navigator.deviceMemory || 8) <= 2) _qualityLevel = 'low';
  _qualityDefaultsApplied = true;
  saveRuntimePrefs();
}

(function loadRuntimePrefs() {
  try {
    const savedQuality = localStorage.getItem('kartblitz_quality');
    if(savedQuality && QUALITY_PRESETS[savedQuality]) {
      _qualityLevel = savedQuality;
      _qualityDefaultsApplied = true;
    }
    _showDebugOverlay = localStorage.getItem('kartblitz_debugoverlay') === '1';
  } catch(e) {}
})();

class Race {
  constructor(mode, trackData) {
    this.mode = mode;
    this.track = trackData;
    this.phase = 'countdown'; // qualifying|quali-turn|countdown|launch|racing|finished
    this.countdownVal = 3;
    this.countdownTimer = 0;
    this.raceTimer = 0;
    this.finishedTimer = 0;
    this.startTime = null;
    this.resultsShown = false; // BUG FIX: prevent repeated showResults calls
    this._nextFinishOrder = 1;
    this._gameplayStarted = false;
    this.launchTimer = 0;
    this.launchDuration = 1.2;
    this.launchRPM = [];
    this.launchOptimal = 0.66;
    this.launchFeedback = null;
    this.qualiEnabled = raceQualiEnabled && (mode === 'ai' || mode === 'versus') && !window._skipNextQuali;
    window._skipNextQuali = false;
    this.qualiLaps = Math.max(1, raceQualiLaps || 1);
    this.qualiSessionMin = Math.max(2, raceQualiSessionMin || 4);
    this.qualiTimeLeft = this.qualiSessionMin * 60;
    this.qualiTurnDriver = 0;
    this.qualiNextRelease = 0;
    this.qualiReleaseTimer = 0;
    this.qualiReleaseGap = 3;
    this.qualiOrder = null;
    this.gridOrder = null;

    // One Lap Shootout state machine
    this.shootoutStage = mode === 'shootout' ? 'player' : null; // player|ai
    this.shootoutPlayerLap = Infinity;
    this.shootoutAiLap = Infinity;
    this.shootoutDifficulty = window._shootoutDifficulty || 'medium';
    this._pitMenuPauseAt = 0; // performance.now() while human pit tyre UI freezes the race

    const pd = getPlayerData();
    // Time Trial is always dry / good conditions.
    this.weather = mode === 'trial' ? 'dry' : normalizeWeatherId(pd.weather || 'dry');
    this.tyres = getLegalTyreId(pd.tyres || 'med', this.weather);
    this.collisionMode = normalizeCollisionMode(pd.collisionMode || 'collision');
    // Shootout: one lap. Time Trial: open session (exit from pause). Else: chosen race distance.
    const lapCount = (mode === 'shootout')
      ? 1
      : (mode === 'trial')
        ? Number.POSITIVE_INFINITY
        : (pd.selectedLaps || trackData.laps);
    this.lapCount = lapCount;

    const sp = trackData.startPos;
    const ang = trackData.startAngle;
    const spread = mode === 'versus' ? 28 : 0;

    this.karts = [];
    const p1Liv = getPlayerLivery('p1');
    const p2Liv = getPlayerLivery('p2');
    const p1pc = getPaintColor(p1Liv.chassis);
    const p2pc = getPaintColor(p2Liv.chassis);
    if(mode === 'trial') {
      this.karts.push(new Kart(0, sp.x, sp.y+15, ang, p1pc.body, p1pc.shadow, getP1Input));
      this.karts[0].livery = p1Liv;
      this.karts[0]._mlDemoFrames = [];
      applyUpgradesToKart(this.karts[0], 'p1');
    } else if(mode === 'ai') {
      this.aiDifficulty = window._aiDifficulty || 'medium';
      const numAI = Math.max(1, Math.min(10, window._aiCount || 3));
      this.karts.push(new Kart(0, sp.x, sp.y+8, ang, p1pc.body, p1pc.shadow, getP1Input));
      this.karts[0].livery = p1Liv;
      applyUpgradesToKart(this.karts[0], 'p1');
      const aiColors = [
        {body:'#ff6b35',shadow:'#8f2f00'},
        {body:'#39ff14',shadow:'#1a7000'},
        {body:'#aa44ff',shadow:'#550088'},
        {body:'#ffd700',shadow:'#7a6500'},
        {body:'#00c2ff',shadow:'#005a77'},
        {body:'#ff3b8d',shadow:'#7a1a45'},
        {body:'#00e091',shadow:'#006843'},
        {body:'#c07bff',shadow:'#5c3188'},
        {body:'#ff8f00',shadow:'#7a4300'},
        {body:'#f5f5f5',shadow:'#7a7a7a'},
      ];
      for(let ai = 0; ai < numAI; ai++) {
        const useML = (window._aiDriver === 'ml');
        const ctrl = useML
          ? makeMLInput(trackData, window._mlPolicyPath || 'sim/rl/policy.json')
          : makeAIInput(trackData, this.aiDifficulty, ai);
        const aiKart = new Kart(ai+1, sp.x - (ai+1)*30, sp.y + (ai+1)*18, ang,
          aiColors[ai % aiColors.length].body, aiColors[ai % aiColors.length].shadow, ctrl.fn);
        aiKart.isAI = true;
        aiKart._mlDriver = useML;
        ctrl.set(aiKart);
        applyUpgradesToKart(aiKart, 'p1');
        this.karts.push(aiKart);
      }
    } else if(mode === 'shootout') {
      this.aiDifficulty = this.shootoutDifficulty;
      this.karts.push(new Kart(0, sp.x, sp.y+8, ang, p1pc.body, p1pc.shadow, getP1Input));
      this.karts[0].livery = p1Liv;
      applyUpgradesToKart(this.karts[0], 'p1');

      const ctrl = makeAIInput(trackData, this.aiDifficulty, 0, { mode: 'shootout' });
      const aiKart = new Kart(1, sp.x-30, sp.y+24, ang, '#ff6b35', '#8f2f00', ctrl.fn);
      aiKart.isAI = true;
      ctrl.set(aiKart);
      applyUpgradesToKart(aiKart, 'p1');
      this.karts.push(aiKart);
    } else if(mode === 'online') {
      const cfg = window._onlineRaceConfig || { order: [], players: [], localSlot: 0 };
      const order = cfg.order || [];
      const players = cfg.players || [];
      const onlineColors = [
        {body:'#00f5ff',shadow:'#005a77'},
        {body:'#ff6b35',shadow:'#8f2f00'},
        {body:'#39ff14',shadow:'#1a7000'},
        {body:'#ffd700',shadow:'#7a6500'},
        {body:'#aa44ff',shadow:'#550088'},
        {body:'#ff3b8d',shadow:'#7a1a45'},
      ];
      const sess = (window.OnlineNet && window.OnlineNet.session) || null;
      const count = Math.max(2, Math.min(6, order.length || players.length || 2));
      this.onlineOrder = order.slice(0, count);
      this.onlinePlayers = players.slice(0, count);
      this.localOnlineSlot = (cfg.localSlot >= 0) ? cfg.localSlot : 0;
      for(let i = 0; i < count; i++) {
        const connId = order[i] || (players[i] && players[i].id) || ('slot'+i);
        const plist = players.find(p => p.id === connId) || players[i] || {};
        const col = onlineColors[i % onlineColors.length];
        const body = plist.color || col.body;
        const inputFn = sess ? sess.makeKartInputFn(connId) : (i === 0 ? getP1Input : function(){ return {up:false,down:false,left:false,right:false,ers:false,drs:false}; });
        const kart = new Kart(i, sp.x - i*30, sp.y + i*18, ang, body, col.shadow, inputFn);
        kart.onlineConnId = connId;
        kart.onlineName = plist.name || ('P'+(i+1));
        kart.isOnlineRemote = i !== this.localOnlineSlot;
        // Display shell only — shared OnlineSim owns local physics; remotes are interpolated
        if(i === this.localOnlineSlot) applyUpgradesToKart(kart, 'p1');
        this.karts.push(kart);
      }
      if(cfg.weather) this.weather = normalizeWeatherId(cfg.weather);
      if(cfg.collisionMode) this.collisionMode = normalizeCollisionMode(cfg.collisionMode);
      if(cfg.tyres) this.tyres = getLegalTyreId(cfg.tyres, this.weather);
      if(cfg.laps) this.lapCount = cfg.laps;
    } else {
      this.karts.push(new Kart(0, sp.x-spread, sp.y+12, ang, p1pc.body, p1pc.shadow, getP1Input));
      this.karts.push(new Kart(1, sp.x+spread, sp.y+28, ang, p2pc.body, p2pc.shadow, getP2Input));
      this.karts[0].livery = p1Liv;
      this.karts[1].livery = p2Liv;
      // Versus: shared team upgrades (best of P1/P2 + R&D) apply equally to both karts.
      applyUpgradesToKart(this.karts[0], 'p1');
      applyUpgradesToKart(this.karts[1], 'p2');
    }

    // Put every kart on proper grid slots at the race start (all tracks, all modes).
    const initSlots = this._getGridSlots(this.karts.length);
    this.karts.forEach((k, i) => {
      const s = initSlots[i] || initSlots[0];
      if(!s) return;
      k.x = s.x; k.y = s.y; k.angle = s.a;
      k.prevX = k.x; k.prevY = k.y;
      k.speed = 0;
    });
    this.gridSlots = this.mode === 'shootout' ? null : initSlots.map(s => ({...s}));

    // Shootout: only the active runner starts on track. The other waits in the garage.
    if(this.mode === 'shootout') {
      this._deployShootoutKart(this.karts[0]);
      this._stowShootoutKart(this.karts[1]);
    }

    this.karts.forEach(k => {
      k.totalLaps = lapCount;
      k.tyreId = this.tyres;
      // Apply weather physics
      applyWeatherToKart(k, this.weather, this.tyres);
      if(this.mode === 'shootout') applyShootoutBoost(k);
      // Time Trial: infinite tyre life — no wear, no degradation, no grip loss.
      if(this.mode === 'trial') {
        k.noTyreWear = true;
        k.tyreWear = 0;
        const tDef = TYRE_DEFS.find(t => t.id === k.tyreId) || TYRE_DEFS[1];
        k.tyreTemp = ((tDef.idealMin || 85) + (tDef.idealMax || 100)) * 0.5;
        k.tyreTempState = 'optimal';
        k.tyreGripPct = 1.0;
      }
      // Seed the progressive spline tracker with the actual nearest index at spawn.
      // Without this the tracker starts at 0 and might search the wrong section
      // on the very first frame if the startPos is partway along the first straight.
      const spl = trackData.spline, sn = spl.length;
      let seedBest = Infinity, seedIdx = 0;
      for (let si = 0; si < sn; si++) {
        const sd = Math.hypot(k.x - spl[si].x, k.y - spl[si].y);
        if (sd < seedBest) { seedBest = sd; seedIdx = si; }
      }
      k._nearestSplineIdx = seedIdx;
    });
    // Make weather available globally for pit stop tyre changes
    window._raceWeather = this.weather;

    // Camera per kart (for split screen)
    this.cameras = this.karts.map(k => ({x:k.x, y:k.y}));

    this.launchRPM = this.karts.map(k => k.isAI ? (0.62 + (Math.random() - 0.5) * 0.18) : 0.35);
    this._trialStartTyrePick = false;
    if(this.qualiEnabled) {
      // AI and Versus: one driver at a time, released from the pit lane.
      this.phase = 'quali-turn';
      this._prepareQualifying();
    } else if(this.mode === 'trial' && trackData.pitLane && trackData.pitLane.garagePos) {
      this._beginTrialFromPit();
    }
  }

  /** Time Trial: spawn in the garage, pick tyres, then drive out (no setup-screen tyre pick). */
  _beginTrialFromPit() {
    const k = this.karts[0];
    const pl = this.track.pitLane;
    if(!k || !pl || !pl.garagePos) return;
    k.x = pl.garagePos.x;
    k.y = pl.garagePos.y;
    k.prevX = k.x;
    k.prevY = k.y;
    k.angle = pl.garageAngle !== undefined ? pl.garageAngle : (pl.exitAngle || 0);
    k.speed = 0;
    k._onPitLane = true;
    const spl = this.track.spline;
    if(spl && spl.length) {
      let best = Infinity, idx = 0;
      for(let si = 0; si < spl.length; si++) {
        const d = Math.hypot(k.x - spl[si].x, k.y - spl[si].y);
        if(d < best) { best = d; idx = si; }
      }
      k._nearestSplineIdx = idx;
    }
    if(this.cameras && this.cameras[0]) {
      this.cameras[0].x = k.x;
      this.cameras[0].y = k.y;
    }
    this.gridSlots = null;
    this.phase = 'racing';
    this._nextFinishOrder = 1;
    this.startTime = performance.now();
    this._trialStartTyrePick = true;
    this._openPitBox(k, 0);
    startEngine(0);
    if(!this._gameplayStarted) {
      CG.gameplayStart();
      this._gameplayStarted = true;
    }
  }

  _finishTrialStartTyrePick(k) {
    if(!k) return;
    const weather = this.weather || window._raceWeather || 'dry';
    const tyreId = k.pitTyreChoice || k.tyreId || this.tyres || 'med';
    this.tyres = tyreId;
    try {
      const p = getPlayerData();
      p.tyres = tyreId;
      savePlayerData(p);
    } catch(e) {}
    k._applyNewTyre(tyreId, weather);
    // Keep Time Trial infinite-tyre rules after the fit flash.
    k.noTyreWear = true;
    k.tyreWear = 0;
    const tDef = TYRE_DEFS.find(t => t.id === tyreId) || TYRE_DEFS[1];
    k.tyreTemp = ((tDef.idealMin || 85) + (tDef.idealMax || 100)) * 0.5;
    k.tyreTempState = 'optimal';
    k.tyreGripPct = 1.0;
    k.flashTimer = 0;
    k.rankFlash = '';
    k.pitPhase = null;
    k.inPit = false;
    k._hasPitted = false;
    k._pitIntentActive = false;
    k._pitEntryConfirmed = false;
    k._pitExiting = true;
    k._onPitLane = true;
    const pl = this.track.pitLane;
    if(pl) {
      k._pitExitPos = pl.exitPos || null;
      k._pitExitAngle = pl.exitAngle !== undefined ? pl.exitAngle : 0;
      if(pl.garageAngle !== undefined) k.angle = pl.garageAngle;
    }
    this._trialStartTyrePick = false;
    this._compensatePitMenuPause();
  }

  updateCamera(idx, dt) {
    const k = this.karts[idx];
    const cam = this.cameras[idx];
    const fallback = (this.track && this.track.startPos) ? this.track.startPos : { x: 0, y: 0 };
    if(!cam) return;
    if(!k || !isFinite(k.x) || !isFinite(k.y) || !isFinite(k.angle) || !isFinite(k.speed)) {
      cam.x = isFinite(cam.x) ? cam.x : fallback.x;
      cam.y = isFinite(cam.y) ? cam.y : fallback.y;
      return;
    }
    const vis = (typeof kartVisPose === 'function') ? kartVisPose(k) : { x: k.x, y: k.y, angle: k.angle };
    const lookAhead = Math.abs(k.speed) * 0.55;
    let tx = vis.x + Math.cos(vis.angle) * lookAhead;
    let ty = vis.y + Math.sin(vis.angle) * lookAhead;
    const cache = (typeof _trackBaseCache !== 'undefined' && _trackBaseCache && this.track && _trackBaseCache.trackId === this.track.id)
      ? _trackBaseCache : null;
    if(cache && isFinite(cache.minX) && isFinite(cache.maxX)) {
      const pad = 80;
      tx = Math.max(cache.minX + pad, Math.min(cache.maxX - pad, tx));
      ty = Math.max(cache.minY + pad, Math.min(cache.maxY - pad, ty));
    }
    if(!isFinite(cam.x) || !isFinite(cam.y)) {
      cam.x = vis.x;
      cam.y = vis.y;
    }
    const lerpFactor = 1 - Math.pow(0.025, dt || 0.016);
    cam.x += (tx - cam.x) * lerpFactor;
    cam.y += (ty - cam.y) * lerpFactor;
    if(!isFinite(cam.x) || !isFinite(cam.y)) {
      cam.x = vis.x;
      cam.y = vis.y;
    }
    clampCamToTrack(cam, this.track, vis);
  }

  _getGridSlots(count) {
    if(this.track.gridSlots && this.track.gridSlots.length) {
      const preset = this.track.gridSlots.slice(0, count).map(s => ({x:s.x, y:s.y, a:s.a}));
      if(preset.length >= count) return preset;
    }
    const slots = [];
    const sp = this.track.startPos;
    const ang = this.track.startAngle;
    const backX = -Math.cos(ang), backY = -Math.sin(ang);
    const perpX = -Math.sin(ang), perpY = Math.cos(ang);
    const layout = this.track.gridLayout || getTrackGridLayout(this.track.trackWidth);
    const rowGap = layout.rowGap;
    const laneGap = layout.laneGap;
    for(let i = 0; i < count; i++) {
      const row = Math.floor(i / 2);
      const lane = (i % 2 === 0) ? -1 : 1;
      slots.push({
        x: sp.x + backX * rowGap * row + perpX * laneGap * lane,
        y: sp.y + backY * rowGap * row + perpY * laneGap * lane,
        a: ang
      });
    }
    return slots;
  }

  // Returns a slot ~900 track-units before the S/F line for flying-lap shootout starts.
  _getShootoutFlyingSlot() {
    const tr = this.track;
    if(!tr.cpLines || !tr.cpLines.length || !tr.cum || !tr.spline) return null;
    const cum = tr.cum, spl = tr.spline, totalLen = tr.totalLen;
    const sfIdx = tr.cpLines[0].idx;
    const sfDist = cum[sfIdx];
    let targetDist = sfDist - 900;
    if(targetDist < 0) targetDist += totalLen;
    let bestDiff = Infinity, best = 0;
    for(let si = 0; si < spl.length; si++) {
      const d1 = Math.abs(cum[si] - targetDist);
      const d2 = Math.abs(cum[si] - targetDist - totalLen);
      const diff = Math.min(d1, d2);
      if(diff < bestDiff) { bestDiff = diff; best = si; }
    }
    const tang = splineTangent(spl, best);
    return { x: spl[best].x, y: spl[best].y, a: Math.atan2(tang.y, tang.x) };
  }

  // Garage / pit hold bay for the inactive shootout competitor.
  _getShootoutHoldSlot() {
    const pl = this.track.pitLane;
    if(pl && pl.garagePos) {
      return {
        x: pl.garagePos.x,
        y: pl.garagePos.y,
        a: pl.garageAngle !== undefined ? pl.garageAngle : Math.PI
      };
    }
    if(this.track.pitPos) {
      return { x: this.track.pitPos.x, y: this.track.pitPos.y, a: this.track.startAngle || 0 };
    }
    // Last resort: park far off-map so they cannot be hit.
    return { x: -99999, y: -99999, a: 0 };
  }

  _stowShootoutKart(k) {
    if(!k) return;
    const hold = this._getShootoutHoldSlot();
    k.x = hold.x;
    k.y = hold.y;
    k.angle = hold.a;
    k.prevX = k.x;
    k.prevY = k.y;
    k.speed = 0;
    k.finished = true;
    k._shootoutStowed = true;
    k.inPit = true;
    k.pitPhase = null;
    k._onPitLane = true;
    k._pitIntentActive = false;
    k._pitEntryConfirmed = false;
    k._pitExitPos = null;
    k._pitExitAngle = null;
    k._pitExiting = false;
    k.slipstreamBoost = false;
    k.slipstreamStrength = 0;
    k.ersActive = false;
    k.drsActive = false;
    k.drsAvailable = false;
  }

  _deployShootoutKart(k) {
    if(!k) return;
    const fly = this._getShootoutFlyingSlot() || {
      x: this.track.startPos.x,
      y: this.track.startPos.y,
      a: this.track.startAngle || 0
    };
    k.x = fly.x;
    k.y = fly.y;
    k.angle = fly.a;
    k.prevX = k.x;
    k.prevY = k.y;
    k.speed = 0;
    k.finished = false;
    k.finishTime = null;
    k.finishOrder = null;
    k._shootoutStowed = false;
    k.inPit = false;
    k.pitPhase = null;
    k._onPitLane = false;
    k._pitIntentActive = false;
    k._pitEntryConfirmed = false;
    k._pitExitPos = null;
    k._pitExitAngle = null;
    k._pitExiting = false;
    k._hasPitted = false;
    k.slipstreamBoost = false;
    k.slipstreamStrength = 0;
    k.ersActive = false;
    k.ersCharge = 1.0;
    k.drsActive = false;
    k.drsAvailable = false;
    k.lap = 0;
    k.checkpointsBit = 0;
    k.nextCp = 1;
    k.lapTimes = [];
    k.lapStart = null;
    k.bestLap = Infinity;
    k.splitTimes = [];
    k._ghostRecord = [];
    k._ghostSampleTimer = 0;
    const spl = this.track.spline;
    if(spl && spl.length) {
      let best = Infinity, idx = 0;
      for(let si = 0; si < spl.length; si++) {
        const d = Math.hypot(k.x - spl[si].x, k.y - spl[si].y);
        if(d < best) { best = d; idx = si; }
      }
      k._nearestSplineIdx = idx;
    }
  }

  _getPitQualifySlots() {
    const pl = this.track.pitLane;
    const n = this.karts.length;
    const ang = pl.exitAngle !== undefined ? pl.exitAngle : 0;
    const backX = -Math.cos(ang), backY = -Math.sin(ang);
    const slots = [];
    for (let i = 0; i < n; i++) {
      slots.push({
        x: pl.exitPos.x + backX * (20 + i * 52),
        y: pl.exitPos.y + backY * (20 + i * 52),
        a: ang
      });
    }
    return slots;
  }

  /** Single-file pit queue facing the exit — front of queue (bay 0) leaves first. */
  _getQualiHoldSlot(bayIndex) {
    const pl = this.track.pitLane;
    const spacing = 58;
    if(pl && pl.garagePos) {
      const exit = pl.exitPos || null;
      let ang = pl.garageAngle;
      if(ang === undefined || ang === null) {
        ang = exit
          ? Math.atan2(exit.y - pl.garagePos.y, exit.x - pl.garagePos.x)
          : (pl.exitAngle || 0);
      }
      // Start one car-length behind the box so the active release isn't overlapped.
      const back = ang + Math.PI;
      const queueStart = spacing;
      return {
        x: pl.garagePos.x + Math.cos(back) * (queueStart + bayIndex * spacing),
        y: pl.garagePos.y + Math.sin(back) * (queueStart + bayIndex * spacing),
        a: ang
      };
    }
    if(pl && pl.path && pl.path.length >= 2) {
      const path = pl.path;
      const idx = Math.max(0, Math.min(path.length - 1, Math.floor(path.length * 0.35) - bayIndex));
      const a = path[Math.max(0, idx)];
      const b = path[Math.min(path.length - 1, idx + 1)];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      return { x: a.x, y: a.y, a: ang };
    }
    return this._getGridSlots(this.karts.length)[bayIndex] || this._getGridSlots(1)[0];
  }

  /** Re-pack anyone still waiting into a tight nose-to-tail pit queue. */
  _relayoutQualiQueue() {
    let bay = 0;
    this.karts.forEach((k) => {
      if(!k || k._qualiReleased) return;
      const best = k.bestLap;
      const lapTimes = k.lapTimes ? k.lapTimes.slice() : [];
      const pushTarget = k._qualiPushTarget != null ? k._qualiPushTarget : this.qualiLaps;
      this._stowQualiKart(k, bay++);
      k.bestLap = best;
      k.lapTimes = lapTimes;
      k._qualiReleased = false;
      k._qualiPushDone = false;
      k._qualiPushTarget = pushTarget;
      k._qualiKeepDriving = true;
      k.totalLaps = pushTarget;
    });
  }

  _stowQualiKart(k, bayIndex) {
    if(!k) return;
    const best = k.bestLap;
    const lapTimes = k.lapTimes ? k.lapTimes.slice() : [];
    const slot = this._getQualiHoldSlot(bayIndex);
    k.x = slot.x; k.y = slot.y; k.angle = slot.a;
    k.prevX = k.x; k.prevY = k.y;
    k.speed = 0;
    k.finished = true;
    k._qualiWaiting = true;
    k.pitPhase = null;
    k.inPit = false;
    k._onPitLane = false;
    k._pitIntentActive = false;
    k._pitEntryConfirmed = false;
    k._pitExiting = false;
    k._pitExitPos = null;
    k._pitExitAngle = null;
    k._hasPitted = false;
    // Keep the time they already set — never wipe on park.
    k.bestLap = best;
    k.lapTimes = lapTimes;
  }

  _deployQualiRunner(k) {
    if(!k) return;
    const pl = this.track.pitLane;
    const slot = (pl && pl.garagePos)
      ? {
          x: pl.garagePos.x,
          y: pl.garagePos.y,
          a: pl.garageAngle !== undefined ? pl.garageAngle : (pl.exitAngle || 0)
        }
      : (this._getPitQualifySlots()[0] || this._getGridSlots(1)[0]);
    const pushLaps = this.qualiLaps;
    this._resetKartForStage(k, slot, pushLaps);
    k.finished = false;
    k._qualiWaiting = false;
    k._qualiKeepDriving = true;
    k._qualiPushTarget = pushLaps;
    k._qualiPushDone = false;
    if(pl && pl.exitPos) {
      // Drive out of the garage along the pit lane — no mid-lap teleport later.
      k._onPitLane = true;
      k._pitExiting = true;
      k._pitExitPos = pl.exitPos;
      k._pitExitAngle = pl.exitAngle !== undefined ? pl.exitAngle : slot.a;
    }
  }

  _resetKartForStage(k, slot, lapsForStage) {
    k.x = slot.x; k.y = slot.y; k.angle = slot.a;
    k.prevX = k.x; k.prevY = k.y;
    k.speed = 0;
    k.lap = 0;
    k.checkpointsBit = 0;
    k.nextCp = 1;
    k.lapTimes = [];
    k.lapStart = null;
    k.bestLap = Infinity;
    k.splitTimes = [];
    k.finished = false;
    k.finishTime = null;
    k.finishOrder = null;
    k.totalLaps = lapsForStage;
    k.pitPhase = null;
    k.inPit = false;
    k._onPitLane = false;
    k._pitIntentActive = false;
    k._pitEntryConfirmed = false;
    k._pitExitPos = null;
    k._pitExitAngle = null;
    k._pitExiting = false;
    k._hasPitted = false;
    k._qualiWaiting = false;
    k._qualiReleased = false;
    k._qualiKeepDriving = false;
    k._qualiPushDone = false;
    k._qualiPushTarget = null;
    k._penaltyTimer = 0;
    k._isCompletelyOff = false;
    k.slipstreamBoost = false;
    k.slipstreamStrength = 0;
    k.ersActive = false;
    k.ersCharge = 1.0;
    k._ersToggled = false;
    k.drsActive = false;
    k.drsAvailable = false;
    k._drsToggled = false;
    k.flashTimer = 0;
    k.rankFlash = '';
    k._ghostRecord = [];
    k._ghostSampleTimer = 0;
    k._shootoutStowed = false;
    // Reseed progressive spline tracker at the new slot — stale index from
    // pit-exit quali (or prior stage) makes AI aim at the wrong segment.
    const spl = this.track.spline;
    if(spl && spl.length) {
      let best = Infinity, idx = 0;
      for(let si = 0; si < spl.length; si++) {
        const d = Math.hypot(k.x - spl[si].x, k.y - spl[si].y);
        if(d < best) { best = d; idx = si; }
      }
      k._nearestSplineIdx = idx;
    }
  }

  /** Place everyone on the race grid in quali/start order and clear pit/quali residue. */
  _placeKartsOnStartingGrid(order) {
    const count = this.karts.length;
    const slots = this._getGridSlots(count);
    this.gridSlots = slots.map(s => ({...s}));
    const ord = (order && order.length === count)
      ? order.slice()
      : this.karts.map((_, i) => i);
    for(let rank = 0; rank < ord.length; rank++) {
      const k = this.karts[ord[rank]];
      if(!k) continue;
      const slot = slots[rank] || slots[0];
      this._resetKartForStage(k, slot, this.lapCount);
      k.gridPos = rank + 1;
    }
    this.cameras = this.karts.map(k => ({ x: k.x, y: k.y }));
  }

  _isAiKart(i, k) {
    return !!(k && k.isAI) || (this.mode === 'ai' && i > 0);
  }

  _isHumanPitMenuOpen() {
    return this.karts.some((k, i) => k.pitPhase === 'selecting' && !this._isAiKart(i, k));
  }

  _compensatePitMenuPause() {
    if(!this._pitMenuPauseAt) return;
    const dur = performance.now() - this._pitMenuPauseAt;
    this._pitMenuPauseAt = 0;
    if(dur <= 0) return;
    this.karts.forEach(k => {
      if(k.lapStart !== null) k.lapStart += dur;
      if(k.lastCheckpointTime !== null && k.lastCheckpointTime !== undefined) k.lastCheckpointTime += dur;
    });
  }

  _armPitIntent(k) {
    if(!k || k.finished || k.inPit || k.pitPhase !== null || k._pitExiting) return false;
    if((k._pitCooldown || 0) > 0) return false;
    k._pitIntentActive = true;
    k._pitEntryConfirmed = false;
    k._pitExiting = false;
    return true;
  }

  _openPitBox(k, i) {
    if(!k || k.pitPhase !== null || k.inPit) return;
    if(k._pitExiting || (k._pitCooldown || 0) > 0) return;
    const pl = this.track.pitLane;
    k.pitPhase = 'selecting';
    seedPitStopSelection(k, i, this.weather || window._raceWeather || 'dry');
    k.inPit = true;
    k.speed = 0;
    k._aiPitTimer = 0;
    k._pitIntentActive = false;
    k._pitEntryConfirmed = false;
    k._pitExiting = false;
    if(pl) {
      k._pitExitPos = pl.exitPos || null;
      k._pitExitAngle = pl.exitAngle !== undefined ? pl.exitAngle : 0;
      if(pl.garageAngle !== undefined) k.angle = pl.garageAngle;
    }
    if(!this._isAiKart(i, k)) {
      this._pitMenuPauseAt = performance.now();
      // Held throttle / pit key must not instantly confirm a compound.
      k._pitSelectLock = 0.55;
      k._pitConfirmHeld = true;
      const bp = i === 0 ? BINDINGS.p1 : BINDINGS.p2;
      [bp.up, bp.up && bp.up.toLowerCase && bp.up.toLowerCase(), bp.up && bp.up.toUpperCase && bp.up.toUpperCase(),
       bp.pit, bp.pit && bp.pit.toLowerCase && bp.pit.toLowerCase(), bp.pit && bp.pit.toUpperCase && bp.pit.toUpperCase()]
        .filter(Boolean).forEach(kk => { try { delete keys[kk]; } catch(e){} });
      if(i === 0) touchState.p1.pit = false;
      if(i === 1) touchState.p2.pit = false;
      try {
        const sub = document.getElementById('pit-ui-sub');
        if(sub) {
          sub.textContent = this._trialStartTyrePick
            ? 'Pick a compound, confirm, then drive out of the pits.'
            : 'Paused. Choose tyres, then confirm with the button or a fresh W / ↑ press.';
        }
      } catch(e){}
    }
    beep(440,0.08,0.3,'square');
  }

  _handlePitSelectingUi(dt) {
    this.karts.forEach((k, i) => {
      if(k.pitPhase !== 'selecting') return;
      if(k.pitNavCooldown > 0) k.pitNavCooldown -= dt;
      if(k._pitSelectLock > 0) k._pitSelectLock = Math.max(0, k._pitSelectLock - dt);
      const isAI = this._isAiKart(i, k);
      const isP1 = i === 0;
      const bp = isP1 ? BINDINGS.p1 : BINDINGS.p2;
      const weather = normalizeWeatherId(this.weather || window._raceWeather || 'dry');
      const legal = getLegalTyreDefs(weather);
      const legalCount = legal.length;

      if(isAI) {
        k._aiPitTimer = (k._aiPitTimer || 0) + dt;
        if(k._aiPitTimer < 0.3) {
          const preferId = getAIPitTyreId(k, weather);
          let bestTyreIdx = legal.findIndex(t => t.id === preferId);
          if(bestTyreIdx < 0) bestTyreIdx = 0;
          k.pitNavIdx = bestTyreIdx;
        } else if(k._aiPitTimer >= 0.5) {
          k.pitTyreChoice = (legal[k.pitNavIdx] || legal[0]).id;
          k.pitPhase = 'stopping';
          beep(550,0.08,0.3,'square');
        }
      } else {
        const ts = touchMode ? (isP1 ? touchState.p1 : touchState.p2) : null;
        const navPrev = keyActive(bp.left) || (ts && ts.steer < -0.45);
        const navNext = keyActive(bp.right) || keyActive(bp.down) || (ts && (ts.steer > 0.45 || ts.brake > 0.45));
        const confirmHeld = keyActive(bp.up) || keyActive(bp.pit) || (ts && !!ts.pit);
        const confirm = (k._pitSelectLock || 0) <= 0 && confirmHeld && !k._pitConfirmHeld;
        k._pitConfirmHeld = confirmHeld;
        if(ts && ts.pit) ts.pit = false;

        if(k.pitNavCooldown <= 0) {
          if(navPrev) {
            k.pitNavIdx = (k.pitNavIdx - 1 + legalCount) % legalCount;
            k.pitNavCooldown = 0.18;
            beep(440,0.04,0.2,'square');
          }
          if(navNext) {
            k.pitNavIdx = (k.pitNavIdx + 1) % legalCount;
            k.pitNavCooldown = 0.18;
            beep(440,0.04,0.2,'square');
          }
        }
        if(confirm) {
          k.pitTyreChoice = (legal[k.pitNavIdx] || legal[0]).id;
          [bp.up, bp.up.toLowerCase(), bp.up.toUpperCase(), bp.pit, bp.pit.toLowerCase(), bp.pit.toUpperCase()].forEach(kk=>delete keys[kk]);
          beep(550,0.08,0.3,'square');
          if(this._trialStartTyrePick) {
            this._finishTrialStartTyrePick(k);
          } else {
            k.pitPhase = 'stopping';
            this._compensatePitMenuPause();
          }
        }
      }
    });
  }

  /** Shared pit entry / garage service for race + qualifying. */
  _processPitLaneService(dt) {
    const PIT_RADIUS = 380;
    const GARAGE_OPEN_RADIUS = 130;
    const inQualiTurn = this.phase === 'quali-turn';
    const pl = this.track.pitLane;

    // Tick exit cooldowns for every kart.
    this.karts.forEach(k => {
      if(k && (k._pitCooldown || 0) > 0) k._pitCooldown = Math.max(0, k._pitCooldown - dt);
    });

    // Open pit screen at the orange garage — humans always (no PIT key needed);
    // AI still needs to be routed onto the pit lane / intent.
    this.karts.forEach((k, i) => {
      if(!k || k.pitPhase !== null || k.inPit) return;
      if(k._pitExiting || (k._pitCooldown || 0) > 0) return;
      if(inQualiTurn && (!k._qualiReleased || k._qualiWaiting)) return;
      if(k.finished && !inQualiTurn) return;
      if(!pl || !pl.garagePos || !pl.path) return;
      const gDist = Math.hypot(k.x - pl.garagePos.x, k.y - pl.garagePos.y);
      if(gDist >= GARAGE_OPEN_RADIUS) return;
      const isHuman = !this._isAiKart(i, k);
      if(isHuman || k._onPitLane || k._pitEntryConfirmed || k._pitIntentActive) {
        this._openPitBox(k, i);
      }
    });

    // Manual PIT key / button still arms entry assist when near the pit entry.
    this.karts.forEach((k, i) => {
      if(!k || k.pitPhase !== null || k.inPit || k._pitIntentActive || k._pitExiting) return;
      if((k._pitCooldown || 0) > 0) return;
      if(inQualiTurn && (!k._qualiReleased || k._qualiWaiting)) return;
      if(k.finished && !inQualiTurn) return;
      const isHuman = !this._isAiKart(i, k);
      let pitPressed = false;
      if(isHuman) {
        const pitKey = i === 0 ? BINDINGS.p1.pit : BINDINGS.p2.pit;
        const ts = touchMode ? (i === 0 ? touchState.p1 : touchState.p2) : null;
        pitPressed = keyActive(pitKey) || (ts && ts.pit && (ts.pit = false, true));
      }
      if(!pitPressed) return;
      if(isHuman) {
        const pitKey = i === 0 ? BINDINGS.p1.pit : BINDINGS.p2.pit;
        delete keys[pitKey];
        if(pitKey.length === 1) { delete keys[pitKey.toLowerCase()]; delete keys[pitKey.toUpperCase()]; }
      }
      const pp = this.track.pitLane ? this.track.pitLane.entryPt : this.track.pitPos;
      if(pp && Math.hypot(k.x - pp.x, k.y - pp.y) > PIT_RADIUS) {
        k._pitTooFarTimer = 2.5;
        if(isHuman) beep(200, 0.1, 0.3, 'sawtooth');
        return;
      }
      this._armPitIntent(k);
      beep(440, 0.08, 0.3, 'square');
    });
    this._handlePitSelectingUi(dt);
  }

  _prepareQualifying() {
    // Staggered pit release: everyone waits in a single-file pit queue, then rolls out
    // every 3s so the field shares the track together.
    this.qualiNextRelease = 0;
    this.qualiReleaseGap = 3;
    this.qualiReleaseTimer = 0; // release driver 0 immediately, then every 3s
    this.qualiTurnDriver = 0;   // last released index (HUD / camera helper)
    this.qualiSessionMin = Math.max(2, raceQualiSessionMin || 4);
    this.qualiTimeLeft = this.qualiSessionMin * 60;
    this.karts.forEach((k, i) => {
      k._qualiReleased = false;
      k._qualiPushDone = false;
      k._qualiPushTarget = this.qualiLaps;
      k._qualiKeepDriving = true;
      this._stowQualiKart(k, i);
      k.bestLap = Infinity;
      k.lapTimes = [];
      k.totalLaps = this.qualiLaps;
    });
    // Ensure bay order is a clean nose-to-tail line.
    this._relayoutQualiQueue();
    if(this.cameras && this.cameras[0] && this.karts[0]) {
      this.cameras[0].x = this.karts[0].x;
      this.cameras[0].y = this.karts[0].y;
    }
  }

  _releaseNextQualiRunner() {
    if(this.qualiNextRelease >= this.karts.length) return false;
    const idx = this.qualiNextRelease;
    const k = this.karts[idx];
    this._deployQualiRunner(k);
    k._qualiReleased = true;
    this.qualiTurnDriver = idx;
    this.qualiNextRelease++;
    // Slide the remaining queue forward into a neat line.
    this._relayoutQualiQueue();
    try { startEngine(idx); } catch(e) {}
    if(!this._gameplayStarted) {
      try { CG.gameplayStart(); } catch(e) {}
      this._gameplayStarted = true;
    }
    if(this.cameras[idx]) {
      this.cameras[idx].x = k.x;
      this.cameras[idx].y = k.y;
    }
    if(this.mode !== 'versus' && idx === 0 && this.cameras[0]) {
      this.cameras[0].x = k.x;
      this.cameras[0].y = k.y;
    }
    return true;
  }

  _finalizeQualifying() {
    const order = this.karts
      .map((k, i) => ({i, t: (k.bestLap < Infinity ? k.bestLap : 9999)}))
      .sort((a, b) => a.t - b.t)
      .map(r => r.i);
    this.qualiOrder = order;
    this.gridOrder = order;

    // Save qualifying times BEFORE grid placement wipes bestLap
    this.qualiTimes = {};
    this.karts.forEach((k, i) => { this.qualiTimes[i] = k.bestLap; });

    // Park everyone cleanly on the race grid (clears pit-exit / hold residue).
    this._placeKartsOnStartingGrid(order);
    this.phase = 'quali-results';
    this._showQualiResults();
  }

  _showQualiResults() {
    if(animId) { cancelAnimationFrame(animId); animId = null; lastTime = null; }
    stopAllEngines();
    stopAllDriftSnds();
  showTouchOverlay(false);
  updateRaceControlsHud(false);
  canvas.style.display = 'none';
    applyPageBackground();
    document.getElementById('countdownOverlay').style.display = 'none';
    const order = this.qualiOrder;
    const wrap = document.getElementById('quali-results-wrap');
    document.getElementById('quali-results-sub').textContent = `STARTING GRID — ${this.track.name}`;
    const posColors = ['#ffd700','#c0c0c0','#cd7f32'];
    const posLabels = ['P1','P2','P3'];
    let html = '<div class="results-card">';
    order.forEach((kartIdx, rank) => {
      const k = this.karts[kartIdx];
      const isHuman = kartIdx === 0;
      const name = isHuman ? 'YOU' : `AI ${kartIdx}`;
      const col = isHuman ? '#00f5ff' : (rank < 3 ? posColors[rank] : 'rgba(255,255,255,0.6)');
      const savedTime = this.qualiTimes ? this.qualiTimes[kartIdx] : k.bestLap;
      const timeStr = (savedTime !== undefined && savedTime < Infinity) ? fmtTime(savedTime) : 'NO TIME';
      const prefix = rank < 3 ? posLabels[rank] : `P${rank+1}`;
      html += `<div class="result-row">
        <span class="result-label" style="color:${col}">${prefix} P${rank+1} ${name}</span>
        <span class="result-val" style="color:${col}">${timeStr}</span>
      </div>`;
    });
    html += '</div>';
    wrap.innerHTML = html;

    // Build race-start tyre selector
    const weather = normalizeWeatherId(this.weather || 'dry');
    const avail = TYRE_DEFS.filter(t => isTyreSelectableForWeather(t, weather));
    const defaultTyre = this.karts[0] ? this.karts[0].tyreId : 'med';
    window._raceStartTyreId = defaultTyre;
    let tyreHtml = `<div style="margin:18px auto 0;max-width:380px;">
      <div style="color:#ff9500;font:bold 11px Nunito,sans-serif;text-align:center;margin-bottom:8px;"> CHOOSE RACE START TYRES</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">`;
    avail.forEach(t => {
      const lapLife = getTyreLapLifespan(this.track.id, t.id);
      const isSel = t.id === defaultTyre;
      tyreHtml += `<button id="tyre-btn-${t.id}" onclick="_selectStartTyre('${t.id}')" style="
        padding:8px 12px;border-radius:6px;border:2px solid ${isSel ? t.color : 'rgba(255,255,255,0.15)'};
        background:${isSel ? t.color+'33' : 'rgba(0,0,0,0.4)'};color:${t.color};
        font:bold 10px Nunito,sans-serif;cursor:pointer;min-width:72px;transition:all .15s;
      ">${t.label}<br><span style="font:8px Rajdhani,sans-serif;color:rgba(255,255,255,0.55)">${lapLife} laps</span></button>`;
    });
    tyreHtml += '</div></div>';
    document.getElementById('quali-tyre-selector').innerHTML = tyreHtml;

    document.getElementById('screen-quali-results').classList.remove('hidden');
  }

  _drawGridSlots(ctx, camX, camY, W, H) {
    const slots = this.gridSlots || (this.track && this.track.gridSlots) || [];
    if(!slots.length) return;
    const layout = (this.track && this.track.gridLayout) || getTrackGridLayout(this.track && this.track.trackWidth);
    const slotLength = layout.slotLength;
    const slotWidth = layout.slotWidth;
    const halfL = slotLength * 0.5;
    const halfW = slotWidth * 0.5;
    const chipW = layout.chipWidth;
    const chipH = layout.chipHeight;
    const labelSize = layout.labelSize;
    const accentBase = (this.track && this.track.accentColor) || '#00f5ff';
    const pulse = 0.72 + 0.28 * Math.sin(performance.now() / 280);
    const phaseFade = this.phase === 'launch'
      ? Math.max(0, 1 - (this.launchTimer / Math.max(0.01, this.launchDuration || 1.2)) * 1.1)
      : 1;
    if(phaseFade <= 0.02) return;
    slots.forEach((slot, idx) => {
      const sx = slot.x - camX + W/2;
      const sy = slot.y - camY + H/2;
      const col = idx === 0 ? '#ffd54a' : idx === 1 ? '#dceeff' : idx === 2 ? '#ff9f57' : accentBase;
      const rim = idx === 0 ? 'rgba(255,213,74,0.98)' : idx === 1 ? 'rgba(220,238,255,0.94)' : idx === 2 ? 'rgba(255,159,87,0.95)' : 'rgba(0,245,255,0.88)';
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(slot.a);
      // Base shadow so the slot reads against any asphalt tone.
      ctx.globalAlpha = 0.18 * phaseFade;
      ctx.fillStyle = '#000';
      ctx.fillRect(-halfL - 6, -halfW - 6, slotLength + 12, slotWidth + 12);
      ctx.shadowBlur = 0;

      // Painted tarmac slot.
      ctx.globalAlpha = 0.26 * phaseFade;
      ctx.fillStyle = 'rgba(246,250,255,0.9)';
      ctx.fillRect(-halfL, -halfW, slotLength, slotWidth);
      ctx.globalAlpha = 0.84 * phaseFade;
      ctx.strokeStyle = 'rgba(232,242,255,0.8)';
      ctx.lineWidth = 2.2;
      ctx.strokeRect(-halfL, -halfW, slotLength, slotWidth);

      // Front launch line and lane alignment details.
      ctx.strokeStyle = rim;
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(halfL - 8, -halfW);
      ctx.lineTo(halfL - 8, halfW);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255,255,255,0.34)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.moveTo(-halfL + 8, 0);
      ctx.lineTo(halfL - 14, 0);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(-halfL + 7, -halfW + 6);
      ctx.lineTo(-halfL + 17, -halfW + 6);
      ctx.moveTo(-halfL + 7, halfW - 6);
      ctx.lineTo(-halfL + 17, halfW - 6);
      ctx.moveTo(halfL - 18, -halfW + 6);
      ctx.lineTo(halfL - 8, -halfW + 6);
      ctx.moveTo(halfL - 18, halfW - 6);
      ctx.lineTo(halfL - 8, halfW - 6);
      ctx.stroke();

      // Countdown glow overlay.
      ctx.globalAlpha = (0.22 + 0.18 * pulse) * phaseFade;
      ctx.shadowColor = col;
      ctx.shadowBlur = 18 + 10 * pulse;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.6;
      ctx.strokeRect(-halfL + 1.5, -halfW + 1.5, slotLength - 3, slotWidth - 3);
      ctx.shadowBlur = 0;

      // Position chip.
      ctx.globalAlpha = phaseFade;
      ctx.fillStyle = 'rgba(5,11,24,0.92)';
      ctx.fillRect(-chipW * 0.5, -chipH * 0.5, chipW, chipH);
      ctx.strokeStyle = rim;
      ctx.lineWidth = 1.6;
      ctx.strokeRect(-chipW * 0.5, -chipH * 0.5, chipW, chipH);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${labelSize}px Nunito,sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`P${idx+1}`, 0, 0);
      ctx.restore();
    });
  }

  _startLaunchPhase() {
    this.phase = 'launch';
    this.launchTimer = 0;
    this.launchRPM = this.karts.map((k, i) => k.isAI ? (0.62 + (Math.random()-0.5) * 0.18) : 0.35);
  }

  _gradeLaunch(rpm) {
    const err = Math.abs(rpm - this.launchOptimal);
    if(rpm > 0.88) return { speed:24, label:'WHEELSPIN', detail:'Too much throttle', color:'#ff4444' };
    if(rpm < 0.30) return { speed:16, label:'BOGGED', detail:'Not enough revs', color:'#f97316' };
    if(err <= 0.045) return { speed:96, label:'PERFECT', detail:'Nailed the launch', color:'#4ade80' };
    if(err <= 0.11) return { speed:78, label:'GOOD', detail:'Clean getaway', color:'#00f5ff' };
    return { speed:Math.max(34, 90 - err * 120), label:'OK', detail:'Close, but not ideal', color:'#ffd700' };
  }

  _applyLaunch() {
    const shootoutActive = this.mode === 'shootout' ? (this.shootoutStage === 'player' ? 0 : 1) : -1;
    this.karts.forEach((k, i) => {
      if(this.mode === 'shootout' && i !== shootoutActive) {
        this._stowShootoutKart(k);
        return;
      }
      const rpm = Math.max(0, Math.min(1, this.launchRPM[i] || 0));
      const launch = this._gradeLaunch(rpm);
      k.speed = launch.speed;
      if(i === 0 || (this.mode === 'shootout' && i === shootoutActive)) {
        this.launchFeedback = {
          label: launch.label,
          detail: launch.detail,
          color: launch.color,
          time: performance.now()
        };
      }
    });
    this.phase = 'racing';
    this._nextFinishOrder = 1;
    this.startTime = performance.now();
    if(this.mode === 'shootout') {
      startEngine(shootoutActive);
    } else {
      startEngine(0);
      if(this.mode === 'versus') startEngine(1);
      if(this.mode === 'online') {
        for(let ei = 1; ei < this.karts.length; ei++) {
          try { startEngine(ei); } catch(e) {}
        }
      }
    }
    if(!this._gameplayStarted) {
      CG.gameplayStart();
      this._gameplayStarted = true;
    }
  }

  _startShootoutAIRun() {
    const ai = this.karts[1];
    const p = this.karts[0];

    // Player leaves the circuit and waits in the garage for the AI flying lap.
    this._stowShootoutKart(p);

    // Reset AI and bring them onto the flying-lap start only when it is their turn.
    const hold = this._getShootoutHoldSlot();
    this._resetKartForStage(ai, hold, 1);
    ai.tyreId = this.tyres;
    applyWeatherToKart(ai, this.weather, this.tyres);
    applyShootoutBoost(ai);
    this._deployShootoutKart(ai);

    this.shootoutStage = 'ai';
    stopAllEngines();
    this.countdownVal = 3;
    this.countdownTimer = 0;
    this.launchRPM[1] = 0.62;
    this.phase = 'countdown';
    document.getElementById('countdownOverlay').style.display = 'flex';
    showCountdown(3);

    this.cameras[0].x = ai.x;
    this.cameras[0].y = ai.y;
    this.cameras[1].x = ai.x;
    this.cameras[1].y = ai.y;
  }

  update(dt) {
    if(this.phase === 'qualifying') {
      // Freeze the whole session while a human is on the pit tyre screen.
      if(this._isHumanPitMenuOpen()) {
        if(!this._pitMenuPauseAt) this._pitMenuPauseAt = performance.now();
        this._handlePitSelectingUi(dt);
        return;
      }
      this._compensatePitMenuPause();

      this.qualiTimeLeft = Math.max(0, this.qualiTimeLeft - dt);
      this.karts.forEach((k, i) => {
        k.drsAvailable = true;
        k.update(dt, this.track, this.karts);
        this.updateCamera(i, dt);
      });

      // ── PIT STOP HANDLING IN QUALIFYING ──────────────────────
      const pitsAllowed = this.mode !== 'trial';
      if(pitsAllowed) {
        this._processPitLaneService(dt);
      }

      if(this.qualiTimeLeft <= 0 || this.karts.every(k => k.finished)) {
        this._finalizeQualifying();
      }
      return;
    }

    if(this.phase === 'quali-turn') {
      // Freeze while the human is choosing tyres in the pit box.
      if(this._isHumanPitMenuOpen()) {
        if(!this._pitMenuPauseAt) this._pitMenuPauseAt = performance.now();
        this._handlePitSelectingUi(dt);
        return;
      }
      this._compensatePitMenuPause();

      // Staggered releases from the pits — released cars share the circuit.
      this.qualiTimeLeft = Math.max(0, this.qualiTimeLeft - dt);
      this.qualiReleaseTimer -= dt;
      if(this.qualiTimeLeft > 0 && this.qualiNextRelease < this.karts.length && this.qualiReleaseTimer <= 0) {
        this._releaseNextQualiRunner();
        this.qualiReleaseTimer = this.qualiReleaseGap;
      }

      // Pit stops allowed for anyone already out on track.
      this._processPitLaneService(dt);

      this.karts.forEach((k, i) => {
        if(k._qualiReleased) {
          if(k.pitPhase === null && !k.inPit) {
            k._qualiWaiting = false;
            k.finished = false;
            k._qualiKeepDriving = true;
          }
          k.drsAvailable = k.pitPhase === null;
          k.update(dt, this.track, this.karts);
        } else {
          k.speed = 0;
          k.finished = true;
          k._qualiWaiting = true;
          k.drsAvailable = false;
          k.pitPhase = null;
          k.inPit = false;
          k._pitIntentActive = false;
          k._pitExiting = false;
        }
      });

      if(this.mode === 'versus') {
        this.karts.forEach((_, i) => this.updateCamera(i, dt));
      } else {
        this.updateCamera(0, dt);
      }

      if(this.qualiTimeLeft <= 0) {
        this._finalizeQualifying();
      }
      return;
    }

    if(this.phase === 'countdown') {
      this.countdownTimer += dt;
      const shootoutActive = this.mode === 'shootout' ? (this.shootoutStage === 'player' ? 0 : 1) : -1;
      this.karts.forEach((k, i) => {
        if(this.mode === 'shootout' && i !== shootoutActive) {
          if(!k._shootoutStowed) this._stowShootoutKart(k);
          return;
        }
        this.updateCamera(i, dt);
        // Let human players build RPM during the countdown
        if(!k.isAI) {
          const inp = k.getInput ? k.getInput() : {up:false, down:false};
          let rpm = this.launchRPM[i] || 0.0;
          if(inp.up) rpm += 1.15 * dt;
          else rpm -= 0.55 * dt;
          if(inp.down) rpm -= 0.75 * dt;
          this.launchRPM[i] = Math.max(0, Math.min(1, rpm));
        } else {
          const jitter = (Math.random() - 0.5) * 0.03;
          this.launchRPM[i] = Math.max(0, Math.min(1, (this.launchRPM[i] || 0.62) + jitter));
        }
      });
      if(this.mode === 'shootout' && shootoutActive >= 0) {
        // Keep spectator camera locked on the active flying-lap runner.
        this.updateCamera(shootoutActive, dt);
        const camSrc = this.cameras[shootoutActive];
        this.cameras.forEach(cam => {
          cam.x = camSrc.x;
          cam.y = camSrc.y;
        });
      }
      if(this.countdownTimer >= 1) {
        this.countdownTimer -= 1;
        this.countdownVal--;
        // Launch on the tick that leaves 1 — GO and cars move together (no dead second).
        if(this.countdownVal <= 0) {
          this._applyLaunch();
          showCountdown(-1);
        } else {
          showCountdown(this.countdownVal);
        }
      }
      return;
    }

    if(this.phase === 'launch') {
      // Legacy path — should no longer be reached but kept as a safety fallback
      this.launchTimer += dt;
      this.karts.forEach((k, i) => {
        this.updateCamera(i, dt);
        if(k.isAI) {
          const jitter = (Math.random() - 0.5) * 0.03;
          this.launchRPM[i] = Math.max(0, Math.min(1, (this.launchRPM[i] || 0.62) + jitter));
          return;
        }
        const inp = k.getInput ? k.getInput() : {up:false, down:false};
        let rpm = this.launchRPM[i] || 0.3;
        if(inp.up) rpm += 1.15 * dt;
        else rpm -= 0.55 * dt;
        if(inp.down) rpm -= 0.75 * dt;
        this.launchRPM[i] = Math.max(0, Math.min(1, rpm));
      });
      if(this.launchTimer >= this.launchDuration) {
        this._applyLaunch();
      }
      return;
    }

    // Freeze race while the player is on the pit tyre screen.
    if(this.phase === 'racing' && this._isHumanPitMenuOpen()) {
      if(!this._pitMenuPauseAt) this._pitMenuPauseAt = performance.now();
      this._handlePitSelectingUi(dt);
      return;
    }
    if(this.phase === 'racing') this._compensatePitMenuPause();

    this.raceTimer += dt;

    // ── PIT STOP KEY DETECTION (blocked in Time Trial / Shootout) ──
    const pitsAllowed = (this.mode !== 'trial' && this.mode !== 'shootout' && this.mode !== 'online');
    if(this.phase === 'racing' && pitsAllowed) {
      this._processPitLaneService(dt);
    }

    const shootoutActive = this.mode === 'shootout' ? (this.shootoutStage === 'player' ? 0 : 1) : -1;
    this.karts.forEach((k,i) => {
      // DRS availability: Time Trial = always; AI = all; Shootout = active runner; Versus = within ~1s of car ahead
      if(this.mode === 'trial') {
        k.drsAvailable = true;
      } else if(this.mode === 'ai' || this.mode === 'online') {
        k.drsAvailable = true;
      } else if(this.mode === 'shootout') {
        k.drsAvailable = (i === shootoutActive);
      } else if(this.mode === 'versus' && this.karts.length === 2) {
        const other = this.karts[1 - i];
        const cum = this.track.cum;
        const totalLen = this.track.totalLen;
        const myProg   = k.lap     + (cum[k._nearestSplineIdx     || 0] || 0) / totalLen;
        const otherProg= other.lap + (cum[other._nearestSplineIdx || 0] || 0) / totalLen;
        let gapDist = (otherProg - myProg) * totalLen; // positive = other is ahead
        // Normalise for wrap-around
        if(gapDist >  totalLen / 2) gapDist -= totalLen;
        if(gapDist < -totalLen / 2) gapDist += totalLen;
        const avgSpd = (Math.abs(k.speed) + Math.abs(other.speed)) / 2 || 320;
        k.drsAvailable = gapDist > 0 && gapDist < avgSpd; // other is ahead by < 1 second
      }

      if(this.mode === 'shootout' && i !== shootoutActive) {
        // Inactive shootout competitor stays in the garage — never on track / never collidable.
        if(!k._shootoutStowed) this._stowShootoutKart(k);
        k.speed = 0;
        k.finished = true;
      } else {
        k.update(dt, this.track, this.karts);
      }
      if(!(this.mode === 'shootout' && i !== shootoutActive)) {
        this.updateCamera(i, dt);
      }
    });
    if(this.mode === 'shootout' && shootoutActive >= 0) {
      this.updateCamera(shootoutActive, dt);
      const camSrc = this.cameras[shootoutActive];
      this.cameras.forEach(cam => {
        cam.x = camSrc.x;
        cam.y = camSrc.y;
      });
    }

    // Update particles (pool-based — no allocation/GC)
    for(let _pi=0;_pi<_pPool.length;_pi++){
      const p=_pPool[_pi]; if(!p.active) continue;
      p.x+=p.vx*dt; p.y+=p.vy*dt;
      p.vx*=0.92; p.vy*=0.92;
      p.life-=dt;
      if(p.life<=0) p.active=false;
    }

    // Check if all karts have finished (or auto-DNF stuck AI after human finishes)
    if(this.mode === 'shootout' && this.phase === 'racing') {
      const p = this.karts[0], ai = this.karts[1];
      if(this.shootoutStage === 'player' && p.finished) {
        this.shootoutPlayerLap = p.bestLap;
        this._startShootoutAIRun();
        return;
      }
      if(this.shootoutStage === 'ai' && ai.finished) {
        this.shootoutAiLap = ai.bestLap;
        this.phase = 'finished';
        this.finishedTimer = 0;
      }
    }

    if(this.mode === 'ai' || this.mode === 'online') {
      const humanIdx = this.mode === 'online' ? onlineCameraIndex() : 0;
      const human = this.karts[humanIdx];
      if(human && human.finished) {
        // Give others 30 seconds after local human finishes, then auto-DNF them
        const humanDone = human.finishTime || 0;
        this.karts.forEach((k, i) => {
          if(i !== humanIdx && !k.finished && this.raceTimer > humanDone + 30) {
            k.finished = true;
            k.finishTime = null; // null signals DNF
          }
        });
      }
    }
    if(this.mode !== 'shootout' && this.karts.every(k=>k.finished) && this.phase === 'racing') {
      this.phase = 'finished';
      this.finishedTimer = 0;
    }
    if(this.phase === 'finished') {
      this.finishedTimer += dt;
      if(this.finishedTimer > 2.2 && !this.resultsShown) {
        this.resultsShown = true;
        this.showResults();
      }
    }
  }

  render() {
    const mode = this.mode;
    const karts = this.karts;
    const track = this.track;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    if(mode === 'trial') {
      // Full screen, camera on P1
      ctx.clearRect(0,0,W,H);
      const cam = this.cameras[0];
      const quality = getQualityPreset();
      // Speed shake: vibrates screen at > 80% max speed
      const _sr0 = Math.abs(karts[0].speed) / karts[0].maxSpeed;
      const _sh0 = _sr0 > 0.8 ? (_sr0 - 0.8) * 14 * quality.screenShakeMul : 0;
      const _sx0 = (Math.random()-0.5)*_sh0, _sy0 = (Math.random()-0.5)*_sh0;
      drawTrack(ctx, track, cam.x + _sx0, cam.y + _sy0, W, H, karts[0].checkpointsBit);
      drawPitIntentGuide(ctx, this, karts[0], cam.x, cam.y, W, H);
      for(let _ri=0;_ri<_pPool.length;_ri++){
        const p=_pPool[_ri]; if(!p.active) continue;
        const a=p.life/p.maxLife;
        ctx.globalAlpha=a*0.8; ctx.fillStyle=p.color;
        ctx.beginPath();
        ctx.arc(p.x-cam.x+W/2, p.y-cam.y+H/2, p.size*a, 0, Math.PI*2);
        ctx.fill(); ctx.globalAlpha=1;
      }
      // Speed trail lines at high velocity
      if(_sr0 > 0.78) {
        ctx.save();
        ctx.globalAlpha = (_sr0 - 0.78) * quality.speedLineAlpha;
        ctx.strokeStyle = 'rgba(210,225,255,0.9)';
        ctx.lineWidth = 1.5;
        const _ang0 = karts[0].angle + Math.PI;
        for(let _li = 0; _li < quality.trailLines; _li++) {
          const lx = Math.random()*W, ly = Math.random()*H;
          const ll = 20 + Math.random()*55;
          ctx.beginPath(); ctx.moveTo(lx, ly);
          ctx.lineTo(lx + Math.cos(_ang0)*ll, ly + Math.sin(_ang0)*ll);
          ctx.stroke();
        }
        ctx.restore();
      }
      karts.forEach(k => k.draw(ctx, cam.x, cam.y, W, H));
      drawGhost(ctx, karts[0], cam.x, cam.y, W, H);
      drawHUD(ctx, karts[0], track, 0, 0, W, H, 0, mode);
      drawMinimap(ctx, track, karts, W-140, H-140, 130);
      drawRaceDirectorPanel(ctx, this, karts[0]);
      drawDebugOverlay(ctx, karts[0], W, H);

    } else if(mode === 'ai' || mode === 'shootout' || mode === 'online') {
      // Full screen mode with a single driving camera.
      ctx.clearRect(0,0,W,H);
      const activeIdx = mode === 'shootout'
        ? (this.shootoutStage === 'player' ? 0 : 1)
        : (mode === 'online' ? onlineCameraIndex() : 0);
      const activeKart = karts[activeIdx] || karts[0];
      const cam = this.cameras[activeIdx] || this.cameras[0] || { x: (this.track.startPos && this.track.startPos.x) || 0, y: (this.track.startPos && this.track.startPos.y) || 0 };
      if(!isFinite(cam.x) || !isFinite(cam.y)) {
        cam.x = (activeKart && isFinite(activeKart.x)) ? activeKart.x : ((this.track.startPos && this.track.startPos.x) || 0);
        cam.y = (activeKart && isFinite(activeKart.y)) ? activeKart.y : ((this.track.startPos && this.track.startPos.y) || 0);
      }
      clampCamToTrack(cam, this.track, activeKart);
      const quality = getQualityPreset();
      const maxSpd = Math.max(1, (activeKart && (activeKart.maxSpeed || activeKart.baseMaxSpeed)) || 469);
      const _sr0 = Math.min(1.5, Math.abs((activeKart && activeKart.speed) || 0) / maxSpd);
      const _sh0 = _sr0 > 0.8 ? (_sr0 - 0.8) * 14 * quality.screenShakeMul : 0;
      const _sx0 = (Math.random()-0.5)*_sh0, _sy0 = (Math.random()-0.5)*_sh0;
      drawTrack(ctx, track, cam.x + _sx0, cam.y + _sy0, W, H, activeKart.checkpointsBit);
      drawPitIntentGuide(ctx, this, activeKart, cam.x, cam.y, W, H);
      if((this.phase === 'countdown' || this.phase === 'launch') && this.gridSlots) this._drawGridSlots(ctx, cam.x, cam.y, W, H);
      for(let _ri=0;_ri<_pPool.length;_ri++){
        const p=_pPool[_ri]; if(!p.active) continue;
        const a=p.life/p.maxLife;
        ctx.globalAlpha=a*0.8; ctx.fillStyle=p.color;
        ctx.beginPath();
        ctx.arc(p.x-cam.x+W/2, p.y-cam.y+H/2, p.size*a, 0, Math.PI*2);
        ctx.fill(); ctx.globalAlpha=1;
      }
      if(_sr0 > 0.78) {
        ctx.save();
        ctx.globalAlpha = (_sr0 - 0.78) * quality.speedLineAlpha;
        ctx.strokeStyle = 'rgba(210,225,255,0.9)';
        ctx.lineWidth = 1.5;
        const _ang0 = activeKart.angle + Math.PI;
        for(let _li = 0; _li < quality.trailLines; _li++) {
          const lx = Math.random()*W, ly = Math.random()*H;
          const ll = 20 + Math.random()*55;
          ctx.beginPath(); ctx.moveTo(lx, ly);
          ctx.lineTo(lx + Math.cos(_ang0)*ll, ly + Math.sin(_ang0)*ll);
          ctx.stroke();
        }
        ctx.restore();
      }
      karts.forEach(k => {
        if(k._shootoutStowed) return;
        k.draw(ctx, cam.x, cam.y, W, H);
      });
      if(mode !== 'online' && (mode !== 'shootout' || this.shootoutStage === 'player')) {
        drawGhost(ctx, karts[0], cam.x, cam.y, W, H);
      }
      drawHUD(ctx, activeKart, track, 0, 0, W, H, 0, 'ai');
      if(mode !== 'shootout') drawPositionTracker(ctx, karts, W, H);
      drawMinimap(ctx, track, karts.filter(k => !k._shootoutStowed), W-140, H-140, 130);
      drawRaceDirectorPanel(ctx, this, activeKart);
      drawDebugOverlay(ctx, activeKart, W, H);
      drawOnlineHostBanner(ctx, this);

      if(mode === 'shootout') {
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(W/2 - 220, 2, 440, 28);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.strokeRect(W/2 - 220, 2, 440, 28);
        ctx.fillStyle = this.shootoutStage === 'player' ? '#00f5ff' : '#ff6b35';
        ctx.font = 'bold 12px Nunito,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(this.shootoutStage === 'player' ? 'SHOOTOUT • YOUR FLYING LAP' : `SHOOTOUT • AI LAP (${(this.shootoutDifficulty||'medium').toUpperCase()})`, W/2, 20);
        ctx.textAlign = 'left';
      }

    } else {
      // Split screen — left/right (keyboard) or top/bottom face-to-face (touch)
      const faceToFace = touchMode;
      const quality = getQualityPreset();
      const viewW = faceToFace ? W : W / 2;
      const viewH = faceToFace ? H / 2 : H;

      karts.forEach((kart, i) => {
        const offX = faceToFace ? 0 : i * viewW;
        const offY = faceToFace ? (i === 0 ? viewH : 0) : 0;
        ctx.save();
        ctx.beginPath();
        ctx.rect(offX, offY, viewW, viewH);
        ctx.clip();
        ctx.translate(offX, offY);
        if(faceToFace && i === 1) {
          ctx.translate(viewW / 2, viewH / 2);
          ctx.rotate(Math.PI);
          ctx.translate(-viewW / 2, -viewH / 2);
        }

        const cam = this.cameras[i];
        // Speed shake for versus
        const _srV = Math.abs(kart.speed) / kart.maxSpeed;
        const _shV = _srV > 0.8 ? (_srV - 0.8) * 12 * quality.screenShakeMul : 0;
        const _sxV = (Math.random()-0.5)*_shV, _syV = (Math.random()-0.5)*_shV;
        drawTrack(ctx, track, cam.x + _sxV, cam.y + _syV, viewW, viewH, kart.checkpointsBit);
        drawPitIntentGuide(ctx, this, kart, cam.x, cam.y, viewW, viewH);
        if((this.phase === 'countdown' || this.phase === 'launch') && this.gridSlots) this._drawGridSlots(ctx, cam.x, cam.y, viewW, viewH);

        // particles in this viewport (pool)
        for(let _ri=0;_ri<_pPool.length;_ri++){
          const p=_pPool[_ri]; if(!p.active) continue;
          const a=p.life/p.maxLife;
          ctx.globalAlpha=a*0.8; ctx.fillStyle=p.color;
          ctx.beginPath();
          ctx.arc(p.x-cam.x+viewW/2, p.y-cam.y+viewH/2, p.size*a, 0, Math.PI*2);
          ctx.fill(); ctx.globalAlpha=1;
        }
        // Speed trail lines (versus)
        if(_srV > 0.78) {
          ctx.save();
          ctx.globalAlpha = (_srV - 0.78) * Math.max(0.18, quality.speedLineAlpha - 0.05);
          ctx.strokeStyle = 'rgba(210,225,255,0.9)';
          ctx.lineWidth = 1.5;
          const _angV = kart.angle + Math.PI;
          for(let _li = 0; _li < Math.max(3, quality.trailLines - 2); _li++) {
            const lx = Math.random()*viewW, ly = Math.random()*viewH;
            const ll = 16 + Math.random()*45;
            ctx.beginPath(); ctx.moveTo(lx, ly);
            ctx.lineTo(lx + Math.cos(_angV)*ll, ly + Math.sin(_angV)*ll);
            ctx.stroke();
          }
          ctx.restore();
        }

        // Draw both karts from this camera
        karts.forEach(k => k.draw(ctx, cam.x, cam.y, viewW, viewH));

        drawHUD(ctx, kart, track, 0, 0, viewW, viewH, i, mode);
        drawDebugOverlay(ctx, kart, viewW, viewH);
        // Per-viewport master timer under debug/perf (replaces shared bottom timer).
        if(this.phase === 'racing' || this.phase === 'finished') {
          drawViewportRaceTimer(ctx, this.raceTimer, viewW);
        }

        // Split line
        if(i === 0) {
          ctx.fillStyle = '#000';
          if(faceToFace) ctx.fillRect(0, 0, viewW, 3);
          else ctx.fillRect(viewW - 2, 0, 4, viewH);
        }

        ctx.restore();
      });

      // Minimap — center strip in face-to-face so it clears both sticks
      if(faceToFace) {
        drawMinimap(ctx, track, karts, W / 2 - 55, H / 2 - 55, 110);
      } else {
        drawMinimap(ctx, track, karts, W - 140, H - 140, 130);
      }
      drawPositionTracker(ctx, karts, W, H);
    }

    if(this.collisionMode === 'nocollision' && this.phase !== 'qualifying' && this.phase !== 'quali-turn') {
      const versusHud = this.mode === 'versus';
      const faceToFace = versusHud && touchMode;
      const badgeY = faceToFace ? (H / 2 - 12) : (versusHud ? (H - 58) : 58);
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(W/2 - 92, badgeY, 184, 24);
      ctx.strokeStyle = 'rgba(0,245,255,0.35)';
      ctx.strokeRect(W/2 - 92, badgeY, 184, 24);
      ctx.fillStyle = '#00f5ff';
      ctx.font = 'bold 10px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('NO COLLISION MODE', W/2, badgeY + 15);
      ctx.textAlign = 'left';
    }

    if(this._pitMenuPauseAt && this._isHumanPitMenuOpen()) {
      const selectingIdx = this.karts.findIndex(k => k && !k.isAI && k.pitPhase === 'selecting');
      const isVersusSplit = this.mode === 'versus' && this.karts.length === 2 && selectingIdx >= 0;
      const faceToFace = isVersusSplit && touchMode;
      // In versus, keep the pause cue on the other player's half so it doesn't cover the pit menu.
      let bannerCx = W / 2;
      let bannerCy = 32;
      if(isVersusSplit && faceToFace) {
        bannerCx = W / 2;
        bannerCy = selectingIdx === 0 ? 24 : (H / 2 + 24);
      } else if(isVersusSplit) {
        bannerCx = selectingIdx === 0 ? W * 0.75 : W * 0.25;
      }
      const bannerW = isVersusSplit ? Math.min(220, W * 0.42) : 300;
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.fillRect(bannerCx - bannerW / 2, bannerCy, bannerW, 26);
      ctx.strokeStyle = 'rgba(255,149,0,0.55)';
      ctx.strokeRect(bannerCx - bannerW / 2, bannerCy, bannerW, 26);
      ctx.fillStyle = '#ff9500';
      ctx.font = 'bold 11px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(isVersusSplit ? 'RACE PAUSED' : 'RACE PAUSED · PIT MENU', bannerCx, bannerCy + 17);
      ctx.textAlign = 'left';
    }

    // Qualifying overlay
    if(this.phase === 'qualifying' || this.phase === 'quali-turn') {
      let title;
      if(this.phase === 'qualifying') {
        title = `QUALIFYING • ${Math.ceil(this.qualiTimeLeft)}s LEFT`;
      } else {
        const out = this.karts.filter(k => k._qualiReleased && !k._qualiWaiting).length;
        const done = this.karts.filter(k => k._qualiReleased && k._qualiPushDone).length;
        const pending = this.karts.length - this.qualiNextRelease;
        const timeLeft = Math.max(0, Math.ceil(this.qualiTimeLeft || 0));
        const timeStr = timeLeft >= 60
          ? `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, '0')}`
          : `${timeLeft}s`;
        if(pending > 0) {
          const secs = Math.max(0, Math.ceil(this.qualiReleaseTimer));
          title = `QUALIFYING • ${timeStr} · ${out} OUT · NEXT ${secs}s`;
        } else if(done < this.karts.length) {
          title = `QUALIFYING • ${timeStr} · ${out} ON TRACK · ${done}/${this.karts.length} PUSH DONE`;
        } else {
          title = `QUALIFYING • ${timeStr} · FIELD CIRCULATING`;
        }
      }
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(W/2 - 230, 2, 460, 28);
      ctx.strokeStyle = 'rgba(0,245,255,0.4)';
      ctx.strokeRect(W/2 - 230, 2, 460, 28);
      ctx.fillStyle = '#00f5ff';
      ctx.font = 'bold 12px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(title, W/2, 20);

      const order = this.karts
        .map((k, i) => ({i, t: (k.bestLap < Infinity ? k.bestLap : 9999)}))
        .sort((a, b) => a.t - b.t);
      const lbW = 240;
      const lbH = Math.min(10, this.karts.length) * 18 + 10;
      const lbX = W - lbW - 8;
      // Sit below top-right HUD / DEBUG·PERF so the 10-car board never covers them.
      const dbg = getDebugOverlayRect(W);
      const lbY = _showDebugOverlay ? (dbg.y + dbg.h + 8) : 118;
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(lbX, lbY, lbW, lbH);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.strokeRect(lbX, lbY, lbW, lbH);
      ctx.textAlign = 'left';
      ctx.font = '10px Nunito,sans-serif';
      order.slice(0, 10).forEach((row, r) => {
        const kart = this.karts[row.i];
        const y = lbY + 16 + r * 18;
        ctx.fillStyle = row.i === 0 ? '#00f5ff' : '#fff';
        ctx.fillText(`P${r+1} ${row.i===0?'YOU':`AI ${row.i}`}`, lbX + 8, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = kart.bestLap < Infinity ? '#ffd700' : 'rgba(255,255,255,0.45)';
        ctx.fillText(kart.bestLap < Infinity ? fmtTime(kart.bestLap) : '--:--.---', lbX + lbW - 8, y);
        ctx.textAlign = 'left';
      });
    }

    // Show launch bar during countdown AND the legacy launch phase
    if(this.phase === 'countdown' || this.phase === 'launch') {
      const rpmSlots = this.mode === 'versus' ? [0, 1]
        : this.mode === 'online' ? [Math.max(0, onlineCameraIndex())]
        : [0];
      const humanCount = rpmSlots.length;
      const barW = 320;
      const barH = 38;
      const goodL = 0.56, goodR = 0.76;
      const topY = this.phase === 'countdown' ? H - 130 : 58;
      const barPulse = 0.6 + 0.4 * Math.sin(performance.now() / 180);
      for(let si = 0; si < humanCount; si++) {
        const i = rpmSlots[si];
        const bx = humanCount === 1 ? W/2 - barW/2 : (si === 0 ? W/2 - barW - 14 : W/2 + 14);
        const by = topY;
        const rpm = Math.max(0, Math.min(1, this.launchRPM[i] || 0));
        const inGreen = rpm >= goodL && rpm <= goodR;
        const overRev  = rpm > 0.88;
        const bogZone  = rpm < 0.30;
        // Backdrop
        ctx.fillStyle = 'rgba(0,0,0,0.82)';
        ctx.fillRect(bx - 2, by - 28, barW + 4, barH + 34);
        ctx.strokeStyle = inGreen ? `rgba(60,255,120,${barPulse})` : 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 2;
        ctx.strokeRect(bx - 2, by - 28, barW + 4, barH + 34);
        // Zone labels above the bar
        ctx.font = '8px Nunito,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f87171'; ctx.fillText('BOG', bx + (barW-8)*0.15, by - 16);
        ctx.fillStyle = '#ffd700'; ctx.fillText('GOOD', bx + (barW-8)*0.46, by - 16);
        ctx.fillStyle = '#4ade80'; ctx.fillText('PERFECT', bx + (barW-8)*0.66, by - 16);
        ctx.fillStyle = '#f87171'; ctx.fillText('WHEELSPIN', bx + (barW-8)*0.92, by - 16);
        // Bar trough
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(bx + 4, by + 4, barW - 8, barH - 8);
        // Green zone highlight (pulsing)
        ctx.fillStyle = `rgba(60,220,120,${0.28 + 0.22 * barPulse})`;
        ctx.fillRect(bx + 4 + (barW-8)*goodL, by + 4, (barW-8)*(goodR-goodL), barH - 8);
        // RPM fill
        const rpmColor = overRev ? '#ff4444' : bogZone ? '#f97316' : inGreen ? '#4ade80' : '#00f5ff';
        ctx.fillStyle = rpmColor;
        ctx.fillRect(bx + 4, by + 4, (barW-8) * rpm, barH - 8);
        // Green zone border tick marks
        ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(bx + 4 + (barW-8)*goodL, by + 2); ctx.lineTo(bx + 4 + (barW-8)*goodL, by + barH - 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx + 4 + (barW-8)*goodR, by + 2); ctx.lineTo(bx + 4 + (barW-8)*goodR, by + barH - 2); ctx.stroke();
        // Status text
        const statusText = overRev ? 'WHEELSPIN — ease off!' : inGreen ? 'PERFECT — hold it!' : bogZone ? 'TOO LOW — more throttle' : 'GOOD — hold steady';
        ctx.fillStyle = inGreen ? '#4ade80' : overRev ? '#ff4444' : '#ffd700';
        ctx.font = `bold 10px Nunito,sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(statusText, bx + barW/2, by + barH + 12);
        // Player label
        ctx.fillStyle = si === 0 ? '#00f5ff' : '#ff6b35';
        ctx.font = 'bold 9px Nunito,sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`P${i+1} — BUILD REVS NOW`, bx, by - 28 + 10);
      }
      // Central instruction
      ctx.fillStyle = '#ffd700';
      ctx.textAlign = 'center';
      ctx.font = 'bold 13px Nunito,sans-serif';
      ctx.fillText('REV UP NOW — HIT GREEN BEFORE GO!', W/2, topY - 38);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    // Race master timer (single-player only) — left of the track-title ribbon.
    // Versus draws a timer under each viewport's debug/perf panel instead.
    if((this.phase==='racing'||this.phase==='finished') && this.mode !== 'versus') {
      const elapsed = this.raceTimer;
      const timerW = 130, timerH = 26;
      // Align with the lap panel row (pad 12, lapW 180 on desktop / 118 narrow).
      const lapWApprox = W < 700 ? 118 : 180;
      const timerX = 12 + lapWApprox + 10;
      const timerY = 12;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(timerX, timerY, timerW, timerH);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      ctx.strokeRect(timerX, timerY, timerW, timerH);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '13px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fmtTime(elapsed), timerX + timerW / 2, timerY + 18);
      ctx.textAlign = 'left';
    }

    if(this.launchFeedback) {
      const age = (performance.now() - this.launchFeedback.time) / 1000;
      if(age > 2.15) {
        this.launchFeedback = null;
      } else {
        const alpha = age < 0.25 ? age / 0.25 : Math.max(0, 1 - (age - 0.25) / 1.9);
        const rise = age < 0.45 ? (0.45 - age) * 42 : 0;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.fillStyle = 'rgba(0,0,0,0.76)';
        ctx.fillRect(W/2 - 180, H/2 - 164 - rise, 360, 62);
        ctx.strokeStyle = this.launchFeedback.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(W/2 - 180, H/2 - 164 - rise, 360, 62);
        ctx.fillStyle = this.launchFeedback.color;
        ctx.font = 'bold 26px Nunito,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(this.launchFeedback.label, W/2, H/2 - 130 - rise);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Nunito,sans-serif';
        ctx.fillText(this.launchFeedback.detail, W/2, H/2 - 110 - rise);
        ctx.textAlign = 'left';
        ctx.restore();
      }
    }

    // Rain visual overlay
    if(isWetWeather(this.weather)) {
      const rainCount = getQualityPreset().rainDrops;
      if(!this._rainDrops || this._rainDrops.length !== rainCount) {
        this._rainDrops = Array.from({length:rainCount}, () => ({
          x: Math.random()*W, y: Math.random()*H,
          len: 8+Math.random()*14, spd: 420+Math.random()*260
        }));
      }
      ctx.save();
      ctx.strokeStyle = this.weather === 'heavy' ? 'rgba(155,210,255,0.62)' : 'rgba(155,210,255,0.45)';
      ctx.lineWidth = 1;
      const dtR = 0.016;
      this._rainDrops.forEach(d => {
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.len*0.18, d.y + d.len);
        ctx.stroke();
        d.y += d.spd * dtR;
        d.x -= d.spd * 0.18 * dtR;
        if(d.y > H) { d.y = -20; d.x = Math.random()*W; }
        if(d.x < 0) { d.x = W; }
      });
      // Blue-grey tint
      ctx.fillStyle = 'rgba(40,60,100,0.12)';
      ctx.fillRect(0,0,W,H);
      // WET TRACK badge — sit clear of race timer / per-player HUD panels
      const versusHud = this.mode === 'versus';
      const wetW = 140, wetH = 22;
      const wetX = versusHud ? (W/2 - wetW/2) : (W/2 - wetW/2);
      const wetY = versusHud ? (H - 56) : 34;
      ctx.fillStyle = 'rgba(0,100,200,0.85)';
      ctx.fillRect(wetX, wetY, wetW, wetH);
      ctx.fillStyle = '#aaddff';
      ctx.font = 'bold 11px Nunito,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('WET TRACK', wetX + wetW/2, wetY + 16);
      ctx.textAlign = 'left';
      ctx.restore();
    }

    // FPS is drawn beside the track-name ribbon in drawHUD (single-player only).
    // Versus: no FPS badge — race timers sit under each debug/perf panel instead.
  }

  showResults() {
    // Stop the RAF loop and all audio before the ad / results screen
    if (animId) { cancelAnimationFrame(animId); animId = null; lastTime = null; }
    stopOnlineBgSim();
    stopAllEngines();
    stopAllDriftSnds();
    showTouchOverlay(false);
    updateRaceControlsHud(false);
    CG.gameplayStop(); // notify CrazyGames platform: gameplay ended

    canvas.style.display = 'none';
    applyPageBackground();
    document.getElementById('countdownOverlay').style.display = 'none';

    const resultsWrap = document.getElementById('results-wrap');
    resultsWrap.innerHTML = '';

    if(this.mode === 'trial') {
      const k = this.karts[0];
      const t = this.track;

      // Title
      document.getElementById('results-title').textContent = k.finished ? 'TIME TRIAL COMPLETE' : 'TIME TRIAL RESULTS';

      let html = `<div class="results-card">
        <div class="result-row"><span class="result-label">TRACK</span><span class="result-val cyan">${t.name}</span></div>
        <div class="result-row"><span class="result-label">LAPS COMPLETED</span><span class="result-val">${k.lapTimes.length}</span></div>`;

      k.lapTimes.forEach((lt, i) => {
        const isBest = lt === Math.min(...k.lapTimes);
        html += `<div class="result-row"><span class="result-label">LAP ${i+1}</span><span class="result-val ${isBest?'green':''}">${fmtTime(lt)}</span></div>`;
      });

      if(k.bestLap < Infinity) {
        const diff = k.bestLap - t.targetLap;
        html += `<div class="result-row"><span class="result-label">BEST LAP</span><span class="result-val ${diff<0?'green':'red'}">${fmtTime(k.bestLap)}</span></div>`;
        html += `<div class="result-row"><span class="result-label">TARGET</span><span class="result-val">${fmtTime(t.targetLap)}</span></div>`;
        html += `<div class="result-row"><span class="result-label">DIFF</span><span class="result-val ${diff<0?'green':'red'}">${diff<0?'':'+'} ${fmtTime(Math.abs(diff))}</span></div>`;
      }

      if(k.finished) {
        html += `<div class="result-row"><span class="result-label">TOTAL TIME</span><span class="result-val gold">${fmtTime(k.finishTime)}</span></div>`;
      }
      html += '</div>';

      if(k.finished && k.bestLap < t.targetLap) {
        html = `<div class="winner-banner"> TARGET BEATEN!</div>` + html;
        launchConfetti();
        CG.happytime();
      }

      resultsWrap.innerHTML = html;
      window._lastResult = {mode:'trial', trackId:t.id, trackName:t.name, bestLap:k.bestLap, total:k.finishTime||null, laps:k.lapTimes.length};
      const earned = awardCoins(window._lastResult);
      // Auto-save best lap to CG global leaderboard (no user action required)
      if (k.bestLap < Infinity) {
        const minPossible = t.lapDistance ? t.lapDistance / 640 : 8;
        if (k.bestLap >= minPossible) CG.saveScore(`track_${t.id}_lap`, Math.round(k.bestLap * 1000));
      }
      document.getElementById('coins-earned-display').innerHTML = earned>0 ? `<div class="coins-earn">COINS +${earned} COINS EARNED!</div>` : '';

    } else if(this.mode === 'ai') {
      const k = this.karts[0];
      const t = this.track;
      const diff = this.aiDifficulty || 'medium';
      const diffLabel = {ultraeasy:'ULTRA EASY', easy:'EASY', medium:'MEDIUM', hard:'HARD', extreme:'EXTREME'}[diff] || diff.toUpperCase();
      const diffMultMap2 = {ultraeasy:0.75, easy:1.0, medium:1.25, hard:1.5, extreme:2.0};
      const diffCoinMult = diffMultMap2[diff] || 1.0;
      document.getElementById('results-title').textContent = 'AI RACE RESULTS';

      const rankings = buildRaceRankings(this.karts, t);
      const humanRank = rankings.findIndex(r=>r.i===0) + 1;

      if(humanRank === 1) {
        resultsWrap.innerHTML = `<div class="winner-banner"> YOU WIN!</div>`;
        launchConfetti();
        CG.happytime();
      } else {
        resultsWrap.innerHTML = `<div class="winner-banner" style="color:#ff6b35;border-color:#ff6b35;">P${humanRank} / ${this.karts.length} — KEEP TRYING!</div>`;
      }

      let html = `<div class="results-card">
        <div class="result-row"><span class="result-label">TRACK</span><span class="result-val cyan">${t.name}</span></div>
        <div class="result-row"><span class="result-label">DIFFICULTY</span><span class="result-val">${diffLabel}</span></div>
        <div class="result-row"><span class="result-label">COIN MULTIPLIER</span><span class="result-val ${diffCoinMult >= 1.5 ? 'green' : diffCoinMult < 1.0 ? 'red' : ''}">x${diffCoinMult} FROM DIFFICULTY</span></div>
        <div class="result-row"><span class="result-label">YOUR POSITION</span><span class="result-val ${humanRank===1?'green':humanRank<=2?'gold':'red'}">P${humanRank} / ${this.karts.length}</span></div>`;
      if(k.bestLap < Infinity) html += `<div class="result-row"><span class="result-label">YOUR BEST LAP</span><span class="result-val gold">${fmtTime(k.bestLap)}</span></div>`;
      if(k.finished) html += `<div class="result-row"><span class="result-label">YOUR TOTAL</span><span class="result-val gold">${fmtTime(k.finishTime)}</span></div>`;
      html += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1);font-family:Nunito,sans-serif;font-size:9px;color:rgba(255,255,255,.3);letter-spacing:.1em;">FULL LEADERBOARD</div>';
      rankings.forEach((r, rank)=>{
        const isHuman = r.i === 0;
        const name = isHuman ? 'YOU' : `AI ${r.i}`;
        const col = isHuman ? '#00f5ff' : (rank===0?'#ffd700':'rgba(255,255,255,.6)');
        const timeStr = isKartRankedFinished(r.kart) ? fmtTime(r.kart.finishTime) : 'DNF';
        html += `<div class="result-row"><span class="result-label" style="color:${col}">P${rank+1} ${name}</span><span class="result-val">${timeStr}</span></div>`;
      });
      html += '</div>';
      resultsWrap.innerHTML += html;
      window._lastResult = {mode:'trial', trackId:t.id, trackName:t.name, bestLap:k.bestLap, total:k.finishTime||null, laps:k.lapTimes.length, aiDiff: this.aiDifficulty};
      const earnedAI = awardCoins(window._lastResult);
      // Auto-save best lap to CG global leaderboard
      if (k.bestLap < Infinity) {
        const minPossible = t.lapDistance ? t.lapDistance / 640 : 8;
        if (k.bestLap >= minPossible) CG.saveScore(`track_${t.id}_lap`, Math.round(k.bestLap * 1000));
      }
      document.getElementById('coins-earned-display').innerHTML = earnedAI>0 ? `<div class="coins-earn">COINS +${earnedAI} COINS EARNED!</div>` : '';

    } else if(this.mode === 'shootout') {
      const t = this.track;
      const pLap = this.shootoutPlayerLap;
      const aLap = this.shootoutAiLap;
      const playerWon = pLap < aLap;
      const diff = Math.abs(pLap - aLap);
      const diffLabel = {ultraeasy:'ULTRA EASY', easy:'EASY', medium:'MEDIUM', hard:'HARD', extreme:'EXTREME'}[this.shootoutDifficulty] || (this.shootoutDifficulty||'MEDIUM').toUpperCase();

      document.getElementById('results-title').textContent = 'ONE LAP SHOOTOUT RESULTS';
      if(playerWon) {
        resultsWrap.innerHTML = `<div class="winner-banner"> YOU WIN!</div>`;
        launchConfetti();
        CG.happytime();
      } else {
        resultsWrap.innerHTML = `<div class="winner-banner" style="color:#ff6b35;border-color:#ff6b35;"> AI WINS</div>`;
      }

      let html = `<div class="results-card">
        <div class="result-row"><span class="result-label">TRACK</span><span class="result-val cyan">${t.name}</span></div>
        <div class="result-row"><span class="result-label">DIFFICULTY</span><span class="result-val">${diffLabel}</span></div>
        <div class="result-row"><span class="result-label">YOUR LAP</span><span class="result-val gold">${pLap < Infinity ? fmtTime(pLap) : 'DNF'}</span></div>
        <div class="result-row"><span class="result-label">AI LAP</span><span class="result-val cyan">${aLap < Infinity ? fmtTime(aLap) : 'DNF'}</span></div>
        <div class="result-row"><span class="result-label">GAP</span><span class="result-val ${playerWon?'green':'red'}">${playerWon?'-':'+'}${fmtTime(diff)}</span></div>
      </div>`;
      resultsWrap.innerHTML += html;

      window._lastResult = {
        mode:'shootout',
        trackId:t.id,
        trackName:t.name,
        bestLap:pLap,
        aiLap:aLap,
        aiDiff:this.shootoutDifficulty,
        win:playerWon,
        laps:1,
        total:pLap
      };
      const earnedS = awardCoins(window._lastResult);
      document.getElementById('coins-earned-display').innerHTML = earnedS>0 ? `<div class="coins-earn">COINS +${earnedS} COINS EARNED!</div>` : '';

    } else if(this.mode === 'online') {
      const t = this.track;
      const localIdx = onlineCameraIndex();
      const k = this.karts[localIdx] || this.karts[0];
      document.getElementById('results-title').textContent = 'ONLINE RACE RESULTS';
      const rankings = buildRaceRankings(this.karts, t);
      const humanRank = rankings.findIndex(r=>r.i===localIdx) + 1;
      if(humanRank === 1) {
        resultsWrap.innerHTML = `<div class="winner-banner"> YOU WIN!</div>`;
        launchConfetti();
        CG.happytime();
        try { showLbToast('WIN RECORDED'); } catch(e) {}
      } else {
        resultsWrap.innerHTML = `<div class="winner-banner" style="color:#ff6b35;border-color:#ff6b35;">P${humanRank} / ${this.karts.length}</div>`;
      }
      let html = `<div class="results-card">
        <div class="result-row"><span class="result-label">TRACK</span><span class="result-val cyan">${t.name}</span></div>
        <div class="result-row"><span class="result-label">YOUR POSITION</span><span class="result-val ${humanRank===1?'green':humanRank<=2?'gold':'red'}">P${humanRank} / ${this.karts.length}</span></div>`;
      if(k.bestLap < Infinity) html += `<div class="result-row"><span class="result-label">YOUR BEST LAP</span><span class="result-val gold">${fmtTime(k.bestLap)}</span></div>`;
      if(k.finished && k.finishTime != null) html += `<div class="result-row"><span class="result-label">YOUR TOTAL</span><span class="result-val gold">${fmtTime(k.finishTime)}</span></div>`;
      html += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.1);font-family:Nunito,sans-serif;font-size:9px;color:rgba(255,255,255,.3);letter-spacing:.1em;">FULL LEADERBOARD</div>';
      rankings.forEach((r, rank)=>{
        const isYou = r.i === localIdx;
        const name = isYou ? 'YOU' : (r.kart.onlineName || ('P'+(r.i+1)));
        const col = isYou ? '#00f5ff' : (rank===0?'#ffd700':'rgba(255,255,255,.6)');
        const timeStr = isKartRankedFinished(r.kart) ? fmtTime(r.kart.finishTime) : 'DNF';
        html += `<div class="result-row"><span class="result-label" style="color:${col}">P${rank+1} ${name}</span><span class="result-val">${timeStr}</span></div>`;
      });
      html += '</div>';
      resultsWrap.innerHTML += html;
      window._lastResult = {mode:'online', trackId:t.id, trackName:t.name, bestLap:k.bestLap, total:k.finishTime||null, laps:k.lapTimes.length};
      document.getElementById('coins-earned-display').innerHTML = '';
      try {
        const sess = getOnlineSession();
        if(sess && sess.isHost()) sess.notifyRaceEnded();
      } catch(e) {}

    } else {
      const [k1, k2] = this.karts;
      const t = this.track;
      document.getElementById('results-title').textContent = 'VERSUS RESULTS';

      let winner = null;
      if(k1.finished && !k2.finished) winner = 0;
      else if(k2.finished && !k1.finished) winner = 1;
      else if(k1.finished && k2.finished) {
        const cmp = compareKartRacePosition(k1, k2, t);
        winner = cmp < 0 ? 0 : cmp > 0 ? 1 : null;
      } else {
        // Neither finished - more laps wins; else best lap
        if(k1.lap !== k2.lap) winner = k1.lap > k2.lap ? 0 : 1;
        else winner = k1.bestLap <= k2.bestLap ? 0 : 1;
      }

      if(winner !== null) {
        resultsWrap.innerHTML = `<div class="winner-banner"> PLAYER ${winner+1} WINS!</div>`;
        launchConfetti();
        CG.happytime();
      } else {
        resultsWrap.innerHTML = `<div class="winner-banner" style="color:#00f5ff;border-color:#00f5ff;"> IT'S A TIE!</div>`;
        launchConfetti();
      }

      const makeCard = (kart, idx) => {
        const color = idx===0?'#00f5ff':'#ff6b35';
        let html = `<div class="results-card" style="border-color:${color}33;background:${color}08">
          <div class="result-row"><span class="result-label" style="color:${color}">PLAYER ${idx+1}</span><span class="result-val cyan">${idx===0?'WASD':'ARROWS'}</span></div>
          <div class="result-row"><span class="result-label">LAPS DONE</span><span class="result-val">${kart.lapTimes.length}/${this.lapCount}</span></div>`;
        kart.lapTimes.forEach((lt,i)=>{
          const isBest = lt===Math.min(...kart.lapTimes);
          html += `<div class="result-row"><span class="result-label">LAP ${i+1}</span><span class="result-val ${isBest?'green':''}">${fmtTime(lt)}</span></div>`;
        });
        html += `<div class="result-row"><span class="result-label">BEST LAP</span><span class="result-val gold">${kart.bestLap<Infinity?fmtTime(kart.bestLap):'---'}</span></div>`;
        if(kart.finished) html += `<div class="result-row"><span class="result-label">TOTAL</span><span class="result-val gold">${fmtTime(kart.finishTime)}</span></div>`;
        html += '</div>';
        return html;
      };

      resultsWrap.innerHTML += makeCard(k1,0) + makeCard(k2,1);
      window._lastResult = {
        mode:'versus', trackId:t.id, trackName:t.name,
        p1Best:k1.bestLap, p2Best:k2.bestLap,
        winner:winner, p1Total:k1.finishTime, p2Total:k2.finishTime
      };
      const earnedV = awardCoins(window._lastResult);
      document.getElementById('coins-earned-display').innerHTML = earnedV>0 ? `<div class="coins-earn">COINS +${earnedV} COINS EARNED!</div>` : '';
    }

    // Show mid-roll ad then reveal the results screen
    CG.requestMidroll(() => {
      document.getElementById('screen-results').classList.remove('hidden');
    });
  }
}

// ── COUNTDOWN DISPLAY ───────────────────────────────────
function showCountdown(n) {
  const overlay = document.getElementById('countdownOverlay');
  resizeCanvas();
  overlay.style.display = 'flex';
  ['cd3','cd2','cd1','cd0'].forEach(id => {
    const el = document.getElementById(id);
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%,-50%) scale(2)';
    el.style.transition = 'none';
  });

  // FTUE hint: show during 3-2-1 for first 3 races, hide after GO!
  const ftueEl = document.getElementById('ftue-hint');
  if (ftueEl) {
    if (n === 3 && getRaceCount() <= 3) {
      if (touchMode) {
        document.getElementById('ftue-hint-text').innerHTML =
          `JOYSTICK: steer · throttle/brake &nbsp;&nbsp;|&nbsp;&nbsp; ERS · DRS · PIT on the right &nbsp;&nbsp;|&nbsp;&nbsp; PAUSE (top-right)`;
      } else {
        const ersKey = keyLabel(BINDINGS.p1.ers).toUpperCase();
        const drsKey = keyLabel(BINDINGS.p1.drs).toUpperCase();
        const pitKey = keyLabel(BINDINGS.p1.pit).toUpperCase();
        document.getElementById('ftue-hint-text').innerHTML =
          `ERS [${ersKey}]: +25% boost · regen on brake/lift &nbsp;&nbsp;|&nbsp;&nbsp; DRS [${drsKey}]: +15% in blue zones &nbsp;&nbsp;|&nbsp;&nbsp; PIT [${pitKey}]: near garage`;
      }
      ftueEl.style.display = 'block';
    } else if (n < 0) {
      setTimeout(() => { if (ftueEl) ftueEl.style.display = 'none'; }, 1600);
    }
  }

  if(n < 0) {
    const el = document.getElementById('cd0');
    el.style.opacity = '1'; el.style.transform = 'translate(-50%,-50%) scale(1)';
    void el.offsetWidth;
    el.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    setTimeout(()=>{el.style.opacity='0';el.style.transform='translate(-50%,-50%) scale(0.5)';overlay.style.display='none';},600);
    playCountdownBeep(0);
  } else {
    const el = document.getElementById('cd'+n);
    el.style.opacity = '1'; el.style.transform = 'translate(-50%,-50%) scale(1)';
    void el.offsetWidth;
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    playCountdownBeep(n);
  }
}
function playCountdownBeep(n) {
  initAudio();
  if(n===0) playGo();
  else beep(440+n*55,0.15,0.5,'square');
}

// ── PAUSE ─────────────────────────────────────────────
let isPaused = false;
function updateRaceControlsHud(visible) {
  const hud = document.getElementById('race-controls-hud');
  if (!hud) return;
  if (!visible || !race || isPaused) {
    hud.style.display = 'none';
    return;
  }
  const pausable = ['racing', 'countdown', 'qualifying', 'quali-turn', 'launch'];
  if (!pausable.includes(race.phase)) {
    hud.style.display = 'none';
    return;
  }
  const exitBtn = document.getElementById('race-ctrl-exit');
  if (exitBtn) {
    if (race.mode === 'trial') exitBtn.textContent = 'EXIT';
    else if (race.mode === 'online') exitBtn.textContent = 'LEAVE';
    else exitBtn.textContent = 'EXIT';
  }
  hud.style.display = 'flex';
}
function pauseGame() {
  if (!race || isPaused) return;
  const pausable = ['racing', 'countdown', 'qualifying', 'quali-turn', 'launch'];
  if (!pausable.includes(race.phase)) return;
  isPaused = true;
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  setAdMuted(true);
  const po = document.getElementById('pause-overlay');
  if (po) po.style.display = 'flex';
  const quitBtn = document.getElementById('pause-quit-btn');
  const restartBtn = po && po.querySelector('.btn-gold');
  if (quitBtn) {
    if (race.mode === 'trial') quitBtn.textContent = 'END SESSION';
    else if (race.mode === 'online') quitBtn.textContent = 'LEAVE RACE';
    else quitBtn.textContent = 'QUIT TO MENU';
  }
  const mlExportBtn = document.getElementById('pause-export-ml-btn');
  if (mlExportBtn) {
    const pk = race.karts && race.karts[0];
    const n = pk && pk._mlDemoFrames ? pk._mlDemoFrames.length : 0;
    mlExportBtn.style.display = (race.mode === 'trial' && n > 60) ? 'inline-block' : 'none';
  }
  if (restartBtn) {
    if (race.mode === 'trial') restartBtn.textContent = 'RESTART SESSION';
    else if (race.mode === 'online') restartBtn.textContent = 'BACK TO LOBBY';
    else restartBtn.textContent = 'RESTART RACE';
  }
  updateRaceControlsHud(false);
  const pitUi = document.getElementById('pit-ui-overlay');
  if(pitUi) { pitUi.style.display = 'none'; pitUi.dataset.signature = ''; clearPitUiLayoutClasses(pitUi); }
  showTouchOverlay(false);
  updateLandscapeHint(false);
}
function resumeGame() {
  if (!isPaused) return;
  isPaused = false;
  const po = document.getElementById('pause-overlay');
  if (po) po.style.display = 'none';
  setAdMuted(false);
  resumeAudioContextIfNeeded();
  showTouchOverlay(true);
  updateRaceControlsHud(true);
  lastTime = null;
  animId = requestAnimationFrame(gameLoop);
}
function pauseRestartRace() {
  isPaused = false;
  const po = document.getElementById('pause-overlay');
  if (po) po.style.display = 'none';
  setAdMuted(false);
  restartRace();
}
function teardownRaceUI() {
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  isPaused = false;
  lastTime = null;
  stopOnlineBgSim();
  stopAllEngines();
  stopAllDriftSnds();
  setAdMuted(false);
  const po = document.getElementById('pause-overlay');
  if (po) po.style.display = 'none';
  const pit = document.getElementById('pit-ui-overlay');
  if (pit) { pit.style.display = 'none'; pit.dataset.signature = ''; }
  const cd = document.getElementById('countdownOverlay');
  if (cd) cd.style.display = 'none';
  const ad = document.getElementById('ad-block-overlay');
  if (ad) ad.style.display = 'none';
  canvas.style.display = 'none';
  applyPageBackground();
  showTouchOverlay(false);
  updateRaceControlsHud(false);
}

function pauseQuit() {
  // Time Trial has no fixed distance — ending the session shows results.
  if(race && race.mode === 'trial' && typeof race.showResults === 'function') {
    isPaused = false;
    const po = document.getElementById('pause-overlay');
    if (po) po.style.display = 'none';
    setAdMuted(false);
    race.phase = 'finished';
    race.showResults();
    return;
  }
  const wasOnline = race && race.mode === 'online';
  teardownRaceUI();
  race = null;
  CG.gameplayStop();
  if(wasOnline) {
    const sess = getOnlineSession();
    if(sess && sess.isHost()) sess.returnLobby();
    if(sess && sess.isActive()) { showScreen('online'); refreshOnlineLobbyUI(); return; }
  }
  showScreen('menu');
}

function returnToMainMenu() {
  const wasOnline = race && race.mode === 'online';
  teardownRaceUI();
  race = null;
  CG.gameplayStop();
  window._onlineRaceConfig = null;
  if(wasOnline) {
    const sess = getOnlineSession();
    if(sess && sess.isHost()) {
      try { sess.notifyRaceEnded(); } catch(e) {}
    }
    if(sess && sess.isActive()) {
      showScreen('online');
      refreshOnlineLobbyUI();
      return;
    }
  }
  showScreen('menu');
}

// ── GAME LOOP ───────────────────────────────────────────
let _onlineBgTimer = null;

function isOnlineHostSim() {
  // Physics authority lives on the Cloudflare Durable Object — browsers never host-sim.
  return false;
}

function stopOnlineBgSim() {
  if(_onlineBgTimer) {
    clearInterval(_onlineBgTimer);
    _onlineBgTimer = null;
  }
}

function startOnlineBgSim() {
  // No-op: server authority does not need a browser background physics loop.
}

function syncOnlineBgSim() {
  stopOnlineBgSim();
  if(race && !animId && !isPaused) {
    lastTime = performance.now();
    animId = requestAnimationFrame(gameLoop);
  }
}

function stepOnlineSim(dt, sess) {
  race.karts.forEach(function(k) {
    if(!k.onlineConnId) return;
    const stillHere = (sess.players || []).some(function(p) { return p.id === k.onlineConnId; });
    if(!stillHere) {
      k._onlineDisconnected = true;
      sess.remoteInputs[k.onlineConnId] = window.OnlineNet.emptyInput();
    }
  });
  race.update(dt);
}

function advanceRace(now, opts) {
  opts = opts || {};
  const doRender = opts.render !== false;
  const catchUp = !!opts.catchUp;
  if(!lastTime) lastTime = now;
  let elapsed = Math.max(0, (now - lastTime) / 1000);
  lastTime = now;

  const sess = (window.OnlineNet && window.OnlineNet.session) || null;
  const onlineRacing = !!(sess && sess.phase === 'racing' && race && race.mode === 'online');
  const maxCatch = (onlineRacing && catchUp) ? 1.0 : 0.05;
  elapsed = Math.min(elapsed, maxCatch);

  _fpsFrames++;
  _fpsTimer += elapsed;
  if(_fpsTimer >= 0.5) {
    _fpsDisplay = Math.round(_fpsFrames / _fpsTimer);
    _fpsFrames = 0; _fpsTimer = 0;
  }

  if(!race) return;

  if(onlineRacing) {
    // Inputs → interp remotes → predict local (shared sim) → reconcile
    sess.tickNet(elapsed);
    const localIdx = onlineCameraIndex();
    const localKart = race.karts[localIdx];
    const Sim = window.OnlineSim;
    ensureOnlineLocalSim(race, localIdx);
    sess.interpolateRemoteKarts(race, Date.now());

    if(race.phase === 'racing' && localKart && !localKart.finished && race._onlineLocalSim && Sim) {
      const fixed = Sim.FIXED_DT || (1 / 60);
      let left = elapsed;
      const collideOn = (race.collisionMode || 'collision') !== 'nocollision';
      const remotes = [];
      for(let ri = 0; ri < race.karts.length; ri++) {
        if(ri === localIdx) continue;
        const rk = race.karts[ri];
        if(!rk || !isFinite(rk.x)) continue;
        remotes.push({ id: ri, x: rk.x, y: rk.y, angle: rk.angle, speed: rk.speed, finished: !!rk.finished });
      }
      const inp = (typeof sess.getPredictInput === 'function')
        ? sess.getPredictInput()
        : ((typeof getP1Input === 'function')
          ? { up:!!getP1Input().up, down:!!getP1Input().down, left:!!getP1Input().left, right:!!getP1Input().right,
              ers:!!getP1Input().ers, drs:!!getP1Input().drs,
              steer: typeof getP1Input().steer === 'number' ? getP1Input().steer : 0,
              throttle: typeof getP1Input().throttle === 'number' ? getP1Input().throttle : (getP1Input().up ? 1 : 0),
              brake: typeof getP1Input().brake === 'number' ? getP1Input().brake : (getP1Input().down ? 1 : 0) }
          : { up:false, down:false, left:false, right:false, ers:false, drs:false, steer:0, throttle:0, brake:0 });
      let predSteps = 0;
      while(left > 0.0005) {
        const d = Math.min(fixed, left);
        const cars = [race._onlineLocalSim].concat(remotes);
        Sim.stepKart(race._onlineLocalSim, inp, d, race._onlineSimTrack || race.track, cars, {
          contact: collideOn,
          resolveCollisions: collideOn,
          nowMs: race._onlineLocalSim.simTimeMs + d * 1000
        });
        left -= d;
        predSteps++;
        if(predSteps >= 8) break;
      }
      localKart.x = race._onlineLocalSim.x;
      localKart.y = race._onlineLocalSim.y;
      localKart.angle = race._onlineLocalSim.angle;
      localKart.speed = race._onlineLocalSim.speed;
      localKart.ersCharge = race._onlineLocalSim.ersCharge;
      localKart.ersActive = race._onlineLocalSim.ersActive;
      localKart.drsActive = race._onlineLocalSim.drsActive;
      localKart.tyreWear = race._onlineLocalSim.tyreWear;
      if(typeof race._onlineLocalSim.tyreTemp === 'number') localKart.tyreTemp = race._onlineLocalSim.tyreTemp;
      syncOnlineOffTrackFromSim(localKart, race._onlineLocalSim);
    } else if(race.phase === 'racing' && localKart && !localKart.finished && !Sim) {
      // Shared sim required for online — do not fall back to HTML Kart physics
      if(!race._onlineSimMissingWarned) {
        race._onlineSimMissingWarned = true;
        console.error('OnlineSim missing — online prediction disabled');
        const el = document.getElementById('online-status');
        if(el) { el.textContent = 'online-sim.js failed to load — hard refresh'; el.classList.add('err'); }
      }
    } else if((race.phase === 'countdown' || race.phase === 'launch') && localKart && race.launchRPM) {
      const inp = (typeof getP1Input === 'function') ? getP1Input() : { up: false, down: false };
      let rpm = race.launchRPM[localIdx] || 0;
      if(inp.up) rpm += 1.15 * elapsed;
      else rpm -= 0.55 * elapsed;
      if(inp.down) rpm -= 0.75 * elapsed;
      race.launchRPM[localIdx] = Math.max(0, Math.min(1, rpm));
    }
    sess.reconcileLocalKart(race, elapsed);
    if(localKart && (!isFinite(localKart.x) || !isFinite(localKart.y))) {
      const snapKart = sess.latestState && sess.latestState.karts && sess.latestState.karts[localIdx];
      if(snapKart && isFinite(snapKart.x) && isFinite(snapKart.y)) {
        localKart.x = snapKart.x;
        localKart.y = snapKart.y;
        localKart.angle = snapKart.angle;
        localKart.speed = snapKart.speed;
      } else if(race.track && race.track.startPos) {
        localKart.x = race.track.startPos.x;
        localKart.y = race.track.startPos.y;
      }
    }
    if(typeof sess.smoothOnlineDisplay === 'function') sess.smoothOnlineDisplay(race, elapsed);
    if(typeof race.updateCamera === 'function') race.updateCamera(localIdx, elapsed);
    if(race.phase === 'finished') {
      race.finishedTimer = (race.finishedTimer || 0) + elapsed;
      if(race.finishedTimer > 2.2 && !race.resultsShown) {
        race.resultsShown = true;
        race.showResults();
      }
    }
    const prevPhase = race._guestShownPhase;
    if(race.phase === 'countdown' && race.countdownVal > 0 && race._lastOnlineCd !== race.countdownVal) {
      showCountdown(race.countdownVal);
      race._lastOnlineCd = race.countdownVal;
    }
    if(race.phase === 'racing' && prevPhase !== 'racing' && prevPhase !== 'finished') {
      showCountdown(-1);
      if(!race._onlineGuestEngines) {
        race._onlineGuestEngines = true;
        try { startEngine(localIdx); } catch(e) {}
        for(let ei = 0; ei < race.karts.length; ei++) {
          if(ei === localIdx) continue;
          try { startEngine(ei); } catch(e2) {}
        }
      }
    }
    race._guestShownPhase = race.phase;
    const overlay = document.getElementById('countdownOverlay');
    if(race.phase === 'countdown' || race.phase === 'launch') {
      if(overlay && overlay.style.display !== 'flex') overlay.style.display = 'flex';
    } else if(race.phase === 'racing' || race.phase === 'finished') {
      if(overlay) overlay.style.display = 'none';
    }
    if(sess.netDebug) drawOnlineNetDebug(sess);
  } else if(race && race.mode === 'online') {
    // Server already returned lobby (or session idle) but results screen may still be up —
    // never fall through into offline race.update (would desync leftover karts).
    if(typeof race.updateCamera === 'function') {
      race.updateCamera(onlineCameraIndex(), elapsed);
    }
    if(sess && sess.netDebug) drawOnlineNetDebug(sess);
  } else {
    race.update(elapsed);
  }
  if(doRender) {
    race.render();
    syncPitSelectionOverlay();
  }
}

function drawOnlineNetDebug(sess) {
  try {
    const d = sess.getNetDebug && sess.getNetDebug();
    if(!d) return;
    ctx.save();
    ctx.font = '12px monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, 8, 248, 92);
    ctx.fillStyle = '#7dffb3';
    ctx.textAlign = 'left';
    ctx.fillText('NET delay ' + d.delay + 'ms  jit ' + d.jitter + 'ms', 14, 26);
    ctx.fillText((d.extrapolating ? 'EXTRAP ' + d.extrapMs + 'ms' : 'interp') + '  snaps ' + d.snaps, 14, 44);
    ctx.fillText('↓' + d.bytesIn + 'B/s  ↑' + d.bytesOut + 'B/s', 14, 62);
    ctx.fillText('corr ' + d.corrErr + '  disp ' + (d.dispErr != null ? d.dispErr : 0) + '  underrun ' + d.underruns, 14, 80);
    ctx.restore();
  } catch(e) {}
}

function gameLoop(ts) {
  advanceRace(ts, { render: true, catchUp: false });
  if(!document.hidden) animId = requestAnimationFrame(gameLoop);
  else animId = null;
}

function startGameLoop() {
  stopOnlineBgSim();
  if(animId) cancelAnimationFrame(animId);
  lastTime = null;
  animId = requestAnimationFrame(gameLoop);
  syncOnlineBgSim();
}

document.addEventListener('visibilitychange', function() {
  if(document.hidden) {
    if(animId) { cancelAnimationFrame(animId); animId = null; }
    return;
  }
  if(race && !isPaused && !animId) {
    lastTime = null;
    animId = requestAnimationFrame(gameLoop);
  }
});

// ── TRACK THUMBNAILS ────────────────────────────────────
function renderThumbnail(trackIdx) {
  const t = TRACKS[trackIdx];
  const spl = t.spline;
  const c = document.createElement('canvas');
  c.width = 210; c.height = 128;
  const cx = c.getContext('2d');

  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  spl.forEach(p=>{minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);});
  const pad=12;
  const scX=(c.width-pad*2)/(maxX-minX), scY=(c.height-pad*2)/(maxY-minY), sc=Math.min(scX,scY);
  const ofx=pad+(c.width-pad*2-(maxX-minX)*sc)/2-minX*sc;
  const ofy=pad+(c.height-pad*2-(maxY-minY)*sc)/2-minY*sc;

  cx.fillStyle = t.bgColor; cx.fillRect(0,0,c.width,c.height);
  cx.fillStyle = t.grassColor; cx.fillRect(0,0,c.width,c.height);

  cx.beginPath();
  cx.moveTo(spl[0].x*sc+ofx, spl[0].y*sc+ofy);
  spl.forEach(p=>cx.lineTo(p.x*sc+ofx, p.y*sc+ofy));
  cx.closePath();
  cx.strokeStyle = t.borderColor; cx.lineWidth = t.trackWidth*sc+3;
  cx.lineCap='round'; cx.lineJoin='round';
  cx.globalAlpha=0.5; cx.stroke(); cx.globalAlpha=1;

  cx.beginPath();
  cx.moveTo(spl[0].x*sc+ofx, spl[0].y*sc+ofy);
  spl.forEach(p=>cx.lineTo(p.x*sc+ofx, p.y*sc+ofy));
  cx.closePath();
  cx.strokeStyle = t.trackColor; cx.lineWidth = t.trackWidth*sc;
  cx.stroke();

  cx.setLineDash([4,3]);
  cx.strokeStyle='rgba(255,255,255,0.2)'; cx.lineWidth=1.5;
  cx.beginPath();
  cx.moveTo(spl[0].x*sc+ofx, spl[0].y*sc+ofy);
  spl.forEach(p=>cx.lineTo(p.x*sc+ofx, p.y*sc+ofy));
  cx.closePath(); cx.stroke(); cx.setLineDash([]);

  // Start line
  const sf = t.cpLines[0];
  cx.save();
  cx.translate(sf.cx*sc+ofx, sf.cy*sc+ofy);
  const sfAng = Math.atan2(sf.y2-sf.y1, sf.x2-sf.x1);
  cx.rotate(sfAng);
  const hw = Math.hypot(sf.x2-sf.x1,sf.y2-sf.y1)*sc/2;
  const sq=5;
  for(let ci=0; ci<hw*2/sq+1; ci++) for(let ri=0;ri<2;ri++){
    cx.fillStyle=(ci+ri)%2===0?'#fff':'#000';
    cx.fillRect(ci*sq-hw,ri*sq-sq,sq,sq);
  }
  cx.restore();

  // Grid slots preview
  if(t.gridSlots && t.gridSlots.length) {
    t.gridSlots.slice(0, 10).forEach((slot, idx) => {
      const sx = slot.x * sc + ofx;
      const sy = slot.y * sc + ofy;
      const angle = slot.a || 0;
      const bodyColor = idx === 0 ? '#00f5ff' : idx === 1 ? '#ff6b35' : 'rgba(255,255,255,0.72)';
      cx.save();
      cx.translate(sx, sy);
      cx.rotate(angle);
      cx.fillStyle = bodyColor;
      cx.globalAlpha = idx < 2 ? 0.95 : 0.70;
      cx.fillRect(-4, -2, 8, 4);
      cx.strokeStyle = 'rgba(0,0,0,0.65)';
      cx.lineWidth = 1;
      cx.strokeRect(-4, -2, 8, 4);
      cx.restore();
    });
  }

  // Name ribbon overlay so the preview always carries the circuit name
  cx.fillStyle = 'rgba(0,0,0,0.62)';
  cx.fillRect(8, 8, c.width - 16, 18);
  cx.strokeStyle = t.borderColor + '88';
  cx.lineWidth = 1;
  cx.strokeRect(8, 8, c.width - 16, 18);
  cx.fillStyle = t.borderColor;
  cx.font = 'bold 10px Nunito,sans-serif';
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.fillText(t.name, c.width / 2, 17);
  cx.textAlign = 'left';
  cx.textBaseline = 'alphabetic';

  return c.toDataURL();
}

// ── TRACK SELECT SCREEN ─────────────────────────────────
function buildTrackGrid() {
  const grid = document.getElementById('track-grid');
  grid.innerHTML = '';
  const pd = getPlayerData();
  const unlocked = pd.unlockedTracks || DEFAULT_UNLOCKED_TRACKS;
  TRACKS.forEach((t, i) => {
    const thumb = renderThumbnail(i);
    const isLocked = t.locked && !unlocked.includes(t.id);
    const el = document.createElement('div');
    el.className = `track-card ${t.diffLetter}`;
    el.style.cursor = isLocked ? 'default' : 'pointer';
    const mult = t.coinMult ? `${t.coinMult}x` : '1x';
    el.innerHTML = `
      <img class="track-preview" src="${thumb}" alt="${t.name}">
      <div class="track-info">
        <div class="track-name" style="color:${t.borderColor}">${t.name}</div>
        <div class="track-diff ${t.diffClass}">● ${t.difficulty} &nbsp; ${mult} COINS</div>
        <div class="track-target">TARGET: ${fmtTime(t.targetLap)} / LAP</div>
      </div>
      ${isLocked ? `<div class="locked-overlay">
        <div style="font-size:22px;font-family:Nunito,sans-serif;font-weight:900;letter-spacing:.12em;">LOCKED</div>
        <div style="font-family:Nunito,sans-serif;font-size:10px;letter-spacing:.1em;color:#ffd700;">REQUIRES COINS ${t.unlockCost}</div>
        <div style="font-size:9px;margin-top:3px;color:${pd.coins>=t.unlockCost?'#4ade80':'#f87171'};">${pd.coins>=t.unlockCost?'YOU CAN UNLOCK THIS!':'NEED '+(t.unlockCost-pd.coins)+' MORE COINS'}</div>
        <button class="btn btn-sm ${pd.coins>=t.unlockCost?'btn-gold':'btn-pink'}" onclick="event.stopPropagation();unlockTrack(${t.id})" style="font-size:9px;padding:5px 12px;margin-top:5px;">${pd.coins>=t.unlockCost?'UNLOCK NOW':'UNLOCK'}</button>
      </div>` : ''}`;
    if(!isLocked) el.onclick = () => selectTrack(i);
    grid.appendChild(el);
  });
}

// ── NAVIGATION ──────────────────────────────────────────
let currentMode = 'trial';
let raceQualiEnabled = false;
let raceQualiSessionMin = 4;
let raceQualiLaps = 3;

function goBackFromTrack() {
  initAudio();
  playUIClick();
  if (currentMode === 'trial') showScreen('menu');
  else showScreen('mode');
}

function selectMode(m) {
  currentMode = m;
  initAudio();
  if(m === 'online') {
    showOnlineLobby();
    return;
  }
  const labels = {
    trial:'TIME TRIAL — CHOOSE CIRCUIT',
    versus:'VERSUS RACE — CHOOSE CIRCUIT',
    ai:'AI RACE — CHOOSE CIRCUIT',
    shootout:'ONE LAP SHOOTOUT — CHOOSE CIRCUIT',
    online:'ONLINE RACE — HOST PICKS CIRCUIT'
  };
  document.getElementById('track-mode-label').textContent = labels[m] || 'CHOOSE CIRCUIT';
  buildTrackGrid();
  showScreen('track');
}

// ── ONLINE LOBBY ────────────────────────────────────────
function getOnlineSession() {
  return (window.OnlineNet && window.OnlineNet.session) || null;
}

function getOnlinePlayerMeta() {
  let name = 'RACER';
  if(_kbIdentity && _kbIdentity.registered && _kbIdentity.username) name = _kbIdentity.username;
  let color = '#00f5ff';
  try {
    const liv = getPlayerLivery('p1');
    const pc = getPaintColor(liv.chassis);
    if(pc && pc.body) color = pc.body;
  } catch(e2) {}
  return { name, color };
}

function showOnlineLobby() {
  initAudio();
  playUIClick();
  currentMode = 'online';
  stopOnlineLobbyPoll();
  const joinWrap = document.getElementById('online-join-list-wrap');
  if(joinWrap) joinWrap.style.display = 'none';
  fillOnlineTrackSelect();
  bindOnlineSessionEvents();
  refreshOnlineLobbyUI();
  showScreen('online');
}

function fillOnlineTrackSelect() {
  const sel = document.getElementById('online-track-select');
  if(!sel || sel.options.length) return;
  TRACKS.forEach((t, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
}

let _onlineEventsBound = false;
let _onlineLobbyPoll = null;
function stopOnlineLobbyPoll() {
  if(_onlineLobbyPoll) { clearInterval(_onlineLobbyPoll); _onlineLobbyPoll = null; }
}

function bindOnlineSessionEvents() {
  const sess = getOnlineSession();
  if(!sess || _onlineEventsBound) return;
  _onlineEventsBound = true;
  sess.on('change', refreshOnlineLobbyUI);
  sess.on('error', function(msg) {
    const el = document.getElementById('online-status');
    if(el) {
      el.textContent = (msg && msg.message) || sess.lastError || 'Online error';
      el.classList.add('err');
    }
  });
  sess.on('startRace', function(msg) {
    stopOnlineLobbyPoll();
    beginOnlineRaceFromNet(msg);
  });
  sess.on('hostMigrated', function(msg) {
    if(!race || race.mode !== 'online') return;
    const dropped = msg && msg.disconnectedId;
    if(dropped && window.OnlineNet) {
      race.karts.forEach(function(k) {
        if(k.onlineConnId === dropped) {
          k._onlineDisconnected = true;
          window.OnlineNet.session.remoteInputs[dropped] = window.OnlineNet.emptyInput();
        }
      });
    }
    const hostPlayer = (msg && msg.players || []).find(function(p) { return p.id === (msg && msg.hostId); });
    const hostName = (hostPlayer && hostPlayer.name) || 'P2';
    race._onlineHostBanner = {
      text: 'HOST LEFT — ' + hostName + 'IS NOW HOST',
      until: performance.now() + 3500
    };
  });
  sess.on('raceAborted', function() {
    teardownRaceUI();
    race = null;
    CG.gameplayStop();
    showScreen('online');
    const st = document.getElementById('online-room-status');
    if(st) st.textContent = 'Host left — race aborted. Waiting in lobby…';
  });
  sess.on('raceEnded', function(msg) {
    teardownRaceUI();
    race = null;
    window._onlineRaceConfig = null;
    CG.gameplayStop();
    showScreen('online');
    const st = document.getElementById('online-room-status');
    if(st) {
      st.textContent = (msg && (msg.standings || msg.results))
        ? 'Race finished — ready up for the next one.'
        : 'Race finished. Waiting in lobby…';
    }
    refreshOnlineLobbyUI();
  });
  sess.on('disconnected', function(info) {
    if(info && info.wasRacing) {
      teardownRaceUI();
      race = null;
      CG.gameplayStop();
      showScreen('online');
      const st = document.getElementById('online-room-status');
      if(st) st.textContent = 'Disconnected from lobby.';
    }
    refreshOnlineLobbyUI();
  });
}

function hostOnlineLobby() {
  const sess = getOnlineSession();
  if(!sess) { alert('online.js failed to load'); return; }
  stopOnlineLobbyPoll();
  initAudio(); playUIClick();
  setOnlineStatus('Creating lobby…');
  sess.hostLobby(getOnlinePlayerMeta()).then(function() {
    sess.setReady(false);
    refreshOnlineLobbyUI();
  }).catch(function(err) {
    setOnlineStatus((err && err.message) || 'Host failed', true);
  });
}

function showOnlineJoinList() {
  initAudio(); playUIClick();
  const wrap = document.getElementById('online-join-list-wrap');
  if(wrap) wrap.style.display = 'block';
  refreshOnlineLobbyList();
  stopOnlineLobbyPoll();
  _onlineLobbyPoll = setInterval(refreshOnlineLobbyList, 4000);
}

function refreshOnlineLobbyList() {
  const list = document.getElementById('online-lobby-list');
  const st = document.getElementById('online-join-status');
  if(!window.OnlineNet || !window.OnlineNet.fetchLobbies) {
    if(st) { st.textContent = 'online.js missing fetchLobbies'; st.classList.add('err'); }
    return;
  }
  if(st) { st.textContent = 'Loading open lobbies…'; st.classList.remove('err'); }
  window.OnlineNet.fetchLobbies().then(function(lobbies) {
    if(!list) return;
    list.innerHTML = '';
    if(!lobbies.length) {
      if(st) st.textContent = 'No open lobbies right now. Ask a friend to Host Game, then refresh.';
      return;
    }
    if(st) st.textContent = lobbies.length + ' open ' + (lobbies.length === 1 ? 'lobby' : 'lobbies');
    lobbies.forEach(function(lobby) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'online-player';
      row.style.cssText = 'width:100%;cursor:pointer;text-align:left;font:inherit;color:inherit;';
      const trackName = (TRACKS[lobby.trackId] && TRACKS[lobby.trackId].name) || ('Track ' + (lobby.trackId || 0));
      row.innerHTML =
        '<div class="op-name" style="color:#00f5ff">' + (lobby.hostName || 'HOST') + '</div>' +
        '<div class="op-meta">' + (lobby.players || 1) + '/' + (lobby.max || 6) + ' · ' + trackName + ' · ' + (lobby.laps || 3) + 'L</div>';
      row.onclick = function() { joinOnlineLobbyById(lobby.id); };
      list.appendChild(row);
    });
  }).catch(function(err) {
    if(st) {
      st.textContent = (err && err.message) || 'Failed to load lobbies';
      st.classList.add('err');
    }
  });
}

function joinOnlineLobbyById(roomId) {
  const sess = getOnlineSession();
  if(!sess) { alert('online.js failed to load'); return; }
  stopOnlineLobbyPoll();
  initAudio(); playUIClick();
  setOnlineStatus('Joining…');
  sess.joinLobby(roomId, getOnlinePlayerMeta()).then(function() {
    sess.setReady(false);
    const wrap = document.getElementById('online-join-list-wrap');
    if(wrap) wrap.style.display = 'none';
    refreshOnlineLobbyUI();
  }).catch(function(err) {
    setOnlineStatus((err && err.message) || 'Join failed', true);
    showOnlineJoinList();
  });
}

function leaveOnlineLobby() {
  stopOnlineLobbyPoll();
  const sess = getOnlineSession();
  if(sess) sess.leave();
  showScreen('mode');
}

function setOnlineStatus(text, isErr) {
  const el = document.getElementById('online-status');
  if(!el) return;
  el.textContent = text || '';
  el.classList.toggle('err', !!isErr);
}

function refreshOnlineLobbyUI() {
  const sess = getOnlineSession();
  const connectPanel = document.getElementById('online-connect-panel');
  const roomPanel = document.getElementById('online-room-panel');
  if(!sess || !connectPanel || !roomPanel) return;

  const inRoom = sess.isActive() && sess.roomId;
  connectPanel.style.display = inRoom ? 'none' : 'block';
  roomPanel.style.display = inRoom ? 'block' : 'none';
  if(inRoom) stopOnlineLobbyPoll();

  if(!inRoom) {
    if(sess.lastError) setOnlineStatus(sess.lastError, true);
    else setOnlineStatus('Host a game for friends, or join an open lobby.');
    return;
  }

  const codeEl = document.getElementById('online-room-code');
  if(codeEl) {
    codeEl.textContent = sess.isHost() ? 'YOU ARE HOSTING' : ('JOINED ' + (sess.players.find(function(p){ return p.id === sess.hostId; }) || {}).name || 'HOST');
  }
  const hostSettings = document.getElementById('online-host-settings');
  const startBtn = document.getElementById('online-start-btn');
  const readyBtn = document.getElementById('online-ready-btn');
  const isHost = sess.isHost();
  if(hostSettings) hostSettings.style.display = isHost ? 'block' : 'none';
  if(startBtn) startBtn.style.display = isHost ? 'inline-flex' : 'none';

  const me = (sess.players || []).find(function(p) { return p.id === sess.you; });
  if(readyBtn) {
    readyBtn.textContent = me && me.ready ? 'UNREADY' : 'READY';
    readyBtn.className = me && me.ready ? 'btn btn-orange btn-sm' : 'btn btn-gold btn-sm';
  }

  const trackSel = document.getElementById('online-track-select');
  const lapsSel = document.getElementById('online-laps-select');
  const wxSel = document.getElementById('online-weather-select');
  const colSel = document.getElementById('online-collision-select');
  if(trackSel && sess.settings) trackSel.value = String(sess.settings.trackId || 0);
  if(lapsSel && sess.settings) lapsSel.value = String(sess.settings.laps || 3);
  if(wxSel && sess.settings) wxSel.value = sess.settings.weather || 'dry';
  if(colSel && sess.settings) colSel.value = sess.settings.collisionMode || 'collision';
  [trackSel, lapsSel, wxSel, colSel].forEach(function(el) {
    if(el) el.disabled = !isHost;
  });

  const roster = document.getElementById('online-roster');
  if(roster) {
    roster.innerHTML = '';
    (sess.players || []).forEach(function(p, idx) {
      const row = document.createElement('div');
      row.className = 'online-player';
      const isYou = p.id === sess.you;
      const isRoomHost = p.id === sess.hostId;
      row.innerHTML =
        '<div class="op-name" style="color:' + (p.color || '#00f5ff') + '">' +
          (isRoomHost ? ' ' : '') + (p.name || 'RACER') + (isYou ? ' (YOU)' : '') +
        '</div>' +
        '<div class="op-meta">P' + (idx + 1) + ' · ' + (p.ready ? 'READY' : 'WAITING') + '</div>';
      roster.appendChild(row);
    });
  }

  const readyCount = (sess.players || []).filter(function(p) { return p.ready; }).length;
  const roomStatus = document.getElementById('online-room-status');
  if(roomStatus) {
    roomStatus.textContent = (sess.players || []).length + '/6 players · ' + readyCount + ' ready' +
      (isHost ? ' · You are host' : ' · Waiting for host');
    roomStatus.classList.remove('err');
  }
}

function syncOnlineHostSettings() {
  const sess = getOnlineSession();
  if(!sess || !sess.isHost()) return;
  sess.updateSettings({
    trackId: parseInt(document.getElementById('online-track-select').value, 10) || 0,
    laps: parseInt(document.getElementById('online-laps-select').value, 10) || 3,
    weather: document.getElementById('online-weather-select').value || 'dry',
    collisionMode: document.getElementById('online-collision-select').value || 'collision',
    tyres: 'med'
  });
}

function toggleOnlineReady() {
  const sess = getOnlineSession();
  if(!sess) return;
  initAudio(); playUIClick();
  const me = (sess.players || []).find(function(p) { return p.id === sess.you; });
  sess.setReady(!(me && me.ready));
}

function startOnlineRace() {
  const sess = getOnlineSession();
  if(!sess || !sess.isHost()) return;
  initAudio(); playUIClick();
  syncOnlineHostSettings();
  sess.startRace();
}

function beginOnlineRaceFromNet(msg) {
  const sess = getOnlineSession();
  if(!sess) return;
  const settings = (msg && msg.settings) || sess.settings || {};
  const order = (msg && msg.order) || sess.order || [];
  const players = (msg && msg.players) || sess.players || [];
  window._onlineRaceConfig = {
    order: order.slice(),
    players: players.slice(),
    localSlot: order.indexOf(sess.you),
    hostId: sess.hostId,
    laps: settings.laps || 3,
    weather: settings.weather || 'dry',
    collisionMode: settings.collisionMode || 'collision',
    tyres: settings.tyres || 'med'
  };
  try {
    const pd = getPlayerData();
    pd.selectedLaps = window._onlineRaceConfig.laps;
    pd.weather = window._onlineRaceConfig.weather;
    pd.collisionMode = window._onlineRaceConfig.collisionMode;
    pd.tyres = window._onlineRaceConfig.tyres;
    savePlayerData(pd);
  } catch(e) {}
  currentMode = 'online';
  window._skipNextQuali = true;
  const trackId = Math.max(0, Math.min(TRACKS.length - 1, settings.trackId | 0));
  selectTrackStart(trackId);
  if(race) {
    race._lastOnlineCd = 3;
    race._onlineGuestEngines = false;
    race._onlineLocalSim = null;
    race._onlineSimTrack = null;
    if(window.OnlineNet && window.OnlineNet.session && typeof window.OnlineNet.session.resetDisplayPoses === 'function') {
      window.OnlineNet.session.resetDisplayPoses(race);
    }
    ensureOnlineLocalSim(race, onlineCameraIndex());
  }
}

/** Compact upgrade/setup blob for Worker + shared OnlineSim (matches applyUpgradesToKart). */
function getOnlineUpgrades() {
  try {
    const pd = getPlayerData();
    const devBonus = getTeamDevelopmentBonuses(pd);
    const setup = resolvePlayerSetup(pd, 'p1');
    return {
      speed: devBonus.speed || 0,
      accel: devBonus.accel || 0,
      handling: devBonus.handling || 0,
      braking: devBonus.braking || 0,
      traction: devBonus.traction || 0,
      speedMult: setup.speedMult || 1,
      turnMult: setup.turnMult || 1,
      brakeMult: setup.brakeMult != null ? setup.brakeMult : 1,
      tractBonus: setup.tractBonus || 0
    };
  } catch(e) {
    return null;
  }
}
window.getOnlineUpgrades = getOnlineUpgrades;

/** Local prediction Kart mirrored through OnlineSim.createKart / stepKart. */
function ensureOnlineLocalSim(race, localIdx) {
  const Sim = window.OnlineSim;
  if(!race || !Sim || !Sim.createKart) return;
  const tid = (race.track && race.track.id != null) ? (race.track.id | 0) : 0;
  if(!race._onlineSimTrack) {
    // Prefer finalized live track (matches visuals + offline physics bounds)
    const liveBake = getOnlineTrackBake(tid);
    if(liveBake) {
      race._onlineSimTrack = liveBake;
    } else {
      // Canonical Worker bake — fallback when live track unavailable
      const bake = Sim.loadTrackBake && Sim.loadTrackBake(tid);
      if(!bake) {
        if(!race._onlineBakeMissingWarned) {
          race._onlineBakeMissingWarned = true;
          console.error('Canonical track bake missing for trackId', tid);
        }
        return;
      }
      race._onlineSimTrack = bake;
    }
  }
  if(race._onlineLocalSim) return;
  const k = race.karts[localIdx];
  if(!k) return;
  const cfg = window._onlineRaceConfig || {};
  race._onlineLocalSim = Sim.createKart({
    id: localIdx,
    x: k.x,
    y: k.y,
    angle: k.angle,
    color: k.color,
    upgrades: getOnlineUpgrades() || (Sim.defaultUpgrades && Sim.defaultUpgrades()) || undefined,
    weather: race.weather || cfg.weather || 'dry',
    tyreId: race.tyres || cfg.tyres || 'med',
    totalLaps: race.lapCount || cfg.laps || 3,
    onlineConnId: k.onlineConnId || '',
    onlineName: k.onlineName || ''
  });
}

/** Compact baked track payload for server-authoritative physics (admin startRace). */
function getOnlineTrackBake(trackId) {
  const idx = Math.max(0, Math.min(TRACKS.length - 1, trackId | 0));
  const tr = TRACKS[idx];
  if(!tr || !tr.spline || !tr.cpLines) return null;
  return {
    id: tr.id,
    trackWidth: tr.trackWidth,
    spline: tr.spline.map(function(p) { return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }; }),
    cum: (tr.cum || []).slice(),
    totalLen: tr.totalLen,
    startPos: { x: tr.startPos.x, y: tr.startPos.y },
    startAngle: tr.startAngle || 0,
    cpLines: (tr.cpLines || []).map(function(c) {
      return { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 };
    }),
    drsZones: (tr.drsZones || []).map(function(z) {
      return { sIdx: z.sIdx | 0, eIdx: z.eIdx | 0 };
    }),
    gridSlots: (tr.gridSlots || []).slice(0, 6).map(function(s) {
      return { x: s.x, y: s.y, a: s.a };
    }),
    surface: tr.surface ? { offTrackMult: tr.surface.offTrackMult || 1 } : { offTrackMult: 1 },
    pitLane: (tr.pitLane && tr.pitLane.path && tr.pitLane.path.length >= 2)
      ? {
          path: tr.pitLane.path.map(function(p) { return { x: p.x, y: p.y }; }),
          width: tr.pitLane.width || 60
        }
      : undefined
  };
}
window.getOnlineTrackBake = getOnlineTrackBake;

/** Mirror shared-sim off-track state onto display kart for HUD badges / penalty warning. */
function syncOnlineOffTrackFromSim(displayKart, simKart) {
  if(!displayKart || !simKart) return;
  const wasCompletelyOff = !!displayKart._isCompletelyOff;
  displayKart.isOffTrack = !!simKart.isOffTrack;
  displayKart._penaltyTimer = simKart._penaltyTimer || 0;
  displayKart._isCompletelyOff = !!simKart._isCompletelyOff;
  if(typeof simKart._nearestSplineIdx === 'number') displayKart._nearestSplineIdx = simKart._nearestSplineIdx;
  if(!displayKart.isAI && displayKart._isCompletelyOff && !wasCompletelyOff) {
    spawnSpark(displayKart.x, displayKart.y);
    try { playCollision(0.45); } catch(e){}
  }
}
window.syncOnlineOffTrackFromSim = syncOnlineOffTrackFromSim;

function onlineCameraIndex() {
  const cfg = window._onlineRaceConfig;
  if(cfg && cfg.localSlot >= 0) return cfg.localSlot;
  return 0;
}


function selectTrack(idx) {
  initAudio();
  if(currentMode === 'shootout') {
    selectTrackStart(idx);
    return;
  }
  showSetupScreen(idx);
}

// ── RACE COUNT (for FTUE hint) ───────────────────────────
function getRaceCount() { try { return parseInt(localStorage.getItem('kartblitz_racecount') || '0', 10); } catch(e) { return 0; } }
function incRaceCount() { try { localStorage.setItem('kartblitz_racecount', String(getRaceCount() + 1)); } catch(e) {} }

function selectTrackStart(idx) {
  initAudio();
  clearTrackBaseCache();
  incRaceCount(); // track race count for FTUE hint
  const t = TRACKS[idx];
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  _raceFillBg = (t && t.bgColor) || null;
  canvas.style.display = 'block';
  resizeCanvas();
  // Force a layout pass before the first painted countdown/HUD frame
  void canvas.offsetWidth;
  race = new Race(currentMode, t);
  showTouchOverlay(true);
  updateRaceControlsHud(true);
  _pPool.forEach(p => { p.active = false; }); // reset particle pool
  if(race.phase === 'countdown') {
    document.getElementById('countdownOverlay').style.display = 'flex';
    showCountdown(3);
  } else {
    document.getElementById('countdownOverlay').style.display = 'none';
  }
  startGameLoop();
}

/** Title-screen shortcut into Time Trial track select. */
function startTimeTrial() {
  initAudio();
  playUIClick();
  selectMode('trial');
}

function getP1Input() {
  const b = BINDINGS.p1;
  const kb = {up:keyActive(b.up),down:keyActive(b.down),left:keyActive(b.left),right:keyActive(b.right),ers:keyActive(b.ers),drs:keyActive(b.drs)};
  if(!touchMode) return kb;
  return mergePlayerInput(kb, touchState.p1);
}
function getP2Input() {
  const b = BINDINGS.p2;
  const kb = {up:keyActive(b.up),down:keyActive(b.down),left:keyActive(b.left),right:keyActive(b.right),ers:keyActive(b.ers),drs:keyActive(b.drs)};
  if(!touchMode) return kb;
  return mergePlayerInput(kb, touchState.p2);
}
function mergePlayerInput(kb, ts) {
  const steer = (kb.left || kb.right) ? ((kb.left ? -1 : 0) + (kb.right ? 1 : 0)) : ts.steer;
  const throttle = kb.up ? 1 : ts.throttle;
  const brake = kb.down ? 1 : ts.brake;
  return {
    up: kb.up || ts.throttle > 0.15,
    down: kb.down || ts.brake > 0.15,
    left: kb.left || ts.steer < -0.15,
    right: kb.right || ts.steer > 0.15,
    ers: kb.ers || !!ts.ers,
    drs: kb.drs || !!ts.drs,
    steer, throttle, brake
  };
}

function restartRace() {
  if(!race) return;
  if(race.mode === 'online') {
    // Online: go back to lobby so the host can start a fresh race
    returnToMainMenu();
    return;
  }
  const trackId = race.track.id;
  const mode = race.mode;
  document.getElementById('screen-results').classList.add('hidden');
  document.getElementById('screen-quali-results').classList.add('hidden');
  currentMode = mode;
  // Mid-session / race-again restart should not force another qualifying session.
  window._skipNextQuali = true;
  selectTrackStart(trackId);
}

function _selectStartTyre(tyreId) {
  window._raceStartTyreId = tyreId;
  // Update button highlight states
  TYRE_DEFS.forEach(t => {
    const btn = document.getElementById('tyre-btn-' + t.id);
    if(!btn) return;
    const isSel = t.id === tyreId;
    btn.style.border = `2px solid ${isSel ? t.color : 'rgba(255,255,255,0.15)'}`;
    btn.style.background = isSel ? t.color + '33' : 'rgba(0,0,0,0.4)';
  });
}

function startRaceFromQualifying() {
  if(!race) return;
  document.getElementById('screen-quali-results').classList.add('hidden');

  // Re-place on the quali grid right before lights out so nobody keeps pit-hold coords.
  const order = race.gridOrder || race.qualiOrder || race.karts.map((_, i) => i);
  if(typeof race._placeKartsOnStartingGrid === 'function') {
    race._placeKartsOnStartingGrid(order);
  }

  // Apply fresh race-start tyres to all karts
  const weather = normalizeWeatherId(race.weather || 'dry');
  const playerTyre = window._raceStartTyreId || race.tyres || 'med';
  const aiStratTyres = ['soft','med','med','hard','soft','med','hard','med','soft','med'];
  race.karts.forEach((k, i) => {
    const tyre = (i === 0) ? playerTyre : (aiStratTyres[i % aiStratTyres.length]);
    const safeTyre = getLegalTyreId(tyre, weather);
    k._applyNewTyre(safeTyre, weather);
    // Keep grid pose — tyre fit must not leave flash/pit state from quali.
    k.flashTimer = 0; k.rankFlash = '';
    k.pitPhase = null;
    k.inPit = false;
    k._onPitLane = false;
    k._pitIntentActive = false;
    k._pitEntryConfirmed = false;
    k._pitExiting = false;
    k._pitExitPos = null;
    k._pitExitAngle = null;
    k._qualiWaiting = false;
    k._hasPitted = false;
    k.finished = false;
    k.speed = 0;
  });

  _raceFillBg = (race && race.track && race.track.bgColor) || _raceFillBg;
  canvas.style.display = 'block';
  resizeCanvas();
  void canvas.offsetWidth;
  document.getElementById('countdownOverlay').style.display = 'none';

  race.cameras = race.karts.map(k => ({x: k.x, y: k.y}));
  race.launchRPM = race.karts.map(k => k.isAI ? (0.62 + (Math.random() - 0.5) * 0.18) : 0.35);
  race.countdownVal = 3;
  race.countdownTimer = 0;
  race.phase = 'countdown';
  showTouchOverlay(true);
  updateRaceControlsHud(true);
  showCountdown(3);
  lastTime = null;
  animId = requestAnimationFrame(gameLoop);
}
function selectTrackDirect(mode, idx) {
  currentMode = mode;
  selectTrackStart(idx);
}

// ── TOUCH CONTROLS ──────────────────────────────────────
var touchMode = false;
var _touchControlsReady = false;
function _freshTouchPlayer() {
  return { steer:0, throttle:0, brake:0, ers:false, drs:false, pit:false };
}
var touchState = { p1: _freshTouchPlayer(), p2: _freshTouchPlayer() };
var _stickPointers = { p1: null, p2: null };
const TOUCH_DEADZONE = 0.15;

function isVersusFaceToFace() {
  try { return !!(touchMode && race && race.mode === 'versus'); } catch(e) { return false; }
}

function resetTouchDrive(player) {
  const ts = touchState[player];
  if(!ts) return;
  ts.steer = 0; ts.throttle = 0; ts.brake = 0;
  const knob = document.getElementById(player === 'p1' ? 'touch-knob-p1' : 'touch-knob-p2');
  if(knob) knob.style.transform = 'translate(0px, 0px)';
}

function setDeviceMode(isMobile) {
  touchMode = !!isMobile;
  const prompt = document.getElementById('device-prompt');
  if(prompt) prompt.classList.remove('open');
  try { localStorage.setItem('kartblitz_devicemode', isMobile ? 'touch' : 'keyboard'); } catch(e){}
  if(isMobile) setupTouchControls();
  else if(touchState) {
    resetTouchDrive('p1');
    resetTouchDrive('p2');
    touchState.p1.ers = touchState.p1.drs = touchState.p1.pit = false;
    touchState.p2.ers = touchState.p2.drs = touchState.p2.pit = false;
  }
  try {
    const racing = canvas && canvas.style.display === 'block' && race && !isPaused;
    showTouchOverlay(!!racing);
  } catch(e) {
    showTouchOverlay(false);
  }
}

function updateLandscapeHint(raceVisible) {
  const hint = document.getElementById('rotate-hint');
  if(!hint) return;
  let paused = false;
  try { paused = !!isPaused; } catch(e) { paused = false; }
  const portrait = window.innerHeight > window.innerWidth;
  const show = !!(touchMode && raceVisible && portrait && !paused);
  hint.classList.toggle('show', show);
  hint.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function scaleTouchOverlay() {
  const overlay = document.getElementById('touch-overlay');
  if(!overlay) return;
  overlay.style.transformOrigin = '';
  overlay.style.transform = 'none';
}

function showTouchOverlay(visible) {
  const ov = document.getElementById('touch-overlay');
  if(!ov) return;
  const show = touchMode && visible;
  ov.style.display = show ? 'block' : 'none';
  if(show) {
    let versus = false;
    try { versus = !!(race && race.mode === 'versus'); } catch(e) { versus = false; }
    ov.classList.toggle('touch-versus-face', versus);
    const p2 = document.getElementById('touch-pad-p2');
    if(p2) p2.style.display = versus ? 'block' : 'none';
    scaleTouchOverlay();
  } else {
    ov.classList.remove('touch-versus-face');
  }
  try { updateLandscapeHint(show); } catch(e) {}
}

function setupTouchControls() {
  if(_touchControlsReady) {
    scaleTouchOverlay();
    return;
  }
  const overlay = document.getElementById('touch-overlay');
  if(!overlay) return;
  _touchControlsReady = true;

  function applyStickFromPoint(player, clientX, clientY, stickEl) {
    const rect = stickEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = (clientX - cx) / (rect.width / 2);
    let dy = (clientY - cy) / (rect.height / 2);
    // Face-to-face P2 pad is CSS-rotated 180°; un-rotate pointer deltas into player-local axes.
    if(player === 'p2' && isVersusFaceToFace()) {
      dx = -dx;
      dy = -dy;
    }
    const mag = Math.hypot(dx, dy);
    if(mag > 1) { dx /= mag; dy /= mag; }
    const dead = TOUCH_DEADZONE;
    const ts = touchState[player];
    const ax = Math.abs(dx) < dead ? 0 : (dx - Math.sign(dx) * dead) / (1 - dead);
    const ay = Math.abs(dy) < dead ? 0 : (dy - Math.sign(dy) * dead) / (1 - dead);
    ts.steer = Math.max(-1, Math.min(1, ax));
    // Screen Y down is positive; stick up (negative dy) = throttle
    ts.throttle = ay < 0 ? Math.min(1, -ay) : 0;
    ts.brake = ay > 0 ? Math.min(1, ay) : 0;
    const knob = document.getElementById(player === 'p1' ? 'touch-knob-p1' : 'touch-knob-p2');
    if(knob) {
      const knobSize = knob.offsetWidth || 64;
      const maxPx = Math.max(8, (stickEl.clientWidth - knobSize) / 2);
      knob.style.transform = `translate(${dx * maxPx}px, ${dy * maxPx}px)`;
    }
  }

  function bindStick(player) {
    const stickEl = document.getElementById(player === 'p1' ? 'touch-stick-p1' : 'touch-stick-p2');
    if(!stickEl) return;
    stickEl.addEventListener('pointerdown', e => {
      e.preventDefault();
      _stickPointers[player] = e.pointerId;
      try { stickEl.setPointerCapture(e.pointerId); } catch(err){}
      applyStickFromPoint(player, e.clientX, e.clientY, stickEl);
    }, {passive:false});
    stickEl.addEventListener('pointermove', e => {
      if(_stickPointers[player] !== e.pointerId) return;
      e.preventDefault();
      applyStickFromPoint(player, e.clientX, e.clientY, stickEl);
    }, {passive:false});
    const end = e => {
      if(_stickPointers[player] !== e.pointerId) return;
      e.preventDefault();
      _stickPointers[player] = null;
      resetTouchDrive(player);
    };
    stickEl.addEventListener('pointerup', end, {passive:false});
    stickEl.addEventListener('pointercancel', end, {passive:false});
  }

  function bindActionBtn(el) {
    const player = el.getAttribute('data-player');
    const action = el.getAttribute('data-action');
    if(!player || !action) return;
    const setPressed = (on) => {
      if(action === 'pause') return;
      const ts = touchState[player];
      if(!ts) return;
      ts[action] = !!on;
      el.classList.toggle('pressed', !!on);
    };
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch(err){}
      setPressed(true);
    }, {passive:false});
    const end = e => { e.preventDefault(); setPressed(false); };
    el.addEventListener('pointerup', end, {passive:false});
    el.addEventListener('pointercancel', end, {passive:false});
    el.addEventListener('lostpointercapture', () => setPressed(false));
  }

  bindStick('p1');
  bindStick('p2');
  overlay.querySelectorAll('.touch-btn').forEach(bindActionBtn);

  window.addEventListener('resize', () => {
    scaleTouchOverlay();
    updateLandscapeHint(touchMode && canvas.style.display === 'block' && !!race && !isPaused);
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      scaleTouchOverlay();
      resizeCanvas();
      updateLandscapeHint(touchMode && canvas.style.display === 'block' && !!race && !isPaused);
    }, 120);
  });
  scaleTouchOverlay();
}

function getActivePitSelectionKart() {
  if(!race || !race.karts) return null;
  for(let i = 0; i < race.karts.length; i++) {
    const kart = race.karts[i];
    if(kart && !kart.isAI && kart.pitPhase === 'selecting') return { kart, playerIndex:i };
  }
  return null;
}

function confirmPitSelection(kart, playerIndex) {
  if(!kart || kart.pitPhase !== 'selecting') return;
  if((kart._pitSelectLock || 0) > 0) return;
  const weather = normalizeWeatherId((race && race.weather) || window._raceWeather || 'dry');
  const legal = getLegalTyreDefs(weather);
  const tyre = legal[kart.pitNavIdx] || legal.find(t => t.id === kart.pitTyreChoice) || legal[0];
  kart.pitNavIdx = Math.max(0, legal.findIndex(t => t.id === tyre.id));
  kart.pitTyreChoice = tyre.id;
  const bp = playerIndex === 0 ? BINDINGS.p1 : BINDINGS.p2;
  [bp.up, bp.up && bp.up.toLowerCase ? bp.up.toLowerCase() : null, bp.up && bp.up.toUpperCase ? bp.up.toUpperCase() : null,
   bp.pit, bp.pit && bp.pit.toLowerCase ? bp.pit.toLowerCase() : null, bp.pit && bp.pit.toUpperCase ? bp.pit.toUpperCase() : null]
    .filter(Boolean)
    .forEach(kk => delete keys[kk]);
  beep(550,0.08,0.3,'square');
  if(race && race._trialStartTyrePick && typeof race._finishTrialStartTyrePick === 'function') {
    race._finishTrialStartTyrePick(kart);
    return;
  }
  kart.pitPhase = 'stopping';
  if(race && typeof race._compensatePitMenuPause === 'function') race._compensatePitMenuPause();
}

function clearPitUiLayoutClasses(overlay) {
  if(!overlay) return;
  overlay.classList.remove(
    'pit-ui-half', 'pit-ui-half-p1', 'pit-ui-half-p2',
    'pit-ui-face', 'pit-ui-face-p1', 'pit-ui-face-p2'
  );
}

function syncPitSelectionOverlay() {
  const overlay = document.getElementById('pit-ui-overlay');
  if(!overlay) return;
  if(canvas.style.display !== 'block' || !race || isPaused) {
    overlay.style.display = 'none';
    overlay.dataset.signature = '';
    clearPitUiLayoutClasses(overlay);
    return;
  }

  const active = getActivePitSelectionKart();
  if(!active) {
    overlay.style.display = 'none';
    overlay.dataset.signature = '';
    clearPitUiLayoutClasses(overlay);
    return;
  }

  const { kart, playerIndex } = active;
  const title = document.getElementById('pit-ui-title');
  const sub = document.getElementById('pit-ui-sub');
  const choices = document.getElementById('pit-ui-choices');
  const confirmBtn = document.getElementById('pit-ui-confirm');
  const isVersusSplit = race.mode === 'versus' && race.karts && race.karts.length === 2;
  const faceToFace = isVersusSplit && touchMode;
  const confirmKey = keyLabel(playerIndex === 0 ? BINDINGS.p1.up : BINDINGS.p2.up);
  const navKeys = touchMode ? 'stick L/R' : (playerIndex === 0 ? 'A/D' : '←/→');
  const signature = `${playerIndex}|${kart.pitPhase}|${kart.pitNavIdx}|${kart.tyreId}|${kart.pitTyreChoice||''}|${race && race.track ? race.track.id : 0}|${isVersusSplit?1:0}|${faceToFace?1:0}|${race && race._trialStartTyrePick?1:0}|${touchMode?1:0}`;

  clearPitUiLayoutClasses(overlay);
  if(faceToFace) {
    overlay.classList.add('pit-ui-face');
    overlay.classList.add(playerIndex === 0 ? 'pit-ui-face-p1' : 'pit-ui-face-p2');
  } else if(isVersusSplit) {
    overlay.classList.add('pit-ui-half');
    overlay.classList.add(playerIndex === 0 ? 'pit-ui-half-p1' : 'pit-ui-half-p2');
  }

  if(overlay.dataset.signature !== signature) {
    const currentTyre = TYRE_DEFS.find(t => t.id === kart.tyreId) || TYRE_DEFS[1];
    const isTrialStart = !!(race && race._trialStartTyrePick);
    title.textContent = isTrialStart
      ? 'TIME TRIAL — CHOOSE START TYRES'
      : (isVersusSplit
        ? `${playerIndex === 0 ? 'P1' : 'P2'} PIT STOP`
        : ` ${playerIndex === 0 ? 'P1' : 'P2'} PIT STOP — PICK TYRES`);
    sub.textContent = isTrialStart
      ? `Pick a compound, then ${touchMode ? 'tap confirm' : 'press ' + confirmKey} to confirm and drive out of the pits (${navKeys} to cycle).`
      : (isVersusSplit
        ? `Current: ${currentTyre.label}. Tap a tyre, then ${touchMode ? 'tap confirm / PIT' : 'press ' + confirmKey}.`
        : `Paused. Current: ${currentTyre.label}. Pick a compound, then confirm with the button or a fresh ${touchMode ? 'PIT tap' : confirmKey + ' press'} (${navKeys} to cycle).`);
    choices.innerHTML = '';
    const weather = normalizeWeatherId((race && race.weather) || window._raceWeather || 'dry');
    const legalTyres = TYRE_DEFS.filter(t => isTyreSelectableForWeather(t, weather));
    if(!legalTyres.length) legalTyres.push(TYRE_DEFS.find(t => t.id === 'med') || TYRE_DEFS[1]);
    // Keep pitNavIdx inside the legal list.
    if(kart.pitNavIdx < 0 || kart.pitNavIdx >= legalTyres.length) {
      const prefer = legalTyres.findIndex(t => t.id === (kart.pitTyreChoice || kart.tyreId));
      kart.pitNavIdx = prefer >= 0 ? prefer : 0;
    }
    legalTyres.forEach((t, ti) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pit-ui-choice' + (ti === kart.pitNavIdx ? ' sel' : '');
      const lapLife = race && race.track ? getTyreLapLifespan(race.track.id, t.id) : '?';
      const meta = isVersusSplit
        ? `~${lapLife} lap${lapLife===1?'':'s'}`
        : `${t.desc} · ~${lapLife} lap${lapLife===1?'':'s'}`;
      b.innerHTML = `<div class="pit-ui-choice-head"><span class="pit-ui-choice-dot" style="background:${t.color};"></span>${t.label}${t.id === kart.tyreId ? ' · ON' : ''}</div><div class="pit-ui-choice-meta">${meta}</div>`;
      b.onclick = () => {
        kart.pitNavIdx = ti;
        kart.pitTyreChoice = t.id;
        beep(440,0.04,0.2,'square');
        syncPitSelectionOverlay();
      };
      choices.appendChild(b);
    });
    // Stash legal list length for keyboard cycling in pit select.
    kart._pitLegalCount = legalTyres.length;
    kart._pitLegalIds = legalTyres.map(t => t.id);
    confirmBtn.onclick = () => confirmPitSelection(kart, playerIndex);
    confirmBtn.textContent = isTrialStart
      ? (touchMode ? 'CONFIRM & DRIVE OUT' : `CONFIRM & DRIVE OUT (${confirmKey})`)
      : (isVersusSplit
        ? (touchMode ? 'CONFIRM' : `CONFIRM (${confirmKey})`)
        : (touchMode ? 'FIT SELECTED TYRES' : `FIT SELECTED TYRES (${confirmKey})`));
    overlay.dataset.signature = signature;
  }

  overlay.style.display = 'flex';
}

// ── CONFETTI ─────────────────────────────────────────────
const _confettiCanvas = document.getElementById('confetti-canvas');
let _confettiCtx = _confettiCanvas ? _confettiCanvas.getContext('2d') : null;
let _confettiPieces = [];
let _confettiAnim = null;

function launchConfetti() {
  if(!_confettiCtx) return;
  _confettiCanvas.width  = window.innerWidth;
  _confettiCanvas.height = window.innerHeight;
  _confettiCanvas.style.display = 'block';
  _confettiPieces = Array.from({length:160}, () => ({
    x:  Math.random() * _confettiCanvas.width,
    y:  Math.random() * _confettiCanvas.height - _confettiCanvas.height,
    w:  8 + Math.random() * 8,
    h:  4 + Math.random() * 6,
    r:  Math.random() * Math.PI * 2,
    vx: (Math.random()-0.5) * 160,
    vy: 200 + Math.random() * 280,
    vr: (Math.random()-0.5) * 6,
    color: `hsl(${Math.random()*360|0},90%,60%)`,
    life: 1.0
  }));
  if(_confettiAnim) cancelAnimationFrame(_confettiAnim);
  function step() {
    _confettiCtx.clearRect(0, 0, _confettiCanvas.width, _confettiCanvas.height);
    let alive = false;
    _confettiPieces.forEach(p => {
      p.x += p.vx * 0.016; p.y += p.vy * 0.016; p.r += p.vr * 0.016; p.life -= 0.004;
      if(p.y < _confettiCanvas.height + 20) alive = true;
      _confettiCtx.save();
      _confettiCtx.globalAlpha = Math.max(0, p.life);
      _confettiCtx.translate(p.x, p.y); _confettiCtx.rotate(p.r);
      _confettiCtx.fillStyle = p.color;
      _confettiCtx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      _confettiCtx.restore();
    });
    if(alive) _confettiAnim = requestAnimationFrame(step);
    else { _confettiCanvas.style.display='none'; _confettiPieces=[]; }
  }
  _confettiAnim = requestAnimationFrame(step);
}

// ── AI DIFFICULTY UI ─────────────────────────────────────
let aiDifficulty = 'medium';
let aiCount = 3;
let aiDriver = 'scripted';
let shootoutDifficulty = 'medium';

function setAICountFromSlider(v) {
  aiCount = Math.max(1, Math.min(10, parseInt(v, 10) || 3));
  const val = document.getElementById('ai-count-value');
  if(val) val.textContent = `${aiCount} AI`;
}

function showAIDifficultyUI() {
  initAudio();
  const slider = document.getElementById('ai-count-slider');
  if(slider) slider.value = String(aiCount);
  setAICountFromSlider(aiCount);
  document.getElementById('ai-difficulty').style.display = 'flex';
}

function selectAIDriver(type) {
  aiDriver = (type === 'ml') ? 'ml' : 'scripted';
  document.querySelectorAll('#ai-driver-pills .diff-pill').forEach(p => p.classList.remove('sel'));
  const el = document.getElementById(type === 'ml' ? 'ai-driver-ml' : 'ai-driver-scripted');
  if(el) el.classList.add('sel');
}

function selectAIDiff(diff) {
  aiDifficulty = diff;
  document.querySelectorAll('#ai-diff-pills .diff-pill').forEach(p => p.classList.remove('sel'));
  const el = document.querySelector('#ai-diff-pills .diff-pill.' + diff);
  if(el) el.classList.add('sel');
}

function selectAICount(n) {
  setAICountFromSlider(n);
  const slider = document.getElementById('ai-count-slider');
  if(slider) slider.value = String(aiCount);
}

function confirmAIMode() {
  window._aiDifficulty = aiDifficulty;
  window._aiCount = aiCount;
  window._aiDriver = aiDriver;
  if(aiDriver === 'ml') loadMLPolicy(window._mlPolicyPath || 'sim/rl/policy.json');
  currentMode = 'ai';
  document.getElementById('track-mode-label').textContent = aiDriver === 'ml'
    ? 'AI RACE (ML POLICY) — CHOOSE CIRCUIT'
    : 'AI RACE — CHOOSE CIRCUIT';
  document.getElementById('ai-difficulty').style.display = 'none';
  buildTrackGrid();
  showScreen('track');
}

function exportMLDemoFromTrial() {
  if(!race || race.mode !== 'trial' || !race.karts[0] || !race.karts[0]._mlDemoFrames) return;
  const frames = race.karts[0]._mlDemoFrames;
  if(frames.length < 60) { alert('Drive at least one lap before exporting.'); return; }
  const demo = {
    version: 1,
    trackId: race.track.id,
    weather: race.weather || 'dry',
    tyreId: race.karts[0].tyreId || 'med',
    dt: 1/60,
    frames: frames,
  };
  const blob = new Blob([JSON.stringify(demo, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'demo_track' + race.track.id + '_' + Date.now() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function showShootoutDiffUI() {
  initAudio();
  document.getElementById('shootout-difficulty').style.display = 'flex';
}

function selectShootoutDiff(diff) {
  shootoutDifficulty = diff;
  document.querySelectorAll('#shootout-diff-pills .diff-pill').forEach(p => p.classList.remove('sel'));
  const el = document.querySelector('#shootout-diff-pills .diff-pill.' + diff);
  if(el) el.classList.add('sel');
}

function confirmShootoutMode() {
  window._shootoutDifficulty = shootoutDifficulty;
  currentMode = 'shootout';
  document.getElementById('track-mode-label').textContent = 'ONE LAP SHOOTOUT — CHOOSE CIRCUIT';
  document.getElementById('shootout-difficulty').style.display = 'none';
  buildTrackGrid();
  showScreen('track');
}

// ── INPUT ───────────────────────────────────────────────
const keys = {};
document.addEventListener('keydown', e => {
  keys[e.key] = true;
  const lowerKey = e.key.toLowerCase();
  if(canvas.style.display === 'block' && race && !e.repeat) {
    if(lowerKey === 'f8') {
      cycleQualityLevel();
      try { beep(620, 0.05, 0.16, 'square'); } catch(err) {}
    } else if(lowerKey === 'f9') {
      _showDebugOverlay = !_showDebugOverlay;
      saveRuntimePrefs();
      try { beep(_showDebugOverlay ? 720 : 320, 0.05, 0.16, 'square'); } catch(err) {}
    } else if(lowerKey === 'v' && e.altKey && race.karts && race.karts[0] && !race.karts[0].finished) {
      race.karts[0]._pitIntentActive = !race.karts[0]._pitIntentActive;
      try { beep(race.karts[0]._pitIntentActive ? 540 : 260, 0.05, 0.18, 'square'); } catch(err) {}
      e.preventDefault();
    }
  }
  if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
});
document.addEventListener('keyup', e => {
  delete keys[e.key];
});

// ── LEADERBOARD ─────────────────────────────────────────
const LB_DEVICE_KEY = 'kartblitz_device_token';
const LB_PRODUCTION_HOST = 'kartblitz-online.kartblitz.workers.dev';
let _deviceTokenMem = '';
let _kbIdentity = { loaded:false, registered:false, username:'', error:'' };
let _kbLastError = '';
let _lbBuildSeq = 0;
let _lbRegisterPromise = null;
let _lbRegisterResolve = null;
let _lbToastTimer = null;

function formatLbError(err) {
  const msg = (err && err.message) ? String(err.message) : String(err || 'Unknown error');
  return msg.replace(/_/g, ' ');
}
function leaderboardApiBase() {
  let host = LB_PRODUCTION_HOST;
  try {
    const q = new URLSearchParams(location.search).get('lbHost');
    if(q) host = String(q).replace(/^https?:\/\//,'').replace(/\/$/,'');
  } catch(e) {}
  host = String(host || LB_PRODUCTION_HOST).replace(/^https?:\/\//,'').replace(/\/$/,'');
  const secure = !(host.includes('localhost') || host.includes('127.0.0.1'));
  return (secure ? 'https://' : 'http://') + host;
}
function leaderboardApiUrl(path) {
  return leaderboardApiBase() + path;
}
function makeDeviceToken() {
  try {
    if(window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g,'') + Date.now().toString(36);
  } catch(e) {}
  return ('kb' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 48);
}
function getDeviceToken() {
  if(_deviceTokenMem) return _deviceTokenMem;
  try {
    let token = localStorage.getItem(LB_DEVICE_KEY) || '';
    if(!token) {
      token = makeDeviceToken();
      localStorage.setItem(LB_DEVICE_KEY, token);
    }
    _deviceTokenMem = token;
    return token;
  } catch(e) {
    if(!_deviceTokenMem) _deviceTokenMem = makeDeviceToken();
    return _deviceTokenMem;
  }
}
window.getKartBlitzDeviceToken = getDeviceToken;
function sanitizeLeaderboardName(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g,'').substring(0,12);
}
function validLeaderboardName(name) {
  return /^[A-Z0-9]{3,12}$/.test(name);
}
function setSaveStatus(msg, isErr) {
  const el = document.getElementById('save-name-status');
  if(!el) return;
  el.textContent = msg || '';
  el.style.color = isErr ? '#ff8f8f' : 'rgba(255,255,255,0.75)';
}
function setAutoRegisterStatus(msg, isErr) {
  const el = document.getElementById('lb-auto-register-status');
  if(!el) return;
  el.textContent = msg || '';
  el.style.color = isErr ? '#ff8f8f' : 'rgba(255,255,255,0.75)';
}
function showLbToast(msg, isErr) {
  const el = document.getElementById('lb-toast');
  if(!el || !msg) return;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  if(_lbToastTimer) clearTimeout(_lbToastTimer);
  _lbToastTimer = setTimeout(function(){ el.classList.remove('show'); }, isErr ? 4200 : 2600);
}
function updateSaveIdentityUi(identity) {
  const input = document.getElementById('nameInput');
  const title = document.getElementById('save-name-title');
  const sub = document.getElementById('save-name-sub');
  if(!input) return;
  if(identity && identity.registered) {
    if(title) title.textContent = 'USERNAME LOCKED';
    if(sub) sub.textContent = 'THIS DEVICE IS REGISTERED';
    input.value = identity.username || '';
    input.disabled = true;
    setSaveStatus('THIS SCORE WILL SAVE UNDER YOUR LOCKED USERNAME', false);
  } else {
    if(title) title.textContent = 'ENTER USERNAME';
    if(sub) sub.textContent = 'CHOOSE ONCE FOR THIS DEVICE';
    input.disabled = false;
    input.value = sanitizeLeaderboardName(input.value || '');
    setSaveStatus(_kbLastError || '3-12 LETTERS OR NUMBERS', !!_kbLastError);
  }
}
async function leaderboardFetchJson(path, options) {
  const opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
  const res = await fetch(leaderboardApiUrl(path), opts);
  let data = null;
  try { data = await res.json(); } catch(e) {}
  if(!res.ok) {
    const err = (data && (data.error || data.message)) || ('HTTP ' + res.status);
    throw new Error(err);
  }
  return data || {};
}
async function fetchDeviceIdentity(force) {
  if(_kbIdentity.loaded && !force) return _kbIdentity;
  try {
    const data = await leaderboardFetchJson('/api/device-status?deviceToken=' + encodeURIComponent(getDeviceToken()));
    _kbLastError = '';
    _kbIdentity = {
      loaded: true,
      registered: !!data.registered,
      username: data.registered ? sanitizeLeaderboardName(data.username || '') : '',
      error: ''
    };
  } catch(e) {
    _kbLastError = formatLbError(e);
    _kbIdentity = { loaded:false, registered:false, username:'', error:_kbLastError };
  }
  return _kbIdentity;
}
async function ensureRegisteredIdentity(nameRaw) {
  const current = await fetchDeviceIdentity(true);
  if(current.registered) return current;
  const username = sanitizeLeaderboardName(nameRaw);
  if(!validLeaderboardName(username)) throw new Error('Username must be 3-12 letters or numbers.');
  const data = await leaderboardFetchJson('/api/register-device', {
    method: 'POST',
    body: JSON.stringify({ deviceToken: getDeviceToken(), username })
  });
  _kbLastError = '';
  _kbIdentity = { loaded:true, registered:true, username: sanitizeLeaderboardName(data.username || username), error:'' };
  return _kbIdentity;
}
function openAutoRegisterPrompt() {
  const overlay = document.getElementById('lb-auto-register-overlay');
  const input = document.getElementById('lbAutoNameInput');
  if(!overlay) return;
  overlay.classList.add('open');
  setAutoRegisterStatus('3-12 LETTERS OR NUMBERS', false);
  if(input) {
    input.disabled = false;
    input.value = sanitizeLeaderboardName(input.value || '');
    setTimeout(function(){ try { input.focus(); } catch(e) {} }, 0);
  }
}
function closeAutoRegisterPrompt() {
  const overlay = document.getElementById('lb-auto-register-overlay');
  if(overlay) overlay.classList.remove('open');
}
function finishAutoRegisterPromise(identity) {
  const resolve = _lbRegisterResolve;
  _lbRegisterResolve = null;
  _lbRegisterPromise = null;
  closeAutoRegisterPrompt();
  if(resolve) resolve(identity || { loaded:true, registered:false, username:'', error:'' });
}
function dismissAutoRegister() {
  finishAutoRegisterPromise({ loaded:true, registered:false, username:'', error:'' });
}
async function confirmAutoRegister() {
  const input = document.getElementById('lbAutoNameInput');
  const usernameRaw = input ? input.value : '';
  try {
    setAutoRegisterStatus('LOCKING USERNAME...', false);
    const identity = await ensureRegisteredIdentity(usernameRaw);
    if(input) {
      input.value = identity.username || '';
      input.disabled = true;
    }
    setAutoRegisterStatus('USERNAME LOCKED FOR THIS DEVICE', false);
    finishAutoRegisterPromise(identity);
  } catch(e) {
    setAutoRegisterStatus(formatLbError(e).toUpperCase(), true);
  }
}
function promptRegisterUsername() {
  if(_lbRegisterPromise) return _lbRegisterPromise;
  _lbRegisterPromise = new Promise(function(resolve) {
    _lbRegisterResolve = resolve;
    openAutoRegisterPrompt();
  });
  return _lbRegisterPromise;
}
async function ensureRegisteredForAutoSave() {
  const current = await fetchDeviceIdentity(true);
  if(current.registered) return current;
  return promptRegisterUsername();
}
async function submitCloudScore(payload) {
  const data = await leaderboardFetchJson('/api/scores', {
    method: 'POST',
    body: JSON.stringify(Object.assign({ deviceToken: getDeviceToken() }, payload || {}))
  });
  if(data && data.username) {
    _kbLastError = '';
    _kbIdentity = { loaded:true, registered:true, username: sanitizeLeaderboardName(data.username), error:'' };
  }
  return data;
}

/** Persist a single Time Trial lap as soon as it is completed (no need to end session). */
async function autoSaveLapToLeaderboard(trackId, lapTime, totalTime) {
  if(!(lapTime > 0) || !Number.isFinite(lapTime)) return;
  const track = TRACKS.find(t => t.id === trackId);
  const minPossibleLap = (track && track.lapDistance) ? track.lapDistance / 640 : 8;
  if(lapTime < minPossibleLap) return;
  CG.saveScore(`track_${trackId}_lap`, Math.round(lapTime * 1000));
  try {
    const identity = await ensureRegisteredForAutoSave();
    if(!identity.registered) return;
    const result = await submitCloudScore({
      mode: 'trial',
      trackId,
      trackName: track ? track.name : '',
      bestLap: lapTime,
      total: totalTime || null
    });
    if(result && result.saved) showLbToast('LAP SAVED TO LEADERBOARD');
    else if(result && result.reason === 'not_better') showLbToast('LAP RECORDED');
  } catch(e) {
    showLbToast(formatLbError(e).toUpperCase(), true);
  }
}

let pendingSave = null;

async function showSaveAndLeaderboard() {
  pendingSave = window._lastResult;
  if(!pendingSave) return;
  document.getElementById('screen-results').classList.add('hidden');
  document.getElementById('screen-save').classList.remove('hidden');
  const input = document.getElementById('nameInput');
  if(input) {
    input.disabled = true;
    input.value = '';
  }
  setSaveStatus('CHECKING DEVICE REGISTRATION...', false);
  updateSaveIdentityUi(await fetchDeviceIdentity());
}

async function confirmSave() {
  if(!pendingSave) { showScreen('leaderboard'); return; }
  const r = pendingSave;
  const track = TRACKS.find(t => t.id === r.trackId);

  if(r.mode === 'trial' && r.bestLap < Infinity) {
    const minPossibleLap = (track && track.lapDistance) ? track.lapDistance / 640 : 8;
    if (r.bestLap < minPossibleLap) {
      showScreen('leaderboard');
      return;
    }
  }

  try {
    setSaveStatus('SAVING TO CLOUD...', false);
    const identity = await ensureRegisteredIdentity((document.getElementById('nameInput').value || ''));
    updateSaveIdentityUi(identity);
    if(r.mode === 'trial' && r.bestLap < Infinity) {
      await submitCloudScore({
        mode: 'trial',
        trackId: r.trackId,
        trackName: track ? track.name : r.trackName,
        bestLap: r.bestLap,
        total: r.total
      });
      CG.saveScore(`track_${r.trackId}_lap`, Math.round(r.bestLap * 1000));
    } else if(r.mode === 'versus') {
      const bestTime = Math.min(r.p1Best||Infinity, r.p2Best||Infinity);
      if(bestTime < Infinity) {
        await submitCloudScore({
          mode: 'versus',
          trackId: r.trackId,
          trackName: track ? track.name : r.trackName,
          bestLap: bestTime,
          total: r.total,
          winner: r.winner!==null ? `P${r.winner+1}` : 'TIE'
        });
      }
    }
    setSaveStatus('SAVED TO CLOUD', false);
    showScreen('leaderboard');
  } catch(e) {
    setSaveStatus((e && e.message) ? String(e.message).toUpperCase() : 'SAVE FAILED', true);
  }
}

let lbMode = 'trial', lbTrack = 0;

function fmtLbDate(ts) {
  if(!ts) return '—';
  try {
    const d = new Date(ts);
    if(Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'2-digit' });
  } catch(e) { return '—'; }
}

function parseOnlineWinsSeed(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for(const line of lines) {
    const trimmed = String(line || '').trim();
    if(!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if(parts.length < 2) continue;
    const username = sanitizeLeaderboardName(parts[0]);
    if(!validLeaderboardName(username)) continue;
    const wins = Math.floor(Number(parts[1]));
    if(!Number.isFinite(wins) || wins < 0) continue;
    out.push({ username, wins });
  }
  return out;
}

async function fetchOnlineWinsSeed() {
  try {
    const url = `/leaderboard/online-wins.txt?v=${Date.now()}`;
    const res = await fetch(url);
    if(!res.ok) return [];
    return parseOnlineWinsSeed(await res.text());
  } catch(e) {
    return [];
  }
}

function mergeOnlineWinsEntries(cloudEntries, seedEntries) {
  // Keep only top-wins per username.
  const map = new Map(); // username -> { wins, createdAt }

  for(const s of (seedEntries || [])) {
    if(!s || !s.username) continue;
    map.set(s.username, { wins: Number(s.wins) || 0, createdAt: 0 });
  }

  for(const c of (cloudEntries || [])) {
    const username = c && c.username;
    if(!username) continue;
    const wins = Number(c.wins != null ? c.wins : c.bestLap != null ? c.bestLap : 0) || 0;
    const createdAt = Number(c.createdAt) || 0;
    const cur = map.get(username);
    if(!cur || wins > cur.wins) {
      map.set(username, { wins, createdAt });
    }
  }

  return [...map.entries()]
    .map(([username, meta]) => ({ username, wins: meta.wins, createdAt: meta.createdAt }))
    .sort((a, b) => (b.wins || 0) - (a.wins || 0))
    .slice(0, 50);
}

async function buildLeaderboardScreen() {
  const seq = ++_lbBuildSeq;
  const modeTabs = document.getElementById('lb-mode-tabs');
  const trackTabs = document.getElementById('lb-track-tabs');
  const content = document.getElementById('lb-content');
  const panelTitle = document.getElementById('lb-panel-title');
  if(!modeTabs || !trackTabs || !content) return;

  modeTabs.innerHTML = '';
  [
    { id:'trial', label:'TIME TRIAL' },
    { id:'versus', label:'VERSUS' },
    { id:'online', label:'ONLINE WINS' }
  ].forEach(m => {
    const btn = document.createElement('button');
    btn.className = 'lb-tab' + (lbMode === m.id ? ' active' : '');
    btn.textContent = m.label;
    btn.onclick = () => { lbMode = m.id; buildLeaderboardScreen(); };
    modeTabs.appendChild(btn);
  });

  const isOnlineWins = lbMode === 'online';
  let trackId = 0;
  if(!isOnlineWins) {
    trackTabs.style.display = '';
    if(!TRACKS[lbTrack]) lbTrack = 0;
    trackTabs.innerHTML = '';
    TRACKS.forEach((t, i) => {
      const btn = document.createElement('button');
      btn.className = 'lb-tab' + (lbTrack === i ? ' active' : '');
      btn.textContent = t.name;
      btn.style.borderColor = (t.borderColor || '#00f5ff') + '66';
      btn.onclick = () => { lbTrack = i; buildLeaderboardScreen(); };
      trackTabs.appendChild(btn);
    });

    const track = TRACKS[lbTrack] || TRACKS[0];
    trackId = track ? track.id : lbTrack;
    if(panelTitle) {
      panelTitle.textContent = lbMode === 'versus'
        ? `${track.name} · BEST VERSUS LAPS`
        : `${track.name} · BEST LAPS`;
    }
  } else {
    trackTabs.style.display = 'none';
    if(panelTitle) panelTitle.textContent = 'ONLINE WINS · GLOBAL RANKINGS';
  }

  const head = document.querySelector('#screen-leaderboard .lb-head');
  if(head) head.style.display = '';
  content.innerHTML = `
    <div class="lb-empty">
      <div class="lb-empty-title">LOADING RECORDS...</div>
      <div class="lb-empty-sub">${isOnlineWins ? 'Fetching global online win counts.' : 'Fetching the cloud leaderboard for this track.'}</div>
    </div>`;

  let entries = [];
  if(isOnlineWins) {
    let cloudEntries = [];
    let cloudErr = null;
    try {
      const data = await leaderboardFetchJson(`/api/leaderboard?mode=online&trackId=0&t=${Date.now()}`);
      if(seq !== _lbBuildSeq) return;
      cloudEntries = (data && data.scores) || [];
    } catch(e) {
      cloudErr = e;
    }

    const seedEntries = await fetchOnlineWinsSeed();
    entries = mergeOnlineWinsEntries(cloudEntries, seedEntries);

    if(!entries.length) {
      if(head) head.style.display = 'none';
      content.innerHTML = `
        <div class="lb-empty">
          <div class="lb-empty-title">LEADERBOARD OFFLINE</div>
          <div class="lb-empty-sub">${cloudErr && cloudErr.message ? String(cloudErr.message).replace(/_/g,' ') : 'Could not reach the cloud leaderboard, and no seed data was found.'}</div>
        </div>`;
      return;
    }
  } else {
    try {
      const data = await leaderboardFetchJson(`/api/leaderboard?mode=${encodeURIComponent(lbMode)}&trackId=${encodeURIComponent(trackId)}&t=${Date.now()}`);
      if(seq !== _lbBuildSeq) return;
      entries = ((data && data.scores) || []).slice().sort((a, b) => a.bestLap - b.bestLap).slice(0, 50);
    } catch(e) {
      if(seq !== _lbBuildSeq) return;
      if(head) head.style.display = 'none';
      content.innerHTML = `
        <div class="lb-empty">
          <div class="lb-empty-title">LEADERBOARD OFFLINE</div>
          <div class="lb-empty-sub">${(e && e.message) ? String(e.message).replace(/_/g,' ') : 'Could not reach the cloud leaderboard.'}</div>
        </div>`;
      return;
    }
  }

  if(entries.length === 0) {
    if(head) head.style.display = 'none';
    content.innerHTML = `
      <div class="lb-empty">
        <div class="lb-empty-title">NO RECORDS YET</div>
        <div class="lb-empty-sub">${isOnlineWins ? 'Win an online race in 1st place to climb the board.' : `Finish a ${lbMode === 'versus' ? 'versus race' : 'time trial'} on this track.<br>Your first completed lap will ask for a username once, then auto-save every lap.`}</div>
      </div>`;
    return;
  }

  const rankColors = ['#ffd700', '#c0c0c0', '#cd7f32'];
  let html = entries.map((e, i) => {
    const wins = Number(e && (e.wins != null ? e.wins : e.bestLap != null ? e.bestLap : 0)) || 0;
    const meta = isOnlineWins
      ? (wins > 0 ? `${wins} WINS` : '—')
      : (lbMode === 'versus'
        ? (e.winner ? `WIN ${e.winner}` : '—')
        : (e.total != null ? `RACE ${fmtTime(e.total)}` : 'BEST LAP'));
    const timeVal = isOnlineWins ? String(wins) : fmtTime(e.bestLap);
    return `
      <div class="lb-row${i === 0 ? ' lb-top' : ''}">
        <div class="lb-rank" style="color:${rankColors[i] || 'rgba(255,255,255,.45)'}">${i + 1}</div>
        <div class="lb-name">${e.username || '—'}</div>
        <div class="lb-time">${timeVal}</div>
        <div class="lb-meta">${meta}</div>
        <div class="lb-date">${fmtLbDate(e.createdAt)}</div>
      </div>`;
  }).join('');

  html += `<div class="lb-foot">${isOnlineWins ? `Showing top ${entries.length} · cloud + seed file` : `Showing top ${entries.length} · cloud leaderboard`}</div>`;
  content.innerHTML = html;

  if(lbMode === 'trial' && typeof CG !== 'undefined' && CG.showBoard) {
    const globalBtn = document.createElement('button');
    globalBtn.className = 'btn btn-sm btn-cyan';
    globalBtn.style.cssText = 'margin:14px auto 16px;display:block;';
    globalBtn.textContent = 'GLOBAL LEADERBOARD';
    globalBtn.onclick = () => CG.showBoard(`track_${trackId}_lap`);
    content.appendChild(globalBtn);
  }
}

// ── MENU KEYBOARD NAV ───────────────────────────────────
document.addEventListener('keydown', e => {
  const activePit = (typeof getActivePitSelectionKart === 'function') ? getActivePitSelectionKart() : null;
  if (e.key === 'Escape' && activePit) {
    e.preventDefault();
    return;
  }
  // Escape pauses/resumes during active race
  if (e.key === 'Escape' && canvas.style.display === 'block' && race &&
      (race.phase === 'racing' || race.phase === 'countdown' || race.phase === 'qualifying' || race.phase === 'quali-turn' || race.phase === 'launch')) {
    e.preventDefault();
    if (isPaused) resumeGame(); else pauseGame();
    return;
  }
  if(e.key==='Escape') {
    const menus=['mode','track','results','save','leaderboard','garage','setup','controls','quali-results'];
    const active = menus.find(m=>!document.getElementById('screen-'+m).classList.contains('hidden'));
    if(active==='mode') showScreen('menu');
    else if(active==='track') goBackFromTrack();
    else if(active==='results') showScreen('menu');
    else if(active==='save') showScreen('results');
    else if(active==='leaderboard' || active==='garage' || active==='controls' || active==='quali-results') showScreen('menu');
    else if(active==='setup') showScreen('track');
    else if(canvas.style.display==='block' && race && race.phase==='finished') race.showResults();
  }
});

// Name input uppercase enforcement
document.getElementById('nameInput').addEventListener('input', function(){
  this.value = sanitizeLeaderboardName(this.value);
});
document.getElementById('nameInput').addEventListener('keydown', e=>{
  if(e.key==='Enter') confirmSave();
});
const lbAutoNameInput = document.getElementById('lbAutoNameInput');
if(lbAutoNameInput) {
  lbAutoNameInput.addEventListener('input', function(){
    this.value = sanitizeLeaderboardName(this.value);
  });
  lbAutoNameInput.addEventListener('keydown', e=>{
    if(e.key==='Enter') confirmAutoRegister();
  });
}
void fetchDeviceIdentity();

// ── UPGRADE / COIN / PAINT SYSTEM ──────────────────────
const PAINT_COLORS = [
  {id:'stock',  label:'STOCK',   body:'#cccccc', shadow:'#888888'},
  {id:'cyan',   label:'CYAN',    body:'#00ccff', shadow:'#005f8f'},
  {id:'orange', label:'ORANGE',  body:'#ff6b35', shadow:'#8f2f00'},
  {id:'lime',   label:'LIME',    body:'#39ff14', shadow:'#1a7000'},
  {id:'pink',   label:'PINK',    body:'#ff00cc', shadow:'#880066'},
  {id:'gold',   label:'GOLD',    body:'#ffd700', shadow:'#806800'},
  {id:'white',  label:'WHITE',   body:'#e8e8e8', shadow:'#606060'},
  {id:'red',    label:'RED',     body:'#ff2222', shadow:'#880000'},
  {id:'purple', label:'PURPLE',  body:'#aa44ff', shadow:'#550088'},
  {id:'black',  label:'BLACK',   body:'#1a1a22', shadow:'#050508'},
  {id:'navy',   label:'NAVY',    body:'#1e3a8a', shadow:'#0b1638'},
];

const PAINT_PARTS = [
  { id:'chassis', label:'CHASSIS', meshHints:['body21', 'chassis1'] },
  { id:'rims',    label:'WHEEL RIMS', meshHints:['meshpart1', 'meshpart4'] },
];

function getPaintColor(id) {
  return PAINT_COLORS.find(c => c.id === id) || PAINT_COLORS[0];
}

function defaultLivery(primaryId, accentId) {
  const primary = primaryId || 'stock';
  return {
    chassis: primary,
    rims: accentId || 'stock',
  };
}

function normalizeLivery(raw, fallbackPrimary) {
  const base = defaultLivery(fallbackPrimary || 'stock');
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    chassis: getPaintColor(src.chassis || fallbackPrimary || base.chassis).id,
    rims: getPaintColor(src.rims || src.accents || base.rims).id,
  };
}

function getPlayerLivery(player) {
  const pd = getPlayerData();
  const key = (player === 'p2') ? 'p2livery' : 'p1livery';
  const fallback = (player === 'p2') ? (pd.p2paint || 'stock') : (pd.p1paint || 'stock');
  return normalizeLivery(pd[key], fallback);
}

function setPlayerLiveryPart(player, partId, colorId) {
  if(!PAINT_PARTS.some(p => p.id === partId)) return;
  const pd = getPlayerData();
  const key = (player === 'p2') ? 'p2livery' : 'p1livery';
  const liv = normalizeLivery(pd[key], player === 'p2' ? (pd.p2paint || 'stock') : (pd.p1paint || 'stock'));
  liv[partId] = getPaintColor(colorId).id;
  pd[key] = liv;
  // Keep legacy single paint in sync with chassis for older paths.
  if(partId === 'chassis') pd[player === 'p2' ? 'p2paint' : 'p1paint'] = liv.chassis;
  savePlayerData(pd);
  if(typeof window.refreshCarStages === 'function') window.refreshCarStages();
}

// Expose for the Three.js menu module (ES modules can't see classic-script const bindings).
window.PAINT_COLORS = PAINT_COLORS;
window.PAINT_PARTS = PAINT_PARTS;
window.getPaintColor = getPaintColor;
window.defaultLivery = defaultLivery;
window.normalizeLivery = normalizeLivery;
window.getPlayerLivery = getPlayerLivery;
window.setPlayerLiveryPart = setPlayerLiveryPart;

// Legacy numeric upgrade tree kept for save migration into the part-based development system.
const UPG_DEFS = [
  { id:'speed',    name:'MAX SPEED',     icon:'', costs:[40,100,200,380,700,1200,2000,3200,5000,8000], bonuses:[40,95,175,280,420,590,790,1020,1280,1600] },
  { id:'accel',    name:'ACCELERATION',  icon:'', costs:[35,85,170,320,600,1050,1750,2800,4200,6600],  bonuses:[30,65,120,195,285,395,530,690,880,1100] },
  { id:'traction', name:'TRACTION',      icon:'', costs:[30,75,150,290,540,980,1600,2500,3700,5400],  bonuses:[15,35,60,95,135,185,240,305,380,470]  },
  { id:'braking',  name:'BRAKING',       icon:'', costs:[30,75,150,290,540,980,1600,2500,3700,5400],  bonuses:[60,130,220,340,480,640,820,1020,1250,1500]},
  { id:'handling', name:'HANDLING',      icon:'', costs:[35,85,170,320,600,1050,1750,2800,4200,6600],  bonuses:[0.12,0.26,0.42,0.60,0.82,1.06,1.32,1.60,1.92,2.30]},
];

const DEV_DEFS = [
  {
    id:'engine', name:'ENGINE', icon:'', desc:'Power unit research and driveline upgrades.',
    parts:[
      { id:'eng-intake',      code:'E-01', name:'High-Flow Intake',        researchCost:70,  implementCost:90,  desc:'Sharpen throttle pickup out of slow corners.', bonus:{ accel:26 } },
      { id:'eng-ecu',         code:'E-02', name:'Race ECU Mapping',        researchCost:110, implementCost:140, desc:'Unlocks cleaner fuel and ignition delivery.', bonus:{ speed:30, accel:18 } },
      { id:'eng-internals',   code:'E-03', name:'Forged Internals',        researchCost:170, implementCost:220, desc:'Raises rev ceiling for stronger top-end speed.', bonus:{ speed:52 } },
      { id:'eng-final-drive', code:'E-04', name:'Close-Ratio Final Drive', researchCost:210, implementCost:260, desc:'Improves launch and traction on corner exit.', bonus:{ accel:32, speed:18 } },
    ]
  },
  {
    id:'aero', name:'AERO', icon:'', desc:'Downforce and drag management for corner entry and exit.',
    parts:[
      { id:'aero-front',    code:'A-01', name:'Front Canards',       researchCost:80,  implementCost:100, desc:'Adds front bite in medium-speed sections.', bonus:{ handling:0.14 } },
      { id:'aero-floor',    code:'A-02', name:'Floor Tunnels',       researchCost:120, implementCost:150, desc:'Builds efficient downforce under the kart.', bonus:{ handling:0.22, traction:18 } },
      { id:'aero-diffuser', code:'A-03', name:'Rear Diffuser',       researchCost:165, implementCost:205, desc:'Stabilises rear grip on throttle application.', bonus:{ handling:0.20, traction:24 } },
      { id:'aero-wing',     code:'A-04', name:'Low-Drag Rear Wing',  researchCost:210, implementCost:250, desc:'Balances loaded speed with straight-line efficiency.', bonus:{ speed:24, handling:0.16 } },
    ]
  },
  {
    id:'chassis', name:'CHASSIS', icon:'', desc:'Structure, suspension and braking confidence under load.',
    parts:[
      { id:'chassis-susp',   code:'C-01', name:'Suspension Geometry Kit', researchCost:75,  implementCost:95,  desc:'Keeps the kart settled over weight transfer.', bonus:{ handling:0.16, traction:18 } },
      { id:'chassis-brakes', code:'C-02', name:'Brake Cooling Ducts',     researchCost:105, implementCost:130, desc:'Lets you brake later without fade.', bonus:{ braking:120 } },
      { id:'chassis-weight', code:'C-03', name:'Weight Reduction Pack',   researchCost:150, implementCost:185, desc:'Sheds mass for better rotation and pickup.', bonus:{ accel:22, handling:0.18 } },
      { id:'chassis-rack',   code:'C-04', name:'Quick Steering Rack',     researchCost:185, implementCost:225, desc:'Sharper response when changing direction.', bonus:{ handling:0.28, braking:70 } },
    ]
  }
];

const DEV_PARTS = DEV_DEFS.flatMap(dept =>
  dept.parts.map(part => ({ ...part, departmentId: dept.id, departmentName: dept.name, departmentIcon: dept.icon }))
);

function getDevelopmentPart(partId) {
  return DEV_PARTS.find(part => part.id === partId) || null;
}

function createEmptyDevelopmentState() {
  const state = {};
  DEV_PARTS.forEach(part => { state[part.id] = 0; });
  return state;
}

function applyStagePointsToDepartment(parts, points, targetState) {
  let remaining = Math.max(0, points);
  parts.forEach(part => {
    const stage = Math.max(0, Math.min(2, remaining));
    targetState[part.id] = stage;
    remaining -= stage;
  });
}

function buildLegacyDevelopmentState(legacyUpg) {
  const state = createEmptyDevelopmentState();
  const getLevel = (id) => Math.max(0, Math.min(10, Number((legacyUpg || {})[id]) || 0));
  const deptAverages = {
    engine:  (getLevel('speed') + getLevel('accel')) / 2,
    aero:    (getLevel('speed') + getLevel('handling') + getLevel('traction')) / 3,
    chassis: (getLevel('accel') + getLevel('traction') + getLevel('braking') + getLevel('handling')) / 4,
  };

  DEV_DEFS.forEach(dept => {
    const stagePoints = Math.round((deptAverages[dept.id] / 10) * (dept.parts.length * 2));
    applyStagePointsToDepartment(dept.parts, stagePoints, state);
  });
  return state;
}

function normalizeDevelopmentState(devState, legacyUpg) {
  const source = (devState && Object.keys(devState).length) ? devState : buildLegacyDevelopmentState(legacyUpg);
  const normalized = createEmptyDevelopmentState();
  DEV_PARTS.forEach(part => {
    normalized[part.id] = Math.max(0, Math.min(2, parseInt(source[part.id], 10) || 0));
  });
  return normalized;
}

function getDevelopmentBonuses(devState) {
  const bonus = { speed:0, accel:0, traction:0, braking:0, handling:0 };
  DEV_PARTS.forEach(part => {
    if((devState[part.id] || 0) < 2) return;
    Object.keys(part.bonus).forEach(key => {
      bonus[key] = (bonus[key] || 0) + part.bonus[key];
    });
  });
  return bonus;
}

function formatDevelopmentBonus(bonus) {
  const tags = [];
  if(bonus.speed) tags.push(`+${Math.round(bonus.speed * 0.8)} KM/H TOP`);
  if(bonus.accel) tags.push('+ACCEL');
  if(bonus.traction) tags.push(`+${Math.round(bonus.traction * 0.8)} GRIP`);
  if(bonus.braking) tags.push('+BRAKING');
  if(bonus.handling) tags.push(`+${Math.round(bonus.handling * 100)}% TURN`);
  return tags.join(' · ');
}

function getDevelopmentStageMeta(stage, part) {
  if(stage >= 2) {
    return { status:'IMPLEMENTED', color:'#4ade80', actionLabel:'FITTED', actionCost:0, canAdvance:false };
  }
  if(stage === 1) {
    return { status:'RESEARCH COMPLETE', color:'#ffd700', actionLabel:`IMPLEMENT · ${part.implementCost} COINS`, actionCost:part.implementCost, canAdvance:true };
  }
  return { status:'NOT STARTED', color:'#f472b6', actionLabel:`RESEARCH · ${part.researchCost} COINS`, actionCost:part.researchCost, canAdvance:true };
}

const SETUP_DEFS = [
  { id:'downforce', name:'DOWNFORCE', icon:'', desc:'High grip & tighter turns<br>Lower top speed',  speedMult:0.87, turnMult:1.22, tractBonus:22 },
  { id:'balanced',  name:'BALANCED',  icon:'', desc:'Default configuration<br>All stats normal',    speedMult:1.00, turnMult:1.00, tractBonus:0  },
  { id:'speed',     name:'SPEED RUN', icon:'', desc:'Maximum top speed<br>Less cornering grip',    speedMult:1.14, turnMult:0.82, tractBonus:-12},
  { id:'wet',       name:'WET SETUP', icon:'', desc:'Optimised for rain<br>Better wet traction',   speedMult:0.93, turnMult:1.10, tractBonus:30 },
  // Custom placeholder: actual values are stored per-player in player data under <player>customSetup
  { id:'custom',    name:'CUSTOM',     icon:'', desc:'Create your own setup: tweak speed, downforce and traction', speedMult:1.00, turnMult:1.00, tractBonus:0 },
];

// Triple-slider setup (Downforce / Grip / Brake Bias) maps onto the legacy customSetup fields.
function setupSlidersFromCustom(cust) {
  const c = cust || {};
  let downforce = Number(c.downforce);
  let grip = Number(c.grip);
  let brakeBias = Number(c.brakeBias);
  if(!Number.isFinite(downforce)) {
    // Infer from legacy speed/turn mults (speed-run ≈0, downforce≈100)
    const sm = Number(c.speedMult); const tm = Number(c.turnMult);
    if(Number.isFinite(sm) && Number.isFinite(tm)) {
      downforce = Math.round(((1.14 - sm) / 0.27) * 50 + ((tm - 0.82) / 0.40) * 50) / 1;
      downforce = Math.max(0, Math.min(100, downforce));
    } else downforce = 50;
  }
  if(!Number.isFinite(grip)) {
    const tb = Number(c.tractBonus);
    grip = Number.isFinite(tb) ? Math.max(0, Math.min(100, ((tb + 12) / 42) * 100)) : 50;
  }
  if(!Number.isFinite(brakeBias)) brakeBias = 52;
  return {
    downforce: Math.max(0, Math.min(100, Math.round(downforce))),
    grip: Math.max(0, Math.min(100, Math.round(grip))),
    brakeBias: Math.max(0, Math.min(100, Math.round(brakeBias)))
  };
}

function customSetupFromSliders(sliders) {
  const d = Math.max(0, Math.min(100, Number(sliders.downforce) || 50)) / 100;
  const g = Math.max(0, Math.min(100, Number(sliders.grip) || 50)) / 100;
  const b = Math.max(0, Math.min(100, Number(sliders.brakeBias) || 52)) / 100;
  return {
    downforce: Math.round(d * 100),
    grip: Math.round(g * 100),
    brakeBias: Math.round(b * 100),
    // Legacy gameplay fields consumed by applyUpgradesToKart
    speedMult: 1.14 - d * 0.27,
    turnMult: 0.82 + d * 0.40,
    tractBonus: Math.round(-12 + g * 42),
    brakeMult: 0.92 + b * 0.16
  };
}

function resolvePlayerSetup(pd, player) {
  const setupId = pd[player + 'setup'] || pd.p1setup || 'balanced';
  if(setupId === 'custom') {
    return customSetupFromSliders(setupSlidersFromCustom(pd[player + 'customSetup'] || pd.p1customSetup));
  }
  const preset = SETUP_DEFS.find(s => s.id === setupId) || SETUP_DEFS[1];
  // Convert preset into slider-equivalent custom for consistent application
  const approx = setupSlidersFromCustom({
    speedMult: preset.speedMult,
    turnMult: preset.turnMult,
    tractBonus: preset.tractBonus,
    brakeBias: setupId === 'wet' ? 48 : setupId === 'speed' ? 58 : 52
  });
  return customSetupFromSliders(approx);
}

const PIT_STRATEGY_DEFS = [
  { id:'undercut', label:'UNDERCUT', icon:'', desc:'Pit early for clean air and a softer second stint.', wearOpen:0.42, wearNow:0.58, tyrePref:'soft' },
  { id:'balanced', label:'BALANCED', icon:'', desc:'Normal one-stop window with a medium tyre target.', wearOpen:0.55, wearNow:0.70, tyrePref:'med' },
  { id:'overcut',  label:'OVERCUT',  icon:'', desc:'Stay out longer and lean on track position.', wearOpen:0.66, wearNow:0.82, tyrePref:'hard' },
  { id:'safe',     label:'SAFE',     icon:'', desc:'Only pit when wear gets high or the tyres are failing.', wearOpen:0.78, wearNow:0.92, tyrePref:'hard' },
];

function createDefaultPitStrategyCustom() {
  return { wearOpen:0.55, wearNow:0.70, tyrePref:'med', fuelLoad:55 };
}

function normalizePitStrategyCustom(plan, weather) {
  const fallback = createDefaultPitStrategyCustom();
  const src = (plan && typeof plan === 'object') ? plan : fallback;
  let wearOpen = Number(src.wearOpen);
  let wearNow = Number(src.wearNow);
  let fuelLoad = Number(src.fuelLoad);
  wearOpen = Number.isFinite(wearOpen) ? wearOpen : fallback.wearOpen;
  wearNow = Number.isFinite(wearNow) ? wearNow : fallback.wearNow;
  fuelLoad = Number.isFinite(fuelLoad) ? fuelLoad : fallback.fuelLoad;
  wearOpen = Math.max(0.20, Math.min(0.88, wearOpen));
  wearNow = Math.max(wearOpen + 0.05, Math.min(0.96, wearNow));
  fuelLoad = Math.max(20, Math.min(100, fuelLoad));
  const tyrePref = typeof src.tyrePref === 'string' ? src.tyrePref : fallback.tyrePref;
  return { wearOpen, wearNow, tyrePref, fuelLoad };
}

function getLegacyPitStrategySeed(id) {
  switch(id) {
    case 'undercut': return { wearOpen:0.42, wearNow:0.58, tyrePref:'soft' };
    case 'overcut': return { wearOpen:0.66, wearNow:0.82, tyrePref:'hard' };
    case 'safe': return { wearOpen:0.78, wearNow:0.92, tyrePref:'hard' };
    default: return createDefaultPitStrategyCustom();
  }
}

function getPitStrategyDef(id) {
  if(id && typeof id === 'object') return id;
  return PIT_STRATEGY_DEFS.find(strat => strat.id === id) || PIT_STRATEGY_DEFS[1];
}

function getPlayerPitStrategyPlan(playerData, weather) {
  const weatherId = normalizeWeatherId(weather || (playerData && playerData.weather) || 'dry');
  const seed = (playerData && playerData.pitStrategyCustom) || getLegacyPitStrategySeed((playerData && playerData.pitStrategy) || 'balanced');
  const custom = normalizePitStrategyCustom(seed, weatherId);
  custom.tyrePref = getLegalTyreId(custom.tyrePref, weatherId);
  const tyre = TYRE_DEFS.find(t => t.id === custom.tyrePref) || TYRE_DEFS[1];
  const openPct = Math.round(custom.wearOpen * 100);
  const nowPct = Math.round(custom.wearNow * 100);
  const fuelLoad = custom.fuelLoad != null ? custom.fuelLoad : 55;
  // Base service time 3.0s + fuel trim (UI estimate only — does not alter race timing).
  const estStop = 3.0 + (fuelLoad - 40) * 0.012;
  return {
    id:'custom',
    label:`CUSTOM · ${tyre.label}`,
    icon:'',
    desc:`Pit window opens at ${openPct}% wear, box this lap at ${nowPct}% wear, fit ${tyre.label}.`,
    wearOpen: custom.wearOpen,
    wearNow: custom.wearNow,
    tyrePref: custom.tyrePref,
    fuelLoad,
    estStop
  };
}

function getPitNavIndexForStop(kartIndex, kart, weather) {
  const fallbackTyreId = (kart && kart.tyreId) || 'med';
  const tyreId = (kart && kart.isAI)
    ? getAIPitTyreId(kart, weather)
    : fallbackTyreId;
  let idx = TYRE_DEFS.findIndex(t => t.id === tyreId);
  if(idx < 0) idx = TYRE_DEFS.findIndex(t => t.id === fallbackTyreId);
  return idx < 0 ? 1 : idx;
}

function seedPitStopSelection(kart, kartIndex, weather) {
  if(!kart) return;
  const legal = getLegalTyreDefs(weather);
  // Humans start on their current compound (choose on the spot); AI use their plan.
  const preferId = (kart.isAI)
    ? getAIPitTyreId(kart, weather)
    : (kart.tyreId || 'med');
  let idx = legal.findIndex(t => t.id === getLegalTyreId(preferId, weather));
  if(idx < 0) idx = 0;
  kart.pitNavIdx = idx;
  kart.pitTyreChoice = legal[idx].id;
  kart.pitNavCooldown = 0;
}

function getPitCallStatus(kart, totalLaps, strategyId, weather) {
  if(!kart || kart.finished || kart.inPit || kart.pitPhase !== null || kart._hasPitted) return null;
  if((totalLaps || 0) <= 1) return null;

  const strat = getPitStrategyDef(strategyId);
  const lapsAfterThisLap = Math.max(0, (totalLaps || 0) - (kart.lap + 1));
  let wearOpen = strat.wearOpen;
  let wearNow = strat.wearNow;
  if(isWetWeather(weather)) {
    wearOpen = Math.max(0.24, wearOpen - 0.08);
    wearNow = Math.max(0.38, wearNow - 0.10);
  }
  if(kart.tyreWrongWeather) {
    wearOpen = Math.min(wearOpen, 0.20);
    wearNow = Math.min(wearNow, 0.36);
  }

  if(kart.tyreWear >= 0.98 || kart.tyreWrongWeather) {
    return { level:'critical', strategy:strat, message:'BOX NOW' };
  }
  if(lapsAfterThisLap <= 0) return null;
  if(kart.tyreWear >= wearNow) return { level:'now', strategy:strat, message:'BOX THIS LAP' };
  if(kart.tyreWear >= wearOpen) return { level:'window', strategy:strat, message:'PIT WINDOW OPEN' };
  return null;
}

function getAiPitStrategyId(aiIndex, difficulty, totalLaps) {
  const plans = totalLaps >= 5
    ? ['undercut','balanced','overcut','safe']
    : ['undercut','balanced','balanced','overcut'];
  const diffOffset = { ultraeasy:0, easy:0, medium:1, hard:2, extreme:3 }[difficulty] || 1;
  return plans[(aiIndex + diffOffset) % plans.length];
}

const WEATHER_DEFS = [
  { id:'dry',   label:'DRY ',   icon:'', gripMult:1.0,  speedPen:0.00, ambientTemp:32 },
  { id:'wet',   label:'WET ',   icon:'', gripMult:0.78, speedPen:0.08, ambientTemp:18 },
  { id:'heavy', label:'STORM', icon:'', gripMult:0.66, speedPen:0.14, ambientTemp:12 },
];

function normalizeWeatherId(weather) {
  if(weather === 'rain') return 'wet';
  return WEATHER_DEFS.some(w => w.id === weather) ? weather : 'dry';
}

function isWetWeather(weather) {
  const weatherId = normalizeWeatherId(weather);
  return weatherId === 'wet' || weatherId === 'heavy';
}

function getPreferredWetTyreId(weather) {
  return normalizeWeatherId(weather) === 'heavy' ? 'wet' : 'ints';
}

function isTyreSelectableForWeather(tyre, weather) {
  const wetRace = isWetWeather(weather);
  if(tyre.wetOnly) return wetRace;
  if(tyre.dryOnly) return !wetRace;
  return true;
}

function getLegalTyreDefs(weather) {
  const list = TYRE_DEFS.filter(t => isTyreSelectableForWeather(t, weather));
  if(list.length) return list;
  return [TYRE_DEFS.find(t => t.id === 'med') || TYRE_DEFS[1]];
}

function isTyreWrongForWeather(tyre, weather) {
  const wetRace = isWetWeather(weather);
  return (!wetRace && tyre.dryPenalty) || (wetRace && tyre.dryOnly);
}

function getLegalTyreId(tyreId, weather) {
  const tyre = TYRE_DEFS.find(t => t.id === tyreId);
  if(!tyre) return isWetWeather(weather) ? getPreferredWetTyreId(weather) : 'med';
  if(tyre.wetOnly && !isWetWeather(weather)) return 'med';
  if(tyre.dryOnly && isWetWeather(weather)) return getPreferredWetTyreId(weather);
  return tyreId;
}

function getAIPitTyreId(kart, weather) {
  if(isWetWeather(weather)) return getPreferredWetTyreId(weather);
  const plan = getPitStrategyDef(kart && kart.aiPitPlan);
  if(plan.tyrePref === 'soft' && kart.tyreWear < 0.82) return 'soft';
  if(plan.tyrePref === 'hard' || kart.tyreWear > 0.62) return 'hard';
  return 'med';
}

function normalizeCollisionMode(mode) {
  return mode === 'nocollision' ? 'nocollision' : 'collision';
}

function isKartContactEnabled() {
  return !race || normalizeCollisionMode(race.collisionMode) === 'collision';
}

// Tyre compounds: lifespan = average laps before worn (at default 3-lap race)
// idealMin/idealMax = optimal temperature window (°C); heatRate/coolRate scale thermal response
const TYRE_DEFS = [
  { id:'soft',  label:'SOFT',  color:'#ff3333', lifespan:14, desc:'Max grip · ~14 lap life',      gripBonus:0.14, speedBonus:28,  dryOnly:true,  idealMin:86, idealMax:108, heatRate:1.12, coolRate:0.95 },
  { id:'med',   label:'MED',   color:'#ffd700', lifespan:28, desc:'Balanced · ~28 lap life',      gripBonus:0.05, speedBonus:10,  dryOnly:true,  idealMin:82, idealMax:103, heatRate:1.05, coolRate:1.00 },
  { id:'hard',  label:'HARD',  color:'#aaaaaa', lifespan:55, desc:'Durable · ~55 lap life',       gripBonus:-0.04, speedBonus:-12, dryOnly:true,  idealMin:78, idealMax:102,  heatRate:0.95, coolRate:1.05 },
  { id:'ints',  label:'INTS',  color:'#44bb44', lifespan:40, desc:'Light rain · ~40 lap life',    gripBonus:0.08, speedBonus:-5,  wetOnly:false, dryPenalty:true, idealMin:66, idealMax:92, heatRate:1.00, coolRate:1.05 },
  { id:'wet',   label:'WET',   color:'#4488ff', lifespan:40, desc:'Heavy rain · ~40 lap life',    gripBonus:0.22, speedBonus:-20, wetOnly:true,  dryPenalty:true, idealMin:52, idealMax:82, heatRate:0.92, coolRate:1.08 },
];

const TYRE_TEMP_COLORS = {
  cold: '#3b82f6',
  optimal: '#22c55e',
  hot: '#f97316',
  overheated: '#ef4444',
};

function getTyreAmbientTemp(weather, trackData) {
  const wx = WEATHER_DEFS.find(w => w.id === normalizeWeatherId(weather)) || WEATHER_DEFS[0];
  let amb = wx.ambientTemp != null ? wx.ambientTemp : 28;
  if(trackData && trackData.surface && /HEAT/i.test(trackData.surface.label || '')) amb += 8;
  return amb;
}

function getTyreTempState(temp, tyreDef) {
  const lo = tyreDef && tyreDef.idealMin != null ? tyreDef.idealMin : 85;
  const hi = tyreDef && tyreDef.idealMax != null ? tyreDef.idealMax : 100;
  // Soft shoulders so borderline temps stay "optimal" longer
  if(temp < lo - 2) return 'cold';
  if(temp <= hi + 2) return 'optimal';
  if(temp <= hi + 16) return 'hot';
  return 'overheated';
}

/** Subtle grip multiplier from tyre temperature (≈0.90–1.0). */
function getTyreTempGripMult(temp, tyreDef) {
  const lo = tyreDef && tyreDef.idealMin != null ? tyreDef.idealMin : 85;
  const hi = tyreDef && tyreDef.idealMax != null ? tyreDef.idealMax : 100;
  if(temp >= lo - 2 && temp <= hi + 2) return 1.0;
  if(temp < lo) {
    const depth = Math.min(1, (lo - temp) / 34);
    return Math.max(0.90, 1 - depth * 0.10);
  }
  const over = temp - hi;
  if(over <= 16) return Math.max(0.95, 1 - (over / 16) * 0.05);
  return Math.max(0.88, 0.95 - ((over - 16) / 24) * 0.07);
}

/** Extra wear rate multiplier when hot / overheated. */
function getTyreTempWearMult(temp, tyreDef) {
  const hi = tyreDef && tyreDef.idealMax != null ? tyreDef.idealMax : 100;
  if(temp <= hi) return 1.0;
  const over = temp - hi;
  if(over <= 12) return 1.0 + over / 12 * 0.12;      // hot: up to +12%
  return 1.12 + Math.min(0.28, (over - 12) / 20 * 0.28); // overheated: up to +40%
}

/** Brake effectiveness from temp (cold & overheated = longer stopping distance). */
function getTyreTempBrakeMult(temp, tyreDef) {
  const lo = tyreDef && tyreDef.idealMin != null ? tyreDef.idealMin : 85;
  const hi = tyreDef && tyreDef.idealMax != null ? tyreDef.idealMax : 100;
  if(temp < lo) {
    const depth = Math.min(1, (lo - temp) / 28);
    return Math.max(0.90, 1 - depth * 0.10);
  }
  if(temp > hi + 12) {
    const over = Math.min(1, (temp - (hi + 12)) / 20);
    return Math.max(0.88, 1 - over * 0.12);
  }
  return 1.0;
}

/** Traction / accel effectiveness (cold = poor drive-out). */
function getTyreTempTractMult(temp, tyreDef) {
  const lo = tyreDef && tyreDef.idealMin != null ? tyreDef.idealMin : 85;
  if(temp >= lo) return 1.0;
  const depth = Math.min(1, (lo - temp) / 28);
  return Math.max(0.90, 1 - depth * 0.10);
}

// Calculate actual tyre lifespan (in laps) for a given track and tyre
function getTyreLapLifespan(trackId, tyreId) {
  const track = TRACKS.find(t => t.id === trackId);
  const tyre = TYRE_DEFS.find(t => t.id === tyreId);
  if (!track || !tyre || !track.lapDistance) return '?';
  const lapCount = (tyre.lifespan * 3200) / track.lapDistance;
  return Math.round(lapCount);
}

// ── KEY BINDINGS ────────────────────────────────────────
const DEFAULT_BINDINGS = {
  p1: {up:'w', down:'s', left:'a', right:'d', pit:'p', ers:'x', drs:'c', ersMode:'toggle', drsMode:'toggle'},
  p2: {up:'ArrowUp', down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight', pit:'/', ers:'.', drs:',', ersMode:'toggle', drsMode:'toggle'}
};
let BINDINGS = {p1:{...DEFAULT_BINDINGS.p1}, p2:{...DEFAULT_BINDINGS.p2}};
(function(){
  try {
    const s = localStorage.getItem('kartblitz_bindings');
    if(s){ const b=JSON.parse(s); BINDINGS.p1={...DEFAULT_BINDINGS.p1,...b.p1}; BINDINGS.p2={...DEFAULT_BINDINGS.p2,...b.p2}; }
  } catch(e){}
})();
function saveBindings(){ try{ localStorage.setItem('kartblitz_bindings',JSON.stringify(BINDINGS)); }catch(e){} }
function keyLabel(k){
  const M={'ArrowUp':'↑','ArrowDown':'↓','ArrowLeft':'←','ArrowRight':'→',' ':'SPC','Escape':'ESC','Enter':'↵','Backspace':'','Shift':'⇧','Control':'Ctrl','Alt':'Alt','Tab':'Tab','CapsLock':'CAPS',' ':' '};
  return M[k]||(k&&k.length===1?k.toUpperCase():k)||'?';
}
function keyActive(k){
  if(!k) return false;
  return !!(keys[k]||(k.length===1&&(keys[k.toLowerCase()]||keys[k.toUpperCase()])));
}

// ── REBIND LISTENER (capture phase — fires before game keydown) ──────────
let _rebindState = null;
document.addEventListener('keydown', function(e){
  if(!_rebindState) return;
  if(e.key === 'Escape'){
    e.preventDefault(); e.stopImmediatePropagation();
    _rebindState = null; buildBindingsPane(); return;
  }
  const bad = ['Shift','Control','Alt','Meta','CapsLock','NumLock','ScrollLock','Dead','Unidentified','F8','F9'];
  if(bad.includes(e.key)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const incoming = e.key;
  // Reject duplicates across both players / actions.
  for(const player of ['p1','p2']) {
    for(const action of Object.keys(BINDINGS[player])) {
      if(player === _rebindState.player && action === _rebindState.action) continue;
      if(action === 'ersMode' || action === 'drsMode') continue;
      const existing = BINDINGS[player][action];
      if(existing && String(existing).toLowerCase() === String(incoming).toLowerCase()) {
        try { beep(200, 0.12, 0.35, 'sawtooth'); } catch(err){}
        _rebindState = null;
        buildBindingsPane();
        return;
      }
    }
  }
  BINDINGS[_rebindState.player][_rebindState.action] = incoming;
  saveBindings();
  _rebindState = null;
  buildBindingsPane();
}, true);

// ── CONTROLS SCREEN FUNCTIONS ────────────────────────────
function showControlsScreen(){
  showScreen('controls');
  buildBindingsPane();
  buildSettingsPane();
  if(!document.getElementById('ctrl-pane-howto').dataset.built) buildHowToPane();
  switchCtrlTab('bindings');
}
function switchCtrlTab(tab){
  document.getElementById('ctab-bindings').classList.toggle('active', tab==='bindings');
  const settingsTab = document.getElementById('ctab-settings');
  if (settingsTab) settingsTab.classList.toggle('active', tab==='settings');
  document.getElementById('ctab-howto').classList.toggle('active', tab==='howto');
  document.getElementById('ctrl-pane-bindings').style.display = tab==='bindings' ? '' : 'none';
  const settingsPane = document.getElementById('ctrl-pane-settings');
  if (settingsPane) settingsPane.style.display = tab==='settings' ? '' : 'none';
  document.getElementById('ctrl-pane-howto').style.display   = tab==='howto'     ? '' : 'none';
  if(tab==='howto' && !document.getElementById('ctrl-pane-howto').dataset.built) buildHowToPane();
  if(tab==='settings') buildSettingsPane();
}
function refreshSettingsPane() {
  const pane = document.getElementById('ctrl-pane-settings');
  if (pane && pane.style.display !== 'none' && !pane.classList.contains('hidden')) {
    buildSettingsPane();
  }
}
function buildSettingsPane(){
  const pane = document.getElementById('ctrl-pane-settings');
  if (!pane) return;
  const platformLocked = isPlatformMuted();
  const muted = isEffectivelyMuted();
  const muteLabel = platformLocked
    ? 'MUTED BY PLATFORM'
    : (isUserMuted() ? 'SOUND: OFF' : 'SOUND: ON');
  const q = _qualityLevel;
  const modeLabel = touchMode ? 'TOUCH' : 'KEYBOARD';
  pane.innerHTML = `
    <div class="howto-section" style="width:min(560px,94vw);">
      <div class="howto-heading"> CONTROL MODE</div>
      <p>Keyboard uses remappable bindings. Touch enables on-screen joysticks (face-to-face layout in 2-player).</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:12px;">
        <button class="key-btn${!touchMode?' key-btn-active':''}" onclick="setDeviceMode(false);playUIClick();buildSettingsPane();">KEYBOARD</button>
        <button class="key-btn${touchMode?' key-btn-active':''}" onclick="setDeviceMode(true);playUIClick();buildSettingsPane();">TOUCH</button>
      </div>
      <p style="text-align:center;margin-top:10px;font-size:12px;opacity:.55;">Current: <strong style="color:var(--cyan)">${modeLabel}</strong></p>
    </div>
    <div class="howto-section" style="width:min(560px,94vw);">
      <div class="howto-heading"> AUDIO</div>
      <p>Mute stops all engine and UI sounds. CrazyGames platform mute always overrides the in-game toggle.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:12px;">
        <button class="btn btn-sm ${muted ? 'btn-orange' : 'btn-cyan'}"
          onclick="initAudio();toggleUserMute();playUIClick();buildSettingsPane();"
          ${platformLocked ? 'disabled style="opacity:.45;cursor:not-allowed;"' : ''}>
          ${muteLabel}
        </button>
      </div>
      ${platformLocked ? '<p class="howto-tip">Platform muteAudio is active — sound stays off until CrazyGames unmutes.</p>' : ''}
    </div>
    <div class="howto-section" style="width:min(560px,94vw);">
      <div class="howto-heading"> GRAPHICS QUALITY</div>
      <p>Lower quality improves performance on Chromebooks and smaller iframes. You can also cycle with F8 in-race.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:12px;">
        ${['low','medium','high'].map(level => `
          <button class="key-btn${q===level?' key-btn-active':''}" onclick="setQualityLevel('${level}');playUIClick();">${level.toUpperCase()}</button>
        `).join('')}
      </div>
      <p style="text-align:center;margin-top:10px;font-size:12px;opacity:.55;">Current: <strong style="color:var(--cyan)">${q.toUpperCase()}</strong></p>
    </div>
    <div class="howto-section" style="width:min(560px,94vw);border-bottom:none;">
      <div class="howto-heading"> QUICK TIPS</div>
      <div class="info-kv"><span class="info-k">TIME TRIAL</span><span class="info-v">From the title screen, jump straight to circuit select for a solo session.</span></div>
      <div class="info-kv"><span class="info-k">PAUSE</span><span class="info-v">Press Esc, or the pause button in touch mode.</span></div>
      <div class="info-kv"><span class="info-k">TOUCH</span><span class="info-v">Joystick steers and throttles; switch mode anytime in Settings.</span></div>
    </div>
  `;
}
function startRebind(player, action){
  _rebindState = {player, action};
  document.querySelectorAll('.key-btn').forEach(b=>b.classList.remove('listening'));
  const btn = document.getElementById('kb-'+player+'-'+action);
  if(btn){ btn.classList.add('listening'); btn.textContent = 'PRESS KEY…'; }
  const hint = document.getElementById('rebind-hint');
  if(hint) hint.textContent = 'Press any key to assign · ESC to cancel';
}
function resetBindings(){
  BINDINGS = {p1:{...DEFAULT_BINDINGS.p1}, p2:{...DEFAULT_BINDINGS.p2}};
  saveBindings();
  buildBindingsPane();
}
function setMode(player, key, val){
  BINDINGS[player][key] = val;
  saveBindings();
  buildBindingsPane();
}
function buildBindingsPane(){
  _rebindState = null;
  const ACTIONS = [
    {id:'up',    label:'Accelerate',      icon:''},
    {id:'down',  label:'Brake / Reverse', icon:''},
    {id:'left',  label:'Steer Left',      icon:''},
    {id:'right', label:'Steer Right',     icon:''},
    {id:'pit',   label:'Pit Stop',        icon:''},
    {id:'ers',   label:'ERS Boost',       icon:''},
    {id:'drs',   label:'DRS Open',        icon:''},
  ];
  const playerColor = ['#00f5ff','#ff6b35'];
  const pane = document.getElementById('ctrl-pane-bindings');
  pane.innerHTML = `
    <div class="ctrl-player-grid">
      ${['p1','p2'].map((p,pi) => `
        <div class="ctrl-player-card">
          <div class="ctrl-player-head" style="color:${playerColor[pi]}">PLAYER ${pi+1}</div>
          ${ACTIONS.map(a => `
            <div class="ctrl-action-row">
              <div class="ctrl-action-label">
                <span class="ctrl-action-icon">${a.icon}</span>${a.label}
              </div>
              <button class="key-btn" id="kb-${p}-${a.id}" onclick="startRebind('${p}','${a.id}')">${keyLabel(BINDINGS[p][a.id])}</button>
            </div>
          `).join('')}
          <div class="ctrl-mode-section">
            <div class="ctrl-mode-row">
              <span class="ctrl-mode-label"> ERS MODE</span>
              <div class="ctrl-mode-btns">
                <button class="key-btn${(BINDINGS[p].ersMode||'toggle')==='toggle'?' key-btn-active':''}" onclick="setMode('${p}','ersMode','toggle')">TOGGLE</button>
                <button class="key-btn${(BINDINGS[p].ersMode||'toggle')==='hold'?' key-btn-active':''}" onclick="setMode('${p}','ersMode','hold')">HOLD</button>
              </div>
            </div>
            <div class="ctrl-mode-row">
              <span class="ctrl-mode-label"> DRS MODE</span>
              <div class="ctrl-mode-btns">
                <button class="key-btn${(BINDINGS[p].drsMode||'toggle')==='toggle'?' key-btn-active':''}" onclick="setMode('${p}','drsMode','toggle')">TOGGLE</button>
                <button class="key-btn${(BINDINGS[p].drsMode||'toggle')==='hold'?' key-btn-active':''}" onclick="setMode('${p}','drsMode','hold')">HOLD</button>
              </div>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
    <div class="ctrl-reset-row" style="margin-top:10px;">
      <button class="btn btn-sm ${isEffectivelyMuted() ? 'btn-orange' : 'btn-cyan'}"
        onclick="initAudio();toggleUserMute();playUIClick();buildBindingsPane();"
        ${isPlatformMuted() ? 'disabled style="opacity:.45;cursor:not-allowed;"' : ''}>
        ${isPlatformMuted() ? 'MUTED BY PLATFORM' : (isUserMuted() ? 'UNMUTE' : 'MUTE')}
      </button>
      <button class="btn btn-orange btn-sm" onclick="resetBindings()">RESET TO DEFAULTS</button>
    </div>
    <div id="rebind-hint" style="font-size:11px;opacity:.4;letter-spacing:.14em;margin-top:10px;min-height:18px;text-align:center;"></div>
    <div style="font-size:10px;opacity:.28;letter-spacing:.1em;margin-top:4px;text-align:center;">CLICK A KEY TO REBIND IT</div>
  `;
}
function buildHowToPane(){
  const pane = document.getElementById('ctrl-pane-howto');
  pane.dataset.built = '1';
  pane.innerHTML = `
    <div class="howto-section">
      <div class="howto-heading"> CAR CONTROLS</div>
      <div class="info-kv"><span class="info-k">ACCELERATE</span><span class="info-v">Hold to build speed. The car accelerates based on your engine upgrade level.</span></div>
      <div class="info-kv"><span class="info-k">BRAKE</span><span class="info-v">Hold to slow down. Hold when already stopped to reverse slowly.</span></div>
      <div class="info-kv"><span class="info-k">STEER</span><span class="info-v">Turn left or right. Steering becomes less responsive at very high speeds — this is intentional.</span></div>
      <div class="info-kv"><span class="info-k">COAST</span><span class="info-v">Release the accelerator without braking and the car slows down gently due to friction.</span></div>
      <p class="howto-tip">Off-track grass applies heavy drag. Cutting corners usually costs more time than it saves.</p>
    </div>

    <div class="howto-section">
      <div class="howto-heading"> TIME TRIAL</div>
      <p>Open solo session against the clock in dry conditions. Keep pushing laps until you end the session.</p>
      <div class="info-kv"><span class="info-k">SETUP</span><span class="info-v">Only car setup before you start — no lap count, weather, or pit strategy.</span></div>
      <div class="info-kv"><span class="info-k">START</span><span class="info-v">You load in the pit garage, pick tyres, then drive out onto the circuit.</span></div>
      <div class="info-kv"><span class="info-k">CURRENT LAP</span><span class="info-v">Timer counting up from when you crossed the start line.</span></div>
      <div class="info-kv"><span class="info-k">BEST LAP</span><span class="info-v">Your fastest lap this session. Flashes gold when you set a new personal best.</span></div>
      <div class="info-kv"><span class="info-k">TARGET</span><span class="info-v">Par time for the track shown in orange. Beat it for a coin bonus.</span></div>
      <div class="info-kv"><span class="info-k">EXIT</span><span class="info-v">Pause and choose End Session any time — there is no fixed lap total.</span></div>
      <p class="howto-tip">DRS is always available in Time Trial — use it freely in every DRS zone.</p>
    </div>

    <div class="howto-section">
      <div class="howto-heading"> VERSUS RACE</div>
      <p>Two players race head-to-head on a split screen. Both share the same team build and R&amp;D; each can still use their own paint.</p>
      <div class="info-kv"><span class="info-k">WINNER</span><span class="info-v">First player to complete all laps.</span></div>
      <div class="info-kv"><span class="info-k">SLIPSTREAM</span><span class="info-v">Follow within ~600 units behind the other kart to gain +10% top speed automatically.</span></div>
      <div class="info-kv"><span class="info-k">DRS RULE</span><span class="info-v">The trailing car can only activate DRS when within ~1 second of the car ahead.</span></div>
      <p class="howto-tip">Slipstream + DRS + ERS stacked together closes large gaps fast on a straight.</p>
    </div>

    <div class="howto-section">
      <div class="howto-heading"> CHECKPOINTS &amp; LAPS</div>
      <p>Each circuit has numbered gate lines between the start/finish line. You must cross them in order.</p>
      <div class="info-kv"><span class="info-k">YELLOW GATE</span><span class="info-v">Checkpoint not yet reached this lap.</span></div>
      <div class="info-kv"><span class="info-k">GREEN GATE</span><span class="info-v">Checkpoint passed in the correct order.</span></div>
      <div class="info-kv"><span class="info-k">VALID LAP</span><span class="info-v">All intermediate checkpoints must be crossed in sequence before the S/F line counts the lap.</span></div>
      <div class="info-kv"><span class="info-k">INVALID LAP</span><span class="info-v">If you miss or skip a gate, the S/F crossing is ignored. Complete the circuit again.</span></div>
      <p class="howto-tip">Cutting a corner to skip a gate is the most common trap on technical tracks.</p>
    </div>

    <div class="howto-section">
      <div class="howto-heading"> TYRE COMPOUNDS</div>
      <p>Pick your compound in Race Setup. Grip, speed, and lifespan vary by compound.</p>
      <div class="info-kv"><span class="info-k">SOFT</span><span class="info-v">Fastest but wears quickly — ~14 laps. Best for short stints.</span></div>
      <div class="info-kv"><span class="info-k">MEDIUM</span><span class="info-v">Balanced all-rounder — ~28 laps. Good default for most races.</span></div>
      <div class="info-kv"><span class="info-k">HARD</span><span class="info-v">Durable, slower peak — ~55 laps. Consistent pace for long stints.</span></div>
      <div class="info-kv"><span class="info-k">INTERS</span><span class="info-v">Damp / transition conditions — ~40 laps. Penalised on fully dry or heavy rain.</span></div>
      <div class="info-kv"><span class="info-k">WET</span><span class="info-v">Rain specialist — ~40 laps. Very slow on dry track. Best in heavy rain.</span></div>
      <div class="info-kv"><span class="info-k">WEAR BAR</span><span class="info-v">HUD shows remaining tyre life. Colour goes green → yellow → red as it depletes.</span></div>
      <div class="info-kv"><span class="info-k">TYRE FAILURE</span><span class="info-v">At 0% life the car hard-caps at 100 km/h. A flashing red warning appears. Pit immediately.</span></div>
      <p class="howto-tip">Running the wrong compound for the weather is extremely slow. Always match tyres to conditions.</p>
    </div>

    <div class="howto-section">
      <div class="howto-heading"> PIT STOPS</div>
      <p>Stop at the garage to swap tyres mid-race. Drive the pit lane — cars never teleport into the box.</p>
      <div class="info-kv"><span class="info-k">1. SIGNAL</span><span class="info-v">Press PIT near the pit entry (or just drive in). The car commits to the pit lane route.</span></div>
      <div class="info-kv"><span class="info-k">2. PIT LANE</span><span class="info-v">Follow the pit lane to the orange garage box. Speed is limited in the lane.</span></div>
      <div class="info-kv"><span class="info-k">3. SERVICE</span><span class="info-v">The race pauses while you pick tyres. In versus the menu only covers the pitting player's half. Press W (P1) or ↑ (P2) to confirm.</span></div>
      <div class="info-kv"><span class="info-k">4. EXIT</span><span class="info-v">After the 3s tyre change, drive the pit lane to the exit and merge back onto the circuit.</span></div>
      <p class="howto-tip">Pressing PIT outside the entry zone shows a "NOT IN PIT ZONE" warning — find the pit entry first.</p>
    </div>

    <div class="howto-section">
      <div class="howto-heading"> ERS — ENERGY RECOVERY SYSTEM</div>
      <p>A deployable battery that boosts your top speed by up to +25% while active. Drains over ~5 seconds. Charge recovers from lifting, coasting, braking, and long straights — not a free passive refill.</p>
      <div class="info-kv"><span class="info-k">TOGGLE MODE</span><span class="info-v">Press once to activate, press again to deactivate. ERS turns off automatically when the charge hits zero.</span></div>
      <div class="info-kv"><span class="info-k">HOLD MODE</span><span class="info-v">Active while you hold the key down. Releases when you let go.</span></div>
      <div class="info-kv"><span class="info-k">EXIT</span><span class="info-v">When ERS ends, boost and acceleration blend out over ~1 second — momentum decays naturally with no instant speed cut.</span></div>
      <div class="info-kv"><span class="info-k">REGEN</span><span class="info-v">Heavy braking harvests more than light braking. Lift/coast recover moderate energy. Long straights add a small passive trickle.</span></div>
      <div class="info-kv"><span class="info-k">HUD BAR</span><span class="info-v">Glows bright cyan when active. Yellow → red as the charge drains.</span></div>
      <div class="info-kv"><span class="info-k">BLOCKED</span><span class="info-v">ERS cannot be deployed while off the track.</span></div>
      <p class="howto-tip">Deploy ERS exiting slow corners or for overtakes, not on straights where you're already flat-out.</p>
    </div>

    <div class="howto-section">
      <div class="howto-heading"> DRS — DRAG REDUCTION SYSTEM</div>
      <p>Opens the rear wing to reduce drag, giving +15% top speed on designated blue-gate straights.</p>
      <div class="info-kv"><span class="info-k">TOGGLE MODE</span><span class="info-v">Press once inside a zone to open DRS, press again to close it. Closes automatically when you leave the zone.</span></div>
      <div class="info-kv"><span class="info-k">HOLD MODE</span><span class="info-v">Active while you hold the key inside the zone. Closes on release or when you exit the zone.</span></div>
      <div class="info-kv"><span class="info-k">AVAILABLE</span><span class="info-v">HUD shows "DRS" in dim blue — you're in a zone and eligible.</span></div>
      <div class="info-kv"><span class="info-k">LOCKED</span><span class="info-v">HUD shows "DRS LOCKED" — you're in a zone but too far behind in Versus mode.</span></div>
      <div class="info-kv"><span class="info-k">TIME TRIAL</span><span class="info-v">DRS is always available, no gap check required.</span></div>
      <div class="info-kv"><span class="info-k">VERSUS</span><span class="info-v">DRS unlocks for the trailing car only when within ~1 second of the leader.</span></div>
      <p class="howto-tip">DRS + ERS stacked = massive straight-line speed for a late-braking overtake into a hairpin.</p>
    </div>

    <div class="howto-section">
      <div class="howto-heading"> GARAGE — DEVELOPMENT &amp; PAINT</div>
      <p>Open the Garage to run a proper development programme. Each part now has a research cost and an implementation cost before the upgrade becomes live on the kart.</p>
      <div class="info-kv"><span class="info-k">ENGINE</span><span class="info-v">Power unit work like intake, ECU, internals, and final-drive upgrades improves top speed and acceleration.</span></div>
      <div class="info-kv"><span class="info-k">AERO</span><span class="info-v">Canards, floor work, diffusers, and wing packages improve downforce grip, balance, and loaded speed.</span></div>
      <div class="info-kv"><span class="info-k">CHASSIS</span><span class="info-v">Suspension, brake cooling, weight reduction, and steering hardware improve braking confidence, response, and mechanical grip.</span></div>
      <div class="info-kv"><span class="info-k">RESEARCH</span><span class="info-v">The first purchase completes the R&amp;D phase and unlocks the part for fitting.</span></div>
      <div class="info-kv"><span class="info-k">IMPLEMENT</span><span class="info-v">The second purchase fits the package to the kart. Only implemented parts affect performance.</span></div>
      <div class="info-kv"><span class="info-k">CUSTOM SETUP</span><span class="info-v">Choose the CUSTOM setup in Race Setup to manually tune Top Speed Trim, Downforce Grip Bias, and Mechanical Traction Assist before a race.</span></div>
      <div class="info-kv"><span class="info-k">PAINT</span><span class="info-v">Cosmetic only. P1 and P2 can still use different liveries.</span></div>
      <p class="howto-tip">There is one shared team build and R&amp;D programme — both karts always get the same performance upgrades.</p>
    </div>

    <div class="howto-section" style="border-bottom:none">
      <div class="howto-heading">COINS COINS &amp; TRACK UNLOCKS</div>
      <p>Earn coins from every race. Spend them in the Garage on upgrades or unlock premium circuits.</p>
      <div class="info-kv"><span class="info-k">EARNINGS</span><span class="info-v">3 coins per lap + 10 for finishing + 8 bonus for beating the target time. Multiplied by the track's coin rate.</span></div>
      <div class="info-kv"><span class="info-k">CIRCUITS</span><span class="info-v">${TRACKS.length} tracks: a starter pack (Sunset, Meadow, Blue Bay, Hurricane, Riviera) plus challenge circuits (Titan, Amber, Neon).</span></div>
      <div class="info-kv"><span class="info-k">COST RANGE</span><span class="info-v">Starter tracks are free. Amber Highway unlocks for 200 COINS and Neon City GP for 450 COINS .</span></div>
      <p class="howto-tip">For AI races, pick the wider starter circuits (Sunset, Meadow, Blue Bay, Hurricane, Riviera) so the field races cleanly. Save Titan, Amber, and Neon for when you want a tougher layout.</p>
    </div>
  `;
}

function migrateUnlockedTracks(saved) {
  const defaults = (typeof DEFAULT_UNLOCKED_TRACKS !== 'undefined' && DEFAULT_UNLOCKED_TRACKS)
    ? DEFAULT_UNLOCKED_TRACKS.slice()
    : [0, 1, 2, 3, 4, 5];
  if(!Array.isArray(saved) || !saved.length) return defaults;
  const set = new Set(defaults.concat(saved.map(Number).filter(n => Number.isFinite(n))));
  // Legacy 3-track saves had Titan/Amber/Neon free as ids 0/1/2 — grant author pack 5–7.
  const legacyAll = saved.length <= 3 && saved.includes(0) && saved.includes(1) && saved.includes(2);
  if(legacyAll) { set.add(5); set.add(6); set.add(7); }
  return [...set].sort((a, b) => a - b);
}

function getPlayerData() {
  try {
    const d = JSON.parse(localStorage.getItem('kartblitz_player')||'{}');
    const def = () => ({speed:0,accel:0,traction:0,braking:0,handling:0});
    const p1paint = d.p1paint||'cyan';
    const p2paint = d.p2paint||'orange';
    return {
      coins: d.coins||0,
      gems: d.gems||0,
      p1upg: d.p1upg || def(),
      p2upg: d.p2upg || def(),
      p1dev: normalizeDevelopmentState(d.p1dev, d.p1upg),
      p2dev: normalizeDevelopmentState(d.p2dev, d.p2upg),
      p1setup: d.p1setup||'balanced',
      p2setup: d.p2setup||'balanced',
      p1customSetup: d.p1customSetup || { speedMult:1.00, turnMult:1.00, tractBonus:0 },
      p2customSetup: d.p2customSetup || { speedMult:1.00, turnMult:1.00, tractBonus:0 },
      pitStrategy: d.pitStrategy || 'balanced',
      pitStrategyCustom: normalizePitStrategyCustom(d.pitStrategyCustom || getLegacyPitStrategySeed(d.pitStrategy || 'balanced'), normalizeWeatherId(d.weather||'dry')),
      p1paint,
      p2paint,
      p1livery: normalizeLivery(d.p1livery, p1paint),
      p2livery: normalizeLivery(d.p2livery, p2paint),
      weather: normalizeWeatherId(d.weather||'dry'),
      tyres:   d.tyres||'med',
      selectedLaps: d.selectedLaps||3,
      unlockedTracks: migrateUnlockedTracks(d.unlockedTracks),
      trialPits: d.trialPits !== undefined ? d.trialPits : false,
      collisionMode: normalizeCollisionMode(d.collisionMode),
      // Raw R&D blob — normalized by the RND overhaul wrapper / getRnDState
      rnd: d.rnd || d.teamRnd || d.research || null,
    };
  } catch(e) {
    return {
      coins:0, gems:0, p1upg:{speed:0,accel:0,traction:0,braking:0,handling:0},
      p2upg:{speed:0,accel:0,traction:0,braking:0,handling:0},
      p1dev:createEmptyDevelopmentState(), p2dev:createEmptyDevelopmentState(),
      p1setup:'balanced', p2setup:'balanced',
      p1customSetup:{ speedMult:1.00, turnMult:1.00, tractBonus:0 },
      p2customSetup:{ speedMult:1.00, turnMult:1.00, tractBonus:0 },
      pitStrategy:'balanced', pitStrategyCustom:createDefaultPitStrategyCustom(),
      p1paint:'cyan', p2paint:'orange',
      p1livery: defaultLivery('cyan'), p2livery: defaultLivery('orange'),
      weather:'dry', tyres:'med',
      selectedLaps:3,
      unlockedTracks: migrateUnlockedTracks(null),
      trialPits:false, collisionMode:'collision',
      rnd: null
    };
  }
}
function updateCurrencyDisplays(pd) {
  if (!pd) pd = getPlayerData();
  const coins = pd.coins || 0;
  const gems = pd.gems || 0;
  const mc = document.getElementById('menu-coins-chip');
  if (mc) mc.textContent = `COINS ${coins}`;
  const mg = document.getElementById('menu-gems-chip');
  if (mg) mg.textContent = `GEMS ${gems}`;
  // Legacy single-node fallback if chips were flattened
  const menuWrap = document.getElementById('menu-coins');
  if (menuWrap && !mc && !mg) menuWrap.textContent = `COINS ${coins}  ·  GEMS ${gems}`;
  const gc = document.getElementById('garage-coins-chip');
  if (gc) gc.textContent = `COINS ${coins}`;
  const gg = document.getElementById('garage-gems-chip');
  if (gg) gg.textContent = `GEMS ${gems}`;
  const garageWrap = document.getElementById('garage-coins');
  if (garageWrap && !gc && !gg) garageWrap.textContent = `COINS ${coins}  ·  GEMS ${gems}`;
}
function savePlayerData(d) {
  if(d) {
    d = {
      ...d,
      weather: normalizeWeatherId(d.weather),
      collisionMode: normalizeCollisionMode(d.collisionMode),
      p1dev: normalizeDevelopmentState(d.p1dev, d.p1upg),
      p2dev: normalizeDevelopmentState(d.p2dev, d.p2upg),
      p1customSetup: d.p1customSetup || { speedMult:1.00, turnMult:1.00, tractBonus:0 },
      p2customSetup: d.p2customSetup || { speedMult:1.00, turnMult:1.00, tractBonus:0 },
      p1livery: normalizeLivery(d.p1livery, d.p1paint || 'cyan'),
      p2livery: normalizeLivery(d.p2livery, d.p2paint || 'orange'),
      p1paint: (d.p1livery && d.p1livery.chassis) || d.p1paint || 'cyan',
      p2paint: (d.p2livery && d.p2livery.chassis) || d.p2paint || 'orange',
      pitStrategy: d.pitStrategy || 'balanced',
      pitStrategyCustom: normalizePitStrategyCustom(d.pitStrategyCustom || getLegacyPitStrategySeed(d.pitStrategy || 'balanced'), d.weather || 'dry'),
      updatedAt: Date.now()
    };
  }
  try { localStorage.setItem('kartblitz_player', JSON.stringify(d)); } catch(e){}
  // Cloud save via CrazyGames User Data SDK — syncs progress across devices/sessions
  CG.saveUserData('kartblitz_player', JSON.stringify(d));
}

function _saveRank(data) {
  if (!data || typeof data !== 'object') return { t: 0, coins: 0, gems: 0, unlocks: 0 };
  return {
    t: Number(data.updatedAt) || 0,
    coins: Number(data.coins) || 0,
    gems: Number(data.gems) || 0,
    unlocks: (data.unlockedTracks && data.unlockedTracks.length) || 0
  };
}
function _cloudSavePreferred(cloudData, localData) {
  const c = _saveRank(cloudData);
  const l = _saveRank(localData);
  // Prefer newer timestamp when either side has one; else richer progress
  if (c.t || l.t) {
    if (c.t !== l.t) return c.t > l.t;
  }
  if (c.coins !== l.coins) return c.coins > l.coins;
  if (c.gems !== l.gems) return c.gems > l.gems;
  return c.unlocks > l.unlocks;
}

// Try to load cloud save on start; prefer newer updatedAt, then richer progress
(function initCloudLoad() {
  CG.loadUserData(['kartblitz_player'], function(data) {
    if (!data || !data.kartblitz_player) return;
    try {
      const cloudData = JSON.parse(data.kartblitz_player);
      const localData = getPlayerData();
      if (_cloudSavePreferred(cloudData, localData)) {
        const mergedData = {
          ...localData,
          ...cloudData,
          p1dev: normalizeDevelopmentState(cloudData.p1dev || localData.p1dev, cloudData.p1upg || localData.p1upg),
          p2dev: normalizeDevelopmentState(cloudData.p2dev || localData.p2dev, cloudData.p2upg || localData.p2upg),
          p1customSetup: cloudData.p1customSetup || localData.p1customSetup,
          p2customSetup: cloudData.p2customSetup || localData.p2customSetup,
          pitStrategy: cloudData.pitStrategy || localData.pitStrategy,
          pitStrategyCustom: normalizePitStrategyCustom(cloudData.pitStrategyCustom || localData.pitStrategyCustom || getLegacyPitStrategySeed(cloudData.pitStrategy || localData.pitStrategy), cloudData.weather || localData.weather),
          p1livery: normalizeLivery(cloudData.p1livery || localData.p1livery, cloudData.p1paint || localData.p1paint),
          p2livery: normalizeLivery(cloudData.p2livery || localData.p2livery, cloudData.p2paint || localData.p2paint),
          unlockedTracks: migrateUnlockedTracks(cloudData.unlockedTracks || localData.unlockedTracks),
          rnd: cloudData.rnd || localData.rnd || null,
          updatedAt: cloudData.updatedAt || Date.now()
        };
        localStorage.setItem('kartblitz_player', JSON.stringify(mergedData));
        updateCurrencyDisplays(mergedData);
      }
    } catch(e) {}
  });
})();

// Garage tab state
let garageTab = 'rnd';
let _rewardedAdCooldownUntil = 0;
const REWARDED_AD_COOLDOWN_MS = 90000;

function refreshGarageAdButton() {
  const btn = document.getElementById('garage-ad-btn');
  const hint = document.getElementById('garage-ad-hint');
  if (!btn) return;
  const remain = Math.max(0, _rewardedAdCooldownUntil - Date.now());
  if (remain > 0) {
    const secs = Math.ceil(remain / 1000);
    btn.disabled = true;
    btn.textContent = `VIDEO COOLDOWN ${secs}s`;
    if (hint) hint.textContent = 'Optional reward · earn coins by racing too';
    setTimeout(refreshGarageAdButton, 1000);
  } else {
    btn.disabled = false;
    btn.textContent = 'VIDEO · +50 COINS';
    if (hint) hint.textContent = 'Optional reward · earn coins by racing too';
  }
}

function watchAdForCoins() {
  const btn = document.getElementById('garage-ad-btn');
  if (Date.now() < _rewardedAdCooldownUntil) {
    refreshGarageAdButton();
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'LOADING VIDEO…'; }
  CG.requestRewarded((rewarded) => {
    if (rewarded) {
      const pd = getPlayerData();
      pd.coins += 50;
      savePlayerData(pd);
      _rewardedAdCooldownUntil = Date.now() + REWARDED_AD_COOLDOWN_MS;
      buildGarageScreen();
      refreshGarageAdButton();
      beep(880,0.1,0.5,'square'); beep(1100,0.15,0.5,'square',0.08); beep(1320,0.3,0.6,'sine',0.15);
    } else {
      // Never reward on adError / unfilled — show try-later state
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'NO AD AVAILABLE';
        setTimeout(() => refreshGarageAdButton(), 2200);
      } else {
        refreshGarageAdButton();
      }
      try { beep(200, 0.12, 0.35, 'sawtooth'); } catch(e){}
    }
  });
}

function showGarage() { initAudio(); garageTab='rnd'; buildGarageScreen(); showScreen('garage'); }
function switchGarageTab(tab, btn) {
  // Legacy p1/p2 build tabs collapse into one shared BUILD.
  garageTab = (tab === 'p1' || tab === 'p2') ? 'build' : tab;
  document.querySelectorAll('.gtab').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  buildGarageContent();
}

function buildGarageScreen() {
  const pd = getPlayerData();
  updateCurrencyDisplays(pd);
  buildGarageContent();
  refreshGarageAdButton();
}

function buildGarageContent() {
  const pd = getPlayerData();
  updateCurrencyDisplays(pd);
  const content = document.getElementById('garage-content');
  content.innerHTML = '';

  if(garageTab === 'paint') {
    const stageWrap = document.createElement('div');
    stageWrap.className = 'garage-car-stage';
    stageWrap.innerHTML = '<canvas id="garage-car-canvas"></canvas><div class="menu-car-hint">P1 LIVERY · CHASSIS / WHEEL RIMS · STOCK = ORIGINAL</div>';
    content.appendChild(stageWrap);

    ['p1','p2'].forEach(pl => {
      const label = document.createElement('div');
      label.className = 'setup-section-label';
      label.textContent = pl.toUpperCase() + ' — CHASSIS & WHEEL RIMS';
      content.appendChild(label);

      const grid = document.createElement('div');
      grid.className = 'paint-part-grid';
      const liv = getPlayerLivery(pl);
      PAINT_PARTS.forEach(part => {
        const card = document.createElement('div');
        card.className = 'paint-part-card' + (pl === 'p1' && window._menuPaintPart === part.id ? ' active' : '');
        card.innerHTML = `<div class="paint-part-name">${part.label}</div>`;
        const row = document.createElement('div');
        row.className = 'paint-row';
        PAINT_COLORS.forEach(pc => {
          const sw = document.createElement('div');
          sw.className = 'paint-sw' + (liv[part.id] === pc.id ? ' sel' : '');
          sw.style.background = pc.body;
          sw.title = pc.label;
          sw.onclick = () => {
            setPlayerLiveryPart(pl, part.id, pc.id);
            if(pl === 'p1') window._menuPaintPart = part.id;
            buildGarageContent();
          };
          row.appendChild(sw);
        });
        card.appendChild(row);
        grid.appendChild(card);
      });
      content.appendChild(grid);
    });
    if(typeof window.mountGarageCarStage === 'function') {
      requestAnimationFrame(() => window.mountGarageCarStage());
    }
    return;
  }

  // Shared team build (one tab for both karts).
  const d1 = normalizeDevelopmentState(pd.p1dev, pd.p1upg);
  const d2 = normalizeDevelopmentState(pd.p2dev, pd.p2upg);
  const devState = createEmptyDevelopmentState();
  DEV_PARTS.forEach(part => {
    devState[part.id] = Math.max(d1[part.id] || 0, d2[part.id] || 0);
  });
  const implemented = DEV_PARTS.filter(part => (devState[part.id] || 0) >= 2).length;
  const researched = DEV_PARTS.filter(part => (devState[part.id] || 0) === 1).length;

  const overview = document.createElement('div');
  overview.className = 'upgrade-card';
  overview.style.maxWidth = '780px';
  overview.style.width = '100%';
  overview.style.margin = '0 auto 16px';
  overview.style.textAlign = 'left';
  overview.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;">
      <div>
        <div class="upgrade-name">TEAM BUILD</div>
        <div style="font-size:12px;opacity:.7;line-height:1.5;margin-top:6px;">One development package for the whole garage — applies to every kart in every mode.</div>
      </div>
      <div style="font-family:'Nunito',sans-serif;font-size:11px;letter-spacing:.12em;color:var(--gold);text-align:right;">
        <div>IMPLEMENTED ${implemented}/${DEV_PARTS.length}</div>
        <div style="margin-top:4px;color:${researched ? '#ffd700' : 'rgba(255,255,255,.45)'};">${researched} READY TO FIT</div>
      </div>
    </div>`;
  content.appendChild(overview);

  DEV_DEFS.forEach(dept => {
    const label = document.createElement('div');
    label.className = 'setup-section-label';
    label.textContent = `${dept.name} DEVELOPMENT`;
    content.appendChild(label);

    const note = document.createElement('div');
    note.style.cssText = 'font-size:11px;opacity:.55;text-align:center;margin:-2px 0 10px;letter-spacing:.08em;';
    note.textContent = dept.desc;
    content.appendChild(note);

    const grid = document.createElement('div');
    grid.className = 'upgrade-grid';
    dept.parts.forEach(part => {
      const stage = devState[part.id] || 0;
      const meta = getDevelopmentStageMeta(stage, part);
      const afford = pd.coins >= meta.actionCost;
      const totalSpend = part.researchCost + part.implementCost;
      const div = document.createElement('div');
      div.className = 'upgrade-card';
      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;">
          <div style="font-family:'Nunito',sans-serif;font-size:10px;letter-spacing:.18em;color:rgba(255,255,255,.4);">${part.code}</div>
          <div style="font-family:'Nunito',sans-serif;font-size:10px;letter-spacing:.1em;color:${meta.color};">${meta.status}</div>
        </div>
        <div style="font-size:26px">${dept.icon}</div>
        <div class="upgrade-name">${part.name}</div>
        <div style="font-size:11px;opacity:.62;line-height:1.45;min-height:48px;margin-top:8px;">${part.desc}</div>
        <div style="font-size:10px;color:#4ade80;min-height:28px;margin-top:8px;line-height:1.4;">${formatDevelopmentBonus(part.bonus)}</div>
        <div class="upgrade-bars">
          <div class="upgrade-bar${stage >= 1 ? ' filled' : ''}"></div>
          <div class="upgrade-bar${stage >= 2 ? ' filled' : ''}"></div>
        </div>
        <div style="font-size:10px;opacity:.45;margin-top:5px;">R&amp;D ${part.researchCost} COINS · FIT ${part.implementCost} COINS · TOTAL ${totalSpend} COINS</div>
        ${meta.canAdvance ? `<div style="margin-top:12px;"><button class="btn btn-sm ${afford ? 'btn-gold' : 'btn-pink'}" ${afford ? '' : 'disabled style="opacity:.4"'} onclick="advanceDevelopment('${part.id}')" style="font-size:10px;padding:6px 12px;">${afford ? meta.actionLabel : `NEED ${meta.actionCost} COINS`}</button></div>` : `<div style="margin-top:12px;font-family:'Nunito',sans-serif;font-size:10px;color:#4ade80;letter-spacing:.1em;">PACKAGE LIVE</div>`}
      `;
      grid.appendChild(div);
    });
    content.appendChild(grid);
  });
}

function advanceDevelopment(partId, maybePartId) {
  // Support legacy onclick advanceDevelopment('p1','eng-ecu') and new advanceDevelopment('eng-ecu').
  if(maybePartId) partId = maybePartId;
  const pd = getPlayerData();
  const part = getDevelopmentPart(partId);
  if(!part) return;
  // Keep both save slots mirrored so versus / P2 still receive the same package.
  const d1 = normalizeDevelopmentState(pd.p1dev, pd.p1upg);
  const d2 = normalizeDevelopmentState(pd.p2dev, pd.p2upg);
  const stage = Math.max(d1[partId] || 0, d2[partId] || 0);
  if(stage >= 2) return;
  const cost = stage === 0 ? part.researchCost : part.implementCost;
  if(pd.coins < cost) return;
  pd.coins -= cost;
  const next = stage + 1;
  d1[partId] = next;
  d2[partId] = next;
  pd.p1dev = d1;
  pd.p2dev = d2;
  savePlayerData(pd); buildGarageContent();
  updateCurrencyDisplays(pd);
  beep(880,0.12,0.5,'square'); beep(1100,0.2,0.5,'square',0.08); beep(1320,0.3,0.6,'sine',0.14);
}

let pendingTrackIdx = null;

function buildQualiSetupUI() {
  const qualiSection = document.getElementById('quali-section');
  const toggleRow = document.getElementById('quali-toggle-row');
  const config = document.getElementById('quali-config');
  const timeRow = document.getElementById('quali-time-row');
  const lapRow = document.getElementById('quali-lap-row');
  const modeLabel = document.getElementById('quali-mode-label');
  const note = document.getElementById('quali-note');
  const supportsQuali = currentMode === 'ai' || currentMode === 'versus';

  qualiSection.style.display = supportsQuali ? '' : 'none';
  if(!supportsQuali) return;

  toggleRow.innerHTML = '';
  [false, true].forEach(enabled => {
    const b = document.createElement('button');
    b.className = 'lap-opt' + (raceQualiEnabled === enabled ? ' sel' : '');
    b.textContent = enabled ? 'QUALIFYING ON' : 'NO QUALIFYING';
    b.onclick = () => {
      raceQualiEnabled = enabled;
      buildQualiSetupUI();
    };
    toggleRow.appendChild(b);
  });

  config.style.display = raceQualiEnabled ? '' : 'none';
  if(!raceQualiEnabled) return;

  note.textContent = 'Cars leave the pits every 3s and share the track. Ends when the timer hits zero or every driver finishes their push laps. Fastest lap sets the grid.';

  timeRow.innerHTML = '';
  timeRow.style.display = '';
  [2, 3, 4, 5, 8].forEach(mins => {
    const b = document.createElement('button');
    b.className = 'lap-opt' + (raceQualiSessionMin === mins ? ' sel' : '');
    b.textContent = `${mins} MIN`;
    b.onclick = () => {
      raceQualiSessionMin = mins;
      buildQualiSetupUI();
    };
    timeRow.appendChild(b);
  });

  const modeLbl = document.getElementById('quali-mode-label');
  if(modeLbl) modeLbl.textContent = 'PUSH LAPS PER DRIVER';
  if(modeLabel) modeLabel.textContent = 'PUSH LAPS PER DRIVER';

  lapRow.innerHTML = '';
  [1,2,3,5].forEach(laps => {
    const b = document.createElement('button');
    b.className = 'lap-opt' + (raceQualiLaps === laps ? ' sel' : '');
    b.textContent = `${laps} LAP${laps===1?'':'S'}`;
    b.onclick = () => {
      raceQualiLaps = laps;
      buildQualiSetupUI();
    };
    lapRow.appendChild(b);
  });
}

function showSetupScreen(trackIdx) {
  pendingTrackIdx = trackIdx;
  const pd = getPlayerData();
  const t = TRACKS[trackIdx];
  const isTrial = currentMode === 'trial';
  document.getElementById('setup-track-name').textContent = t.name + (isTrial ? ' — TIME TRIAL' : (' — ' + t.difficulty));
  const setupTitle = document.querySelector('#screen-setup .section-title');
  if(setupTitle) setupTitle.textContent = isTrial ? 'SESSION SETUP' : 'RACE SETUP';
  const startBtn = document.getElementById('setup-start-btn');
  if(startBtn) startBtn.textContent = isTrial ? 'START SESSION' : 'RACE!';

  // Car setup — three primary visual sliders (maps to legacy customSetup fields)
  const grid = document.getElementById('setup-grid');
  grid.innerHTML = '';
  grid.className = 'setup-slider-board';
  const existingCustom = document.getElementById('custom-setup-controls');
  if(existingCustom) existingCustom.remove();

  const seedCust = (pd.p1setup === 'custom')
    ? (pd.p1customSetup || {})
    : (() => {
        const preset = SETUP_DEFS.find(s => s.id === (pd.p1setup || 'balanced')) || SETUP_DEFS[1];
        return { speedMult: preset.speedMult, turnMult: preset.turnMult, tractBonus: preset.tractBonus };
      })();
  const sliders = setupSlidersFromCustom(seedCust);

  grid.innerHTML = `
    <div class="setup-slider-card" data-axis="downforce">
      <div class="setup-slider-head">
        <span class="setup-slider-icon">⬇</span>
        <div>
          <div class="setup-slider-name">DOWNFORCE</div>
          <div class="setup-slider-sub">Cornering load vs top speed</div>
        </div>
        <div class="setup-slider-val" id="setup-df-val">${sliders.downforce}</div>
      </div>
      <div class="setup-slider-extremes"><span>LOW DRAG</span><span>HIGH LOAD</span></div>
      <input class="setup-slider-range df" id="setup-df" type="range" min="0" max="100" step="1" value="${sliders.downforce}">
      <div class="setup-slider-track-glow"></div>
    </div>
    <div class="setup-slider-card" data-axis="grip">
      <div class="setup-slider-head">
        <span class="setup-slider-icon"></span>
        <div>
          <div class="setup-slider-name">GRIP</div>
          <div class="setup-slider-sub">Mechanical traction &amp; kerb confidence</div>
        </div>
        <div class="setup-slider-val" id="setup-grip-val">${sliders.grip}</div>
      </div>
      <div class="setup-slider-extremes"><span>SLIPPY</span><span>PLANTED</span></div>
      <input class="setup-slider-range grip" id="setup-grip" type="range" min="0" max="100" step="1" value="${sliders.grip}">
      <div class="setup-slider-track-glow"></div>
    </div>
    <div class="setup-slider-card" data-axis="brake">
      <div class="setup-slider-head">
        <span class="setup-slider-icon"></span>
        <div>
          <div class="setup-slider-name">BRAKE BIAS</div>
          <div class="setup-slider-sub">Front bite vs rear stability</div>
        </div>
        <div class="setup-slider-val" id="setup-brake-val">${sliders.brakeBias}</div>
      </div>
      <div class="setup-slider-extremes"><span>REAR</span><span>FRONT</span></div>
      <input class="setup-slider-range brake" id="setup-brake" type="range" min="0" max="100" step="1" value="${sliders.brakeBias}">
      <div class="setup-slider-track-glow"></div>
    </div>
    <div class="setup-slider-live" id="setup-live-summary"></div>
  `;

  function persistSetupSliders() {
    const next = customSetupFromSliders({
      downforce: Number(document.getElementById('setup-df').value),
      grip: Number(document.getElementById('setup-grip').value),
      brakeBias: Number(document.getElementById('setup-brake').value)
    });
    const p = getPlayerData();
    p.p1setup = 'custom';
    p.p2setup = 'custom';
    p.p1customSetup = { ...(p.p1customSetup || {}), ...next };
    p.p2customSetup = { ...(p.p2customSetup || {}), ...next };
    savePlayerData(p);
    const live = document.getElementById('setup-live-summary');
    if(live) {
      live.innerHTML = `
        <span>TOP ${(next.speedMult * 100).toFixed(0)}%</span>
        <span>TURN ${(next.turnMult * 100).toFixed(0)}%</span>
        <span>TRACT ${next.tractBonus >= 0 ? '+' : ''}${next.tractBonus}</span>
        <span>BRAKE ${(next.brakeMult * 100).toFixed(0)}%</span>`;
    }
  }

  const wireSlider = (id, valId) => {
    const el = document.getElementById(id);
    const val = document.getElementById(valId);
    const card = el.closest('.setup-slider-card');
    const paint = () => {
      const v = Number(el.value);
      val.textContent = String(v);
      el.style.setProperty('--pct', v + '%');
      if(card) card.style.setProperty('--pct', v + '%');
      persistSetupSliders();
    };
    el.oninput = paint;
    paint();
  };
  wireSlider('setup-df', 'setup-df-val');
  wireSlider('setup-grip', 'setup-grip-val');
  wireSlider('setup-brake', 'setup-brake-val');

  // Lap count
  const lapRow = document.getElementById('lap-row');
  lapRow.innerHTML = '';
  [1,2,3,5,8,10].forEach(n => {
    const b = document.createElement('button');
    b.className = 'lap-opt'+(pd.selectedLaps===n?' sel':'');
    b.textContent = n + (n===1?'LAP':'LAPS');
    b.onclick = () => {
      const p = getPlayerData(); p.selectedLaps = n; savePlayerData(p);
      lapRow.querySelectorAll('.lap-opt').forEach(x=>x.classList.remove('sel'));
      b.classList.add('sel');
    };
    lapRow.appendChild(b);
  });

  // Weather
  const wxRow = document.getElementById('wx-row');
  wxRow.innerHTML = '';
  WEATHER_DEFS.forEach(w => {
    const div = document.createElement('div');
    div.className = 'wx-card'+(pd.weather===w.id?' sel':'');
    div.innerHTML = `<div style="font-size:26px">${w.icon}</div><div class="setup-sname" style="font-size:11px;">${w.label}</div>`;
    div.onclick = () => {
      const p = getPlayerData();
      p.weather = w.id;
      p.tyres = getLegalTyreId(p.tyres || 'med', w.id);
      p.pitStrategyCustom = normalizePitStrategyCustom(p.pitStrategyCustom || getLegacyPitStrategySeed(p.pitStrategy || 'balanced'), w.id);
      savePlayerData(p);
      wxRow.querySelectorAll('.wx-card').forEach(c=>c.classList.remove('sel'));
      div.classList.add('sel');
      showSetupScreen(pendingTrackIdx);
    };
    wxRow.appendChild(div);
  });

  // Pit strategy UI retired — tyre choice happens in the pit menu mid-race.
  const pitStrategySection = document.getElementById('pit-strategy-section');
  if(pitStrategySection) pitStrategySection.style.display = 'none';

  buildQualiSetupUI();

  buildTyreRow();

  // Time Trial: car setup only. Tyres are picked in the garage; weather is always dry.
  const trialHideIds = ['laps-section', 'weather-section', 'tyre-section', 'trial-pit-section'];
  trialHideIds.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = isTrial ? 'none' : '';
  });
  // Always hidden (strategy removed for all modes).
  const pitStratEl = document.getElementById('pit-strategy-section');
  if(pitStratEl) pitStratEl.style.display = 'none';

  const collisionSection = document.getElementById('collision-section');
  const collisionRow = document.getElementById('collision-row');
  const supportsCarCollision = currentMode === 'ai' || currentMode === 'versus';
  collisionSection.style.display = supportsCarCollision ? '' : 'none';
  collisionRow.innerHTML = '';
  if(supportsCarCollision) {
    [
      { id:'collision', label:'COLLISION ON' },
      { id:'nocollision', label:'NO COLLISION' }
    ].forEach(opt => {
      const b = document.createElement('button');
      b.className = 'lap-opt' + (pd.collisionMode === opt.id ? ' sel' : '');
      b.textContent = opt.label;
      b.onclick = () => {
        const p = getPlayerData(); p.collisionMode = opt.id; savePlayerData(p);
        collisionRow.querySelectorAll('.lap-opt').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
      };
      collisionRow.appendChild(b);
    });
  }

  showScreen('setup');
}

function buildTyreRow() {
  const pd = getPlayerData();
  const tyreRow = document.getElementById('tyre-row');
  tyreRow.innerHTML = '';
  const currentTrack = pendingTrackIdx !== null ? TRACKS[pendingTrackIdx] : null;
  TYRE_DEFS.forEach(tr => {
    const isWet = isWetWeather(pd.weather);
    // Block wet-only on dry; warn on dryPenalty in dry or dryOnly in wet
    const blocked = !isTyreSelectableForWeather(tr, pd.weather);
    const wrongWeather = isTyreWrongForWeather(tr, pd.weather);
    const dim = blocked;
    const div = document.createElement('div');
    div.className = 'tyre-card'+(pd.tyres===tr.id?' sel':'');
    div.style.opacity = dim ? '0.3' : (wrongWeather ? '0.65' : '1');
    div.style.cursor = dim ? 'not-allowed' : 'pointer';
    const warnBadge = wrongWeather && !blocked ? `<div style="font-size:9px;color:#f87171;margin-top:2px;"> VERY SLOW</div>` : '';
    const lapLife = currentTrack ? getTyreLapLifespan(currentTrack.id, tr.id) : '?';
    const descText = currentTrack ? `~${lapLife} lap${lapLife===1?'':'s'} on this track` : tr.desc;
    div.innerHTML = `<div style="width:12px;height:12px;border-radius:50%;background:${tr.color};display:inline-block;margin-right:4px;"></div><b style="font-family:Nunito,sans-serif;font-size:11px;">${tr.label}</b><div style="font-size:10px;opacity:.65;margin-top:3px;">${descText}</div>${warnBadge}`;
    if(!dim) div.onclick = () => {
      const p = getPlayerData(); p.tyres = tr.id; savePlayerData(p);
      tyreRow.querySelectorAll('.tyre-card').forEach(c=>c.classList.remove('sel'));
      div.classList.add('sel');
    };
    tyreRow.appendChild(div);
  });
}

function confirmSetupAndStart() {
  if(pendingTrackIdx === null) return;
  selectTrackStart(pendingTrackIdx);
}

function getTeamDevelopmentBonuses(pd) {
  // Multiplayer fairness: every upgrade category uses the best unlocked stage
  // across P1/P2 so both karts receive identical performance gains.
  const b1 = getDevelopmentBonuses(normalizeDevelopmentState(pd.p1dev, pd.p1upg));
  const b2 = getDevelopmentBonuses(normalizeDevelopmentState(pd.p2dev, pd.p2upg));
  return {
    speed: Math.max(b1.speed || 0, b2.speed || 0),
    accel: Math.max(b1.accel || 0, b2.accel || 0),
    traction: Math.max(b1.traction || 0, b2.traction || 0),
    braking: Math.max(b1.braking || 0, b2.braking || 0),
    handling: Math.max(b1.handling || 0, b2.handling || 0),
  };
}

function applyUpgradesToKart(kart, player) {
  const pd = getPlayerData();
  const devBonus = getTeamDevelopmentBonuses(pd);
  const setup = resolvePlayerSetup(pd, player);

  kart.maxSpeed = ((469 + devBonus.speed) * setup.speedMult) * GAME_SPEED_MULT;
  kart.accel    = (304 + devBonus.accel) * GLOBAL_ACCEL_MULT;
  kart.brakeForce = (620 + devBonus.braking) * (setup.brakeMult != null ? setup.brakeMult : 1);
  // Base turn-in with room for speed^1.1 understeer to still bite at pace.
  kart.turnRate = (2.22 + devBonus.handling * 0.85) * setup.turnMult;
  kart.offTrackMaxSpd = Math.max(30, 80 + devBonus.traction + setup.tractBonus) * GAME_SPEED_MULT;
  kart.grip = Math.max(0.55, Math.min(1.15, 0.78 + setup.tractBonus * 0.004 + (devBonus.traction || 0) * 0.0015));
  kart._baseGrip = kart.grip;
  kart._baseAccel = kart.accel;
  kart._baseBrakeForce = kart.brakeForce;
  // Store raw values for pit stop tyre re-application
  kart._upgradeBase = { maxSpeed: kart.maxSpeed, turnRate: kart.turnRate, accel: kart.accel, grip: kart.grip, brakeForce: kart.brakeForce };
}

function applyWeatherToKart(kart, weather, tyreId) {
  weather = normalizeWeatherId(weather);
  const wx = WEATHER_DEFS.find(w=>w.id===weather) || WEATHER_DEFS[0];
  const tyre = TYRE_DEFS.find(t=>t.id===tyreId) || TYRE_DEFS[1];

  // Store base values for tyre wear calculations later
  kart.baseMaxSpeed = kart.maxSpeed;
  kart.baseTurnRate = kart.turnRate;
  kart.tyreWrongWeather = false;

  const isDry = weather === 'dry';
  const isWet = isWetWeather(weather);

  // Massive penalty for completely wrong tyre on wrong surface
  if (isDry && tyre.dryPenalty) {
    // Inters/Wet on dry: extremely slow and very little grip
    kart.maxSpeed  = kart.maxSpeed * 0.38;
    kart.turnRate  = kart.turnRate * 0.45;
    kart.friction  = 0.987 - 0.022;
    kart.grip = Math.min(kart.grip == null ? 0.72 : kart.grip, 0.42);
    kart.tyreWrongWeather = true;
  } else if (isWet && tyre.dryOnly) {
    // Dry tyres in rain: severe aquaplaning, very slow
    kart.maxSpeed  = kart.maxSpeed * 0.42;
    kart.turnRate  = kart.turnRate * 0.40;
    kart.friction  = 0.987 - 0.025;
    kart.grip = Math.min(kart.grip == null ? 0.72 : kart.grip, 0.38);
    kart.tyreWrongWeather = true;
  } else {
    const grip = wx.gripMult + tyre.gripBonus;
    kart.maxSpeed  = Math.max(100, kart.maxSpeed * (1 - wx.speedPen) + tyre.speedBonus);
    kart.turnRate  = kart.turnRate * grip;
    kart.friction  = 0.987 - (1 - grip) * 0.012;
    // Map tyre/weather grip into the understeer model (dry med ≈ 0.72 baseline).
    const baseG = kart.grip == null ? 0.72 : kart.grip;
    kart.grip = Math.max(0.35, Math.min(1.15, baseG * (0.82 + grip * 0.22)));
    kart.tyreWrongWeather = false;
  }
  kart._baseGrip = kart.grip;
  kart.baseMaxSpeed = kart.maxSpeed;
  kart.baseTurnRate = kart.turnRate;
  // Seed tyre temperature near ambient (cold start — warms quickly on opening lap)
  const amb = getTyreAmbientTemp(weather, null);
  const idealLo = tyre.idealMin != null ? tyre.idealMin : 85;
  kart.tyreTemp = Math.min(idealLo - 3, amb + 18);
  kart.tyreTempState = getTyreTempState(kart.tyreTemp, tyre);
  kart.tyreGripPct = getTyreTempGripMult(kart.tyreTemp, tyre) * (1 - (kart.tyreWear || 0) * 0.40);
}

function applyShootoutBoost(kart) {
  // Shootout runs with no tyre wear and max-performance cars.
  kart.noTyreWear = true;
  kart.tyreWear = 0;
  kart.maxSpeed = kart.maxSpeed * 1.18;
  kart.baseMaxSpeed = kart.maxSpeed;
  kart.turnRate = kart.turnRate * 1.08;
  kart.baseTurnRate = kart.turnRate;
  kart.accel = (kart.accel || 304) * 1.18;
  kart._baseAccel = kart.accel;
  kart.brakeForce = Math.max(kart.brakeForce || 620, 700);
  kart._baseBrakeForce = kart.brakeForce;
  // Hold tyres in the optimal window for shootout
  const tDef = TYRE_DEFS.find(t => t.id === kart.tyreId) || TYRE_DEFS[1];
  kart.tyreTemp = ((tDef.idealMin || 85) + (tDef.idealMax || 100)) * 0.5;
  kart.tyreTempState = 'optimal';
  kart.tyreGripPct = 1.0;
}

function awardCoins(result) {
  const pd = getPlayerData();
  const track = TRACKS.find(t=>t.id===result.trackId);
  const mult = (track && track.coinMult) ? track.coinMult : 1.0;
  // AI difficulty coin multiplier — rewards skilled play on harder settings
  const diffMultMap = {ultraeasy:0.75, easy:1.0, medium:1.25, hard:1.5, extreme:2.0};
  const diffMult = (result.aiDiff && diffMultMap[result.aiDiff]) ? diffMultMap[result.aiDiff] : 1.0;
  let earned = 0;
  if(result.mode==='trial') {
    earned += (result.laps||0) * 3;          // 3 per lap
    if(result.total) earned += 10;            // 10 for finishing
    if(track && result.bestLap < track.targetLap) earned += 8; // 8 for beating target
  } else if(result.mode==='shootout') {
    earned += 8; // participation
    if(result.win) earned += 14;
    if(result.bestLap < Infinity) earned += 4;
  } else {
    earned += (result.laps||0) * 2;           // 2 per lap (both players)
    earned += 8;                               // 8 participation
  }
  earned = Math.round(earned * mult * diffMult);
  pd.coins += earned; savePlayerData(pd);
  return earned;
}

// ── LOCKED TRACK HANDLING ───────────────────────────────
function unlockTrack(trackId) {
  const pd = getPlayerData();
  const t = TRACKS.find(tr=>tr.id===trackId);
  if(!t || !t.locked) return;
  if((pd.unlockedTracks||[]).includes(trackId)) return;
  if(pd.coins < t.unlockCost) { beep(200,0.2,0.4,'sawtooth'); return; }
  pd.coins -= t.unlockCost;
  pd.unlockedTracks = [...(pd.unlockedTracks || DEFAULT_UNLOCKED_TRACKS), trackId];
  savePlayerData(pd);
  beep(660,0.1,0.5,'square'); beep(880,0.15,0.5,'square',0.08); beep(1100,0.25,0.6,'sine',0.15);
  buildTrackGrid(); // refresh
}

// ── INIT ────────────────────────────────────────────────
(function syncPortalTrackCount() {
  const el = document.getElementById('portal-track-count');
  if(el) el.textContent = TRACKS.length + 'TRACKS';
})();
console.log('Tracks:', TRACKS.map(t => t.id + ':' + t.name + (t.aiFriendly ? ' [AI]' : '')).join(' | '));
