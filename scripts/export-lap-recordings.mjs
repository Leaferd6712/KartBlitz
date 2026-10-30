import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const safe = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown';
export async function exportRecordings({ output, request, trackId, username, reset = false, source = '' }) {
  const root = path.resolve(output);
  await mkdir(root, { recursive: true });
  const statePath = path.join(root, '.export-state.json');
  let state = {};
  try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch {}
  const key = JSON.stringify({ source, trackId, username });
  let cursor = reset ? 0 : Number(state[key] || 0), downloaded = 0;
  while (true) {
    const query = new URLSearchParams({ after: String(cursor) });
    if (trackId !== undefined) query.set('trackId', String(trackId));
    if (username) query.set('username', username);
    const page = await request('/api/admin/lap-recordings?' + query);
    if (!page.ok || !Array.isArray(page.recordings)) throw new Error('Invalid archive listing');
    for (const item of page.recordings) {
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(item.id) || !/^[A-Za-z0-9_-]{16,64}$/.test(item.sessionId)) throw new Error('Invalid recording identifier');
      const folder = path.join(root, `track-${safe(item.trackId)}`, `driver-${safe(item.username)}`, `player-${safe(item.playerSlot)}`, safe(item.sessionId));
      const file = path.join(folder, `lap-${safe(item.lapIndex)}-${item.id}.replay.json`);
      try { await access(file); continue; } catch {}
      const payload = await request('/api/admin/lap-recordings/' + item.id);
      if (payload.runId !== item.id || payload.format !== 'kartblitz-lap-replay-v1') throw new Error('Invalid replay download');
      await mkdir(folder, { recursive: true });
      await writeFile(file + '.tmp', JSON.stringify(payload));
      await rename(file + '.tmp', file);
      downloaded++;
    }
    const next = Number(page.nextCursor);
    if (!Number.isFinite(next) || next < cursor || (page.hasMore && next === cursor)) throw new Error('Invalid archive cursor');
    cursor = next;
    state[key] = cursor;
    await writeFile(statePath + '.tmp', JSON.stringify(state, null, 2));
    await rename(statePath + '.tmp', statePath);
    if (!page.hasMore) break;
  }
  return downloaded;
}

async function passwordPrompt() {
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write('Leaderboard admin password: '); muted = true;
  try { return await rl.question(''); }
  finally { muted = false; process.stdout.write('\n'); rl.close(); }
}
async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'https://kartblitz-online.kartblitz.workers.dev' },
    out: { type: 'string', default: 'recordings' }, track: { type: 'string' }, player: { type: 'string' },
    watch: { type: 'boolean', default: false }, all: { type: 'boolean', default: false },
  } });
  const url = new URL(values.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS, or a local development server');
  const password = process.env.KARTBLITZ_ADMIN_PASSWORD || await passwordPrompt();
  const request = async route => {
    const response = await fetch(new URL(route, url), { headers: { 'X-Admin-Password': password }, signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new Error(`Archive request failed (${response.status})`);
    return response.json();
  };
  let reset = values.all;
  do {
    try {
      const count = await exportRecordings({ output: values.out, request, trackId: values.track, username: values.player, reset, source: url.origin });
      console.log(`Saved ${count} new lap recording(s) to ${path.resolve(values.out)}`);
      reset = false;
    } catch (error) { if (!values.watch) throw error; console.error(error.message); }
    if (values.watch) await new Promise(resolve => setTimeout(resolve, 60000));
  } while (values.watch);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
