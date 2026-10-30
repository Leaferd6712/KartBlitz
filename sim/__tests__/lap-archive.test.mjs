import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PlayerLapRecorder } from '../lap-recorder.mjs';
import { unpackLeaderboardGhost } from '../pb-ghost.mjs';
import { exportRecordings } from '../../scripts/export-lap-recordings.mjs';

const bundle = await build({ entryPoints: ['party/lap-archive.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const Archive = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const sqlite = new DatabaseSync(':memory:');
const db = {
  async batch(statements) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
  prepare(sql) {
    let args = [];
    return { bind(...a) { args = a; return this; }, async run() { return sqlite.prepare(sql).run(...args); },
      async first() { return sqlite.prepare(sql).get(...args) || null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; } };
  },
};
const k = { id: 0, x: 0, y: 0, angle: 0, speed: 100, lapStart: 0, lapTimes: [], ersCharge: 1, grip: 1, _lapKind: 'outlap' };
const recorder = new PlayerLapRecorder();
recorder.observe({ kart: k, time: 0, input: { throttle: .6, steer: .25 } });
k.x = 100; recorder.observe({ kart: k, time: 1000, input: { throttle: .4, steer: -.2 }, opponents: [{ id: 1, x: 50, y: 0, angle: 0, speed: 90 }] });
k.x = 200; k.lapTimes.push(2); // Completion hook runs before the lap timer is reset.
const first = recorder.observe({ kart: k, time: 2000, input: { throttle: .4 } });
assert.equal(first.lapKind, 'outlap');
assert.equal(first.frames.at(-1)[0], 2000);
assert.equal(first.frames[0][11], .6, 'Keep analogue pedals, not only digital flags');
assert.ok(first.controlEvents.length > 1);
assert.ok(first.stateCheckpoints.length > 1);
assert.equal(first.traffic[0][1][0][0], 1);
assert.equal(recorder.observe({ kart: k, time: 2001 }), null, 'Do not start a duplicate lap before the timer resets');
k.lapStart = 2000; recorder.observe({ kart: k, time: 2001 });
k.x = 300; recorder.observe({ kart: k, time: 4000 });
k.x = 400; k.lapTimes.push(3); k.lapStart = 5000;
const second = recorder.observe({ kart: k, time: 5000 });
assert.equal(second.lapIndex, 2); assert.equal(second.lapKind, 'flying');
assert.equal(second.lapTime, 3, 'Slower laps are recorded too');

const token = 'abcdefghijklmnopqrstuvwx';
function payload(lap, mode = 'trial', slot = 0) {
  const { lapTime, frames, sampleRateHz, ...recording } = lap;
  return { id: crypto.randomUUID(), sessionId: 'archive-session-12345678', playerSlot: slot,
    lapIndex: lap.lapIndex, deviceToken: token, username: 'FORGED_NAME', mode, trackId: 0, lapKind: lap.lapKind,
    ghost: { v: 1, trackId: 0, lapTime, frames, sampleRateHz, recording } };
}
const a = payload(first);
assert.equal((await Archive.saveArchivedLap(db, a)).ok, true);
sqlite.prepare('INSERT INTO devices (device_token, username, created_at, last_seen_at) VALUES (?, ?, 1, 1)').run(token, 'RACER');
const b = payload(second);
b.ghost.recording.note = 'X'.repeat(200000);
assert.equal((await Archive.saveArchivedLap(db, b)).ok, true);
assert.equal((await Archive.saveArchivedLap(db, b)).duplicate, true, 'Retries cannot duplicate a lap');
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM lap_archive').get().n, 2);
assert.ok(sqlite.prepare('SELECT count(*) AS n FROM lap_archive_chunks WHERE recording_id = ?').get(b.id).n > 1);
const saved = JSON.parse(await Archive.readArchivedLap(db, b.id));
assert.equal(saved.username, 'RACER'); assert.equal(saved.source, 'client-recorded');
assert.equal(saved.ghost.recording.note.length, 200000);
assert.ok(!JSON.stringify(saved).includes(token), 'Owner exports do not leak device tokens');
assert.ok(unpackLeaderboardGhost(saved.ghost), 'Archived recordings open in the replay reader');
for (const [i, mode] of ['ai','shootout','versus','online'].entries()) {
  const p = payload(first, mode, mode === 'versus' ? 1 : 0); p.sessionId += i;
  assert.equal((await Archive.saveArchivedLap(db, p, mode === 'online')).ok, true, `${mode} player lap is archived`);
}
const broken = payload(first); broken.sessionId += 'broken'; broken.ghost.frames = [[0,0,0,0,1,1,0,0,0,1],[3000,0,0,0,1,1,0,0,0,1]];
assert.equal((await Archive.saveArchivedLap(db, broken)).ok, false);
const listing = await Archive.listArchivedLaps(db, new URL('https://local/api/admin/lap-recordings?trackId=0&username=RACER'));
assert.equal(listing.recordings.length, 4, 'All matching laps survive regardless of pace');

// Run two real shared-simulator online players through two laps each.
const simBundle = await build({ entryPoints: ['sim/index.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const Sim = await import('data:text/javascript;base64,' + Buffer.from(simBundle.outputFiles[0].text).toString('base64'));
const radius = 500, count = 200;
const circle = { id: 0, trackWidth: 200, totalLen: Math.PI * 2 * radius, startPos: { x: radius, y: -10 }, startAngle: Math.PI / 2,
  spline: Array.from({ length: count }, (_, i) => ({ x: Math.cos(i / count * Math.PI * 2) * radius, y: Math.sin(i / count * Math.PI * 2) * radius })),
  cum: Array.from({ length: count }, (_, i) => i * Math.PI * 2 * radius / count), drsZones: [],
  cpLines: [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map(a => ({ x1: Math.cos(a) * 400, y1: Math.sin(a) * 400, x2: Math.cos(a) * 600, y2: Math.sin(a) * 600 })) };
const onlineSim = new Sim.OnlineRaceSim({ track: circle, players: [{ id: 'p1', name: 'ONE', color: '#fff' }, { id: 'p2', name: 'TWO', color: '#fff' }],
  order: ['p1','p2'], laps: 2, weather: 'dry', tyres: 'med', collisionMode: 'nocollision' });
onlineSim.phase = 'racing'; onlineSim.karts.forEach(k => { k.x = radius; k.y = -10; k.angle = Math.PI / 2; k.lapStart = 0; });
const realRecorders = onlineSim.karts.map(() => new PlayerLapRecorder()), captured = [];
for (let tick = 0; tick < 14000 && !onlineSim.karts.every(k => k.finished); tick++) {
  onlineSim.karts.forEach((k, i) => {
    const a = Math.atan2(k.y, k.x) + .12, target = Math.atan2(Math.sin(a) * radius - k.y, Math.cos(a) * radius - k.x);
    const error = Math.atan2(Math.sin(target - k.angle), Math.cos(target - k.angle));
    const input = { up: k.speed < 60 + i * 5, down: false, left: error < -.012, right: error > .012, ers: false, drs: false,
      steer: error < -.012 ? -1 : error > .012 ? 1 : 0, throttle: k.speed < 60 + i * 5 ? 1 : 0, brake: 0 };
    onlineSim.setInput(k.onlineConnId, input);
    const lap = realRecorders[i].observe({ kart: k, input, time: onlineSim.simTimeMs });
    if (lap) captured.push({ slot: i, lap });
  });
  onlineSim.step(Sim.FIXED_DT);
  onlineSim.karts.forEach((k, i) => { const lap = realRecorders[i].observe({ kart: k, input: onlineSim.inputs.get(k.onlineConnId), time: onlineSim.simTimeMs }); if (lap) captured.push({ slot: i, lap }); });
}
assert.equal(captured.length, 4, 'Online archiving captures each completed lap for both players');
assert.equal(captured.filter(item => item.slot === 1).length, 2);
assert.ok(captured.every(item => Math.abs(item.lap.frames.at(-1)[0] - item.lap.lapTime * 1000) < 1));

// Durable online retry outbox preserves its job when D1 is unavailable.
const storage = new Map();
const outbox = { async put(k, v) { storage.set(k, v); }, async get(k) { return storage.get(k); },
  async delete(k) { return storage.delete(k); }, async list({ prefix, limit }) { return new Map([...storage].filter(([k]) => k.startsWith(prefix)).slice(0, limit)); } };
const online = payload(first, 'online'); online.sessionId += 'server';
await Archive.stageOnlineLap(outbox, online);
await assert.rejects(() => Archive.flushOnlineLaps(outbox, { ...db, batch: async () => { throw new Error('offline'); } }));
assert.ok([...storage.keys()].some(key => key.startsWith('lap-job:')));
assert.equal(await Archive.flushOnlineLaps(outbox, db), false);
assert.equal(storage.size, 0);
assert.equal(JSON.parse(await Archive.readArchivedLap(db, online.id)).source, 'server-online');

const output = path.resolve('test-results', 'archive-export-' + crypto.randomUUID());
const request = async route => {
  const url = new URL(route, 'https://local');
  return url.pathname.endsWith('/lap-recordings') ? Archive.listArchivedLaps(db, url) : JSON.parse(await Archive.readArchivedLap(db, url.pathname.split('/').at(-1)));
};
assert.ok(await exportRecordings({ output, request }) >= 6);
assert.equal(await exportRecordings({ output, request }), 0, 'Folder export resumes without duplicate downloads');
const files = await readdir(output, { recursive: true });
assert.ok(files.some(file => file.endsWith('.replay.json') && file.includes('track-0') && file.includes('player-1')));
for (const file of files.filter(file => file.endsWith('.replay.json'))) assert.equal(JSON.parse(await readFile(path.join(output, file), 'utf8')).format, 'kartblitz-lap-replay-v1');
sqlite.close();
console.log('lap-archive: capture, every-mode retention, outbox retry, replay reconstruction data and folder export passed');
