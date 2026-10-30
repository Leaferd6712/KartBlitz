import { ensureLeaderboardSchema, getDeviceByToken } from './leaderboard';
import { loadTrackBake } from '../sim/tracks';

const MODES = new Set(['trial', 'ai', 'shootout', 'versus', 'online']);
export const MAX_LAP_ARCHIVE_BYTES = 4_000_000;
const CHUNK_SIZE = 120_000;

export async function ensureLapArchiveSchema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS lap_archive (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, lap_index INTEGER NOT NULL,
      player_slot INTEGER NOT NULL, username TEXT NOT NULL, mode TEXT NOT NULL,
      track_id INTEGER NOT NULL, lap_time REAL NOT NULL, lap_kind TEXT NOT NULL,
      source TEXT NOT NULL, created_at INTEGER NOT NULL, byte_length INTEGER NOT NULL,
      UNIQUE(session_id, player_slot, lap_index))`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_lap_archive_track_player ON lap_archive(track_id, username, created_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS lap_archive_chunks (
      recording_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(recording_id, chunk_index))`),
  ]);
}

/** Internal online-server callers set trustedSource; browsers cannot claim verification. */
export async function saveArchivedLap(db: D1Database, raw: Record<string, any>, trustedSource = false) {
  const id = String(raw.id || ''), sessionId = String(raw.sessionId || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || !/^[A-Za-z0-9_-]{16,64}$/.test(sessionId)) return { ok: false as const, error: 'invalid_recording_id', status: 400 };
  const lapIndex = Number(raw.lapIndex), playerSlot = Number(raw.playerSlot), trackId = Number(raw.trackId);
  const mode = String(raw.mode), ghost = raw.ghost;
  if (!MODES.has(mode) || !Number.isInteger(lapIndex) || lapIndex < 1 || !Number.isInteger(playerSlot) || playerSlot < 0 || playerSlot > 5
    || !Number.isInteger(trackId) || !loadTrackBake(trackId)) return { ok: false as const, error: 'invalid_lap_metadata', status: 400 };
  const lapTime = Number(ghost?.lapTime), frames = ghost?.frames;
  if (!(lapTime > 0) || lapTime > 3600 || !Array.isArray(frames) || frames.length < 2 || frames.length > 12002)
    return { ok: false as const, error: 'invalid_lap_recording', status: 400 };
  let previous = -1;
  for (const frame of frames) {
    if (!Array.isArray(frame) || frame.length < 10 || frame.length > 13 || frame.some(v => typeof v !== 'number' || !Number.isFinite(v))
      || frame[0] < previous || frame[0] < 0 || frame[0] > lapTime * 1000 + 2) return { ok: false as const, error: 'invalid_recording_frames', status: 400 };
    previous = frame[0];
  }
  if (frames[0][0] !== 0 || Math.abs(frames.at(-1)[0] - lapTime * 1000) > 2)
    return { ok: false as const, error: 'incomplete_recording', status: 400 };
  await ensureLeaderboardSchema(db);
  await ensureLapArchiveSchema(db);
  let username = String(raw.username || 'GUEST').slice(0, 64);
  if (!trustedSource) {
    const token = String(raw.deviceToken || '');
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) return { ok: false as const, error: 'invalid_device_token', status: 400 };
    const device = await getDeviceByToken(db, token);
    username = device?.username || `GUEST-${token.slice(-8)}`;
  }
  const source = trustedSource ? 'server-online' : 'client-recorded';
  const payload = { format: 'kartblitz-lap-replay-v1', id, runId: id, sessionId, lapIndex, playerSlot,
    username, trackId, mode, bestLap: lapTime, rank: null, source,
    lapKind: ['outlap','standing','flying'].includes(raw.lapKind) ? raw.lapKind : 'flying',
    ghost: { ...ghost, v: 1, trackId, lapTime, recordingVersion: 3 } };
  const encoded = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > MAX_LAP_ARCHIVE_BYTES) return { ok: false as const, error: 'recording_too_large', status: 413 };
  const existing = await db.prepare('SELECT id FROM lap_archive WHERE session_id = ? AND player_slot = ? AND lap_index = ?').bind(sessionId, playerSlot, lapIndex).first<{id:string}>();
  if (existing) return { ok: true as const, id: existing.id, archived: true, duplicate: true };
  const statements = [db.prepare(`INSERT INTO lap_archive
    (id, session_id, lap_index, player_slot, username, mode, track_id, lap_time, lap_kind, source, created_at, byte_length)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, sessionId, lapIndex, playerSlot, username, mode, trackId, lapTime, payload.lapKind, source, Date.now(), bytes)];
  for (let i = 0; i < encoded.length; i += CHUNK_SIZE) {
    statements.push(db.prepare('INSERT INTO lap_archive_chunks (recording_id, chunk_index, payload) VALUES (?, ?, ?)')
      .bind(id, i / CHUNK_SIZE, encoded.slice(i, i + CHUNK_SIZE)));
  }
  // Atomic metadata + chunks: a partial recording must never appear in the archive.
  await db.batch(statements);
  return { ok: true as const, id, archived: true };
}

export async function listArchivedLaps(db: D1Database, url: URL) {
  await ensureLapArchiveSchema(db);
  const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
  const trackId = url.searchParams.get('trackId'), username = url.searchParams.get('username');
  const limit = 50;
  const where = ['rowid > ?'], args: (number|string)[] = [after];
  if (trackId !== null) { where.push('track_id = ?'); args.push(Number(trackId)); }
  if (username) { where.push('username = ?'); args.push(username); }
  const rows = await db.prepare(`SELECT rowid AS cursor, id, session_id AS sessionId, lap_index AS lapIndex,
    player_slot AS playerSlot, username, mode, track_id AS trackId, lap_time AS lapTime,
    lap_kind AS lapKind, source, created_at AS createdAt, byte_length AS byteLength
    FROM lap_archive WHERE ${where.join(' AND ')} ORDER BY rowid LIMIT ?`).bind(...args, limit + 1).all<any>();
  const entries = rows.results || [], page = entries.slice(0, limit);
  return { ok: true, recordings: page, nextCursor: page.at(-1)?.cursor || after, hasMore: entries.length > limit };
}

export async function readArchivedLap(db: D1Database, id: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  await ensureLapArchiveSchema(db);
  const chunks = await db.prepare('SELECT payload FROM lap_archive_chunks WHERE recording_id = ? ORDER BY chunk_index').bind(id).all<{payload:string}>();
  if (!chunks.results?.length) return null;
  return chunks.results.map(row => row.payload).join('');
}

/** Durable online outbox: chunk values stay below the DO per-value limit. */
export async function stageOnlineLap(storage: DurableObjectStorage, payload: Record<string, any>) {
  const encoded = JSON.stringify(payload), count = Math.ceil(encoded.length / 16000);
  for (let i = 0; i < count; i++) await storage.put(`lap-part:${payload.id}:${i}`, encoded.slice(i * 16000, (i + 1) * 16000));
  await storage.put(`lap-job:${payload.id}`, count);
}

export async function flushOnlineLaps(storage: DurableObjectStorage, db: D1Database) {
  const jobs = await storage.list<number>({ prefix: 'lap-job:', limit: 3 });
  for (const [key, count] of jobs) {
    const id = key.slice('lap-job:'.length), parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await storage.get<string>(`lap-part:${id}:${i}`);
      if (part === undefined) throw new Error('incomplete_online_archive_outbox');
      parts.push(part);
    }
    const result = await saveArchivedLap(db, JSON.parse(parts.join('')), true);
    if (!result.ok) throw new Error(result.error);
    // Delete the job after confirmation. Retrying an interrupted cleanup is idempotent.
    await storage.delete(key);
    for (let i = 0; i < count; i++) await storage.delete(`lap-part:${id}:${i}`);
  }
  return (await storage.list({ prefix: 'lap-job:', limit: 1 })).size > 0;
}
