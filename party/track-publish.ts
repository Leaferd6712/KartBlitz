import type { Env } from './env';
import { checkAdminPassword } from './leaderboard-admin';
import { replaceTrackSource } from '../sim/track-source.mjs';

const REPOSITORY = 'Leaferd6712/KartBlitz';
const BRANCH = 'main';
const MAX_BODY_BYTES = 128 * 1024;
const fields = new Set(['id', 'name', 'difficulty', 'diffClass', 'diffLetter', 'targetLap', 'laps', 'trackWidth',
  'lapDistance', 'coinMult', 'grassColor', 'grassColor2', 'trackColor', 'borderColor', 'lineColor', 'accentColor',
  'bgColor', 'waypoints', 'racingLine', 'startPos', 'startAngle', 'pitPos', 'pitLane', 'cpFracs', 'drsFracs',
  'surface', 'sfGateHalfWidth', 'aiFriendly', 'locked', 'unlockCost', 'treeColor', 'treeColor2', 'standRoof',
  'standConcrete', 'seatPalette', 'crowdColors', 'aiBrakeLookaheadScale']);

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function point(value: any): boolean {
  return !!value && finite(value.x, -100000, 100000) && finite(value.y, -100000, 100000)
    && (value.brake === undefined || Number.isInteger(value.brake) && finite(value.brake, 0, 5));
}
function points(value: unknown, min: number): boolean {
  return Array.isArray(value) && value.length >= min && value.length <= 512 && value.every(point);
}
function safeData(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') return value.length <= 256 && !/[<>]/.test(value);
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length <= 512 && value.every(item => safeData(item, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && safeData(item, depth + 1));
}
export function validatePublishedTrack(value: any): Record<string, unknown> & { id: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !safeData(value)
    || Object.keys(value).some(key => !fields.has(key))
    || !Number.isInteger(value.id) || !finite(value.id, 0, 64)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80
    || !['EASY', 'MEDIUM', 'HARD', 'EXTREME'].includes(value.difficulty)
    || !points(value.waypoints, 4) || value.racingLine !== undefined && !points(value.racingLine, 3)
    || !finite(value.trackWidth, 40, 400) || !Number.isInteger(value.laps) || !finite(value.laps, 1, 100)
    || !finite(value.targetLap, 1, 3600) || !finite(value.coinMult, 0, 100)
    || !point(value.startPos) || !finite(value.startAngle, -360, 360)
    || !point(value.pitPos) || !value.pitLane || !points(value.pitLane.path, 2)
    || !finite(value.pitLane.width, 10, 400)
    || !point(value.pitLane.entryPt) || !point(value.pitLane.garagePos) || !point(value.pitLane.exitPos)
    || !finite(value.pitLane.garageAngle, -360, 360) || !finite(value.pitLane.exitAngle, -360, 360)
    || !Array.isArray(value.cpFracs) || value.cpFracs.length < 3 || value.cpFracs.length > 64
    || !value.cpFracs.every((n: unknown) => finite(n, 0, 1))
    || !Array.isArray(value.drsFracs) || value.drsFracs.length > 32
    || !value.drsFracs.every((pair: unknown) => Array.isArray(pair) && pair.length === 2 && pair.every(n => finite(n, 0, 1)))
    || !value.surface || !finite(value.surface.offTrackMult, 0.1, 5)) {
    throw new Error('Invalid track. Check the layout, pit lane, checkpoints, width and lap settings.');
  }
  const difficultyStyles: Record<string, string[]> = {
    EASY: ['diff-easy', 'e'], MEDIUM: ['diff-med', 'm'], HARD: ['diff-hard', 'h'], EXTREME: ['diff-hard', 'h']
  };
  const [diffClass, diffLetter] = difficultyStyles[value.difficulty];
  // Reconstruct route geometry so unvalidated rawPath/authored fields cannot override it.
  const cleanPoint = (p: any) => ({ x: p.x, y: p.y, ...(p.brake === undefined ? {} : { brake: p.brake }) });
  return { ...value, diffClass, diffLetter, waypoints: value.waypoints.map(cleanPoint),
    ...(value.racingLine ? { racingLine: value.racingLine.map(cleanPoint) } : {}),
    startPos: cleanPoint(value.startPos), pitPos: cleanPoint(value.pitPos),
    surface: { offTrackMult: value.surface.offTrackMult, label: value.surface.label || 'GRASS' },
    pitLane: { path: value.pitLane.path.map(cleanPoint), width: value.pitLane.width,
      entryPt: cleanPoint(value.pitLane.entryPt), garagePos: cleanPoint(value.pitLane.garagePos),
      garageAngle: value.pitLane.garageAngle, exitPos: cleanPoint(value.pitLane.exitPos), exitAngle: value.pitLane.exitAngle } };
}
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function decode(text: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s/g, '')), c => c.charCodeAt(0)));
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function handleTrackPublish(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  if (!checkAdminPassword(env.LEADERBOARD_ADMIN_PASSWORD, request.headers.get('X-Admin-Password'))) {
    return json({ error: 'Admin password expired. Unlock the editor again.' }, 401);
  }
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
  if (!env.TRACK_PUBLISH_GITHUB_TOKEN) {
    return json({ error: 'Publishing is not configured. Add the TRACK_PUBLISH_GITHUB_TOKEN Worker secret with Contents read/write access to Leaferd6712/KartBlitz.' }, 503);
  }
  if (request.method === 'GET') return json({ configured: true });
  let body: any, track: ReturnType<typeof validatePublishedTrack>;
  try {
    if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return json({ error: 'Track is too large to publish.' }, 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: 'Track is too large to publish.' }, 413);
    body = JSON.parse(text);
    if (body.confirmed !== true || !/^[a-f0-9]{40}$/.test(body.sourceSha || '')) {
      return json({ error: 'Confirm the warning from the latest published game before saving.' }, 400);
    }
    track = validatePublishedTrack(body.track);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Invalid track.' }, 400);
  }
  const endpoint = `https://api.github.com/repos/${REPOSITORY}/contents/index.html`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.TRACK_PUBLISH_GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'KartBlitz-track-editor' };
  try {
    const current = await fetcher(`${endpoint}?ref=${BRANCH}`, { headers });
    if (!current.ok) return json({ error: 'Cannot read the game source. Check the publishing token and repository access.' }, 502);
    const file = await current.json() as { sha: string; encoding: string; content: string };
    if (file.sha !== body.sourceSha) return json({ error: 'The published source has changed. Wait for deployment, reload the game and reopen this track before saving. Your draft is still in this browser.' }, 409);
    if (file.encoding !== 'base64' || !file.content) return json({ error: 'Game source could not be read safely.' }, 502);
    const updated = replaceTrackSource(decode(file.content), track);
    const saved = await fetcher(endpoint, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Update track ${track.id}: ${String(track.name).replace(/[\r\n]/g, ' ')}`,
        branch: BRANCH, sha: file.sha, content: encode(updated) }) });
    if (saved.status === 409 || saved.status === 422) return json({ error: 'Another change was saved first, or the branch rejected this save. Reload after deployment and try again. Your draft is still saved locally.' }, 409);
    if (!saved.ok) return json({ error: 'GitHub rejected the save. Check the publishing token and branch permissions. Nothing was published.' }, 502);
    const result = await saved.json() as { commit: { sha: string; html_url: string } };
    return json({ ok: true, status: 'deployment_queued', commit: result.commit.sha,
      backupUrl: result.commit.html_url, deploymentsUrl: `https://github.com/${REPOSITORY}/actions` }, 202);
  } catch {
    return json({ error: 'The save could not be confirmed. Check version history before retrying; your local draft is preserved.' }, 502);
  }
}
