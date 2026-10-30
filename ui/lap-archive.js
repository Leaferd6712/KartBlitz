import { PlayerLapRecorder } from '../sim/lap-recorder.mjs';

const sessions = new WeakMap(), memoryPending = new Map();
let flushing = false, retryTimer = 0, flushAgain = false;
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('kartblitz-lap-archive', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('pending', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
database.catch(() => {});
async function transaction(mode, operation) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', mode), request = operation(tx.objectStore('pending'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
function schedule() { if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = 0; flush(); }, 15000); }
async function flush() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    let stored = [];
    try { stored = await transaction('readonly', store => store.getAll()); } catch {}
    const pending = new Map(stored.map(item => [item.id, item]));
    for (const [id, item] of memoryPending) pending.set(id, item);
    for (const item of pending.values()) {
      const result = await window.leaderboardFetchJson('/api/lap-recordings', { method: 'POST', body: JSON.stringify(item) });
      if (!result?.archived) throw new Error('Lap archive did not confirm the save');
      try { await transaction('readwrite', store => store.delete(item.id)); } catch {}
      memoryPending.delete(item.id);
    }
  } catch (error) { console.warn('Lap recording queued for retry:', error.message); schedule(); }
  finally {
    flushing = false;
    if (flushAgain) { flushAgain = false; queueMicrotask(flush); }
  }
}
async function enqueue(item) {
  memoryPending.set(item.id, item);
  try { await transaction('readwrite', store => store.put(item)); }
  catch { window.showLbToast?.('LAP RECORDING: LOCAL STORAGE UNAVAILABLE — KEEP THIS PAGE OPEN UNTIL UPLOADED', true); }
  if (flushing) flushAgain = true; else flush();
}

function capture(race) {
  if (!race?.track || race.mode === 'online') return; // Online laps are archived by the server.
  const stage = ['qualifying','quali-turn'].includes(race.phase) ? 'qualifying' : 'race';
  if (!['qualifying','quali-turn','racing','launch','finished'].includes(race.phase)) return;
  if (race._trialStartTyrePick || race._isHumanPitMenuOpen?.()) return;
  let session = sessions.get(race);
  if (!session) {
    const tr = race.track;
    session = { id: crypto.randomUUID(), recorders: new Map(), track: {
      id: tr.id, name: tr.name, spline: tr.spline, cum: tr.cum, totalLen: tr.totalLen,
      trackWidth: tr.trackWidth, startPos: tr.startPos, startAngle: tr.startAngle,
      cpLines: tr.cpLines, drsZones: tr.drsZones,
    } };
    sessions.set(race, session);
  }
  const now = performance.now();
  for (let slot = 0; slot < race.karts.length; slot++) {
    const kart = race.karts[slot];
    if (kart.isAI || kart._shootoutStowed || kart._qualiWaiting) continue;
    let recorder = session.recorders.get(slot);
    if (!recorder) { recorder = new PlayerLapRecorder(); session.recorders.set(slot, recorder); }
    const completed = recorder.observe({ kart, input: kart.getInput?.() || {}, time: now, stage,
      opponents: race.karts.filter(k => k !== kart && !k._shootoutStowed && !k._qualiWaiting) });
    if (!completed) continue;
    const { lapIndex, lapKind, lapTime, frames, sampleRateHz, ...recording } = completed;
    enqueue({ id: crypto.randomUUID(), sessionId: session.id, playerSlot: slot, lapIndex,
      deviceToken: window.getDeviceToken(), mode: race.mode, trackId: race.track.id, lapKind,
      ghost: { v: 1, recordingVersion: 3, trackId: race.track.id, lapTime,
        sampleRateHz, frames, maxSpeed: kart.baseMaxSpeed || kart.maxSpeed,
        rulesVersion: window.OnlineSim?.LEADERBOARD_RULES_VERSION,
        trackBakeVersion: window.OnlineSim?.TRACK_BAKE_VERSION, trackSnapshot: session.track,
        recording: { ...recording, source: 'actual-game', weather: race.weather, tyres: kart.tyreId,
          controlsAreSampled: true, timing: 'game-lap-clock' } } });
  }
}
window.addEventListener('online', flush);
window.KartBlitzLapArchive = { capture, flush };
flush();
