const USERNAME_RE = /^[A-Z0-9]{3,12}$/;
const ALLOWED_MODES = new Set(["trial", "versus"]);
const TOP_N = 50;

export type DeviceRecord = {
  deviceToken: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
};

type ScoreRow = {
  username_snapshot: string;
  mode: string;
  track_id: number;
  track_name: string | null;
  best_lap: number;
  total: number | null;
  winner: string | null;
  created_at: number;
};

export async function ensureLeaderboardSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS devices (
        device_token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at REAL NOT NULL,
        last_seen_at REAL NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_token TEXT NOT NULL,
        username_snapshot TEXT NOT NULL,
        mode TEXT NOT NULL,
        track_id INTEGER NOT NULL,
        track_name TEXT,
        best_lap REAL NOT NULL,
        total REAL,
        winner TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      )`
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_device_board ON scores(device_token, mode, track_id)"
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_scores_rankings ON scores(mode, track_id, best_lap)"
    ),
  ]);
}

export function validateUsername(raw: unknown): string | null {
  const username = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  return USERNAME_RE.test(username) ? username : null;
}

function validateDeviceToken(raw: unknown): string | null {
  const token = String(raw || "").trim();
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) return null;
  return token;
}

function normalizeMode(raw: unknown): "trial" | "versus" | null {
  const mode = String(raw || "");
  return ALLOWED_MODES.has(mode) ? (mode as "trial" | "versus") : null;
}

export async function getDeviceByToken(db: D1Database, deviceTokenRaw: unknown): Promise<DeviceRecord | null> {
  const deviceToken = validateDeviceToken(deviceTokenRaw);
  if (!deviceToken) return null;
  await ensureLeaderboardSchema(db);
  const row = await db
    .prepare(
      `SELECT device_token, username, created_at, last_seen_at
       FROM devices
       WHERE device_token = ?`
    )
    .bind(deviceToken)
    .first<{
      device_token: string;
      username: string;
      created_at: number;
      last_seen_at: number;
    }>();
  if (!row) return null;
  return {
    deviceToken: row.device_token,
    username: row.username,
    createdAt: Number(row.created_at) || 0,
    lastSeenAt: Number(row.last_seen_at) || 0,
  };
}

export async function registerDevice(
  db: D1Database,
  body: Record<string, unknown>
): Promise<{ ok: true; created: boolean; username: string } | { ok: false; error: string; status: number }> {
  const deviceToken = validateDeviceToken(body.deviceToken);
  if (!deviceToken) return { ok: false, error: "invalid_device_token", status: 400 };
  const username = validateUsername(body.username);
  if (!username) return { ok: false, error: "invalid_username", status: 400 };

  await ensureLeaderboardSchema(db);
  const existing = await getDeviceByToken(db, deviceToken);
  const now = Date.now();

  if (existing) {
    if (existing.username !== username) {
      return { ok: false, error: "username_locked", status: 409 };
    }
    await db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE device_token = ?")
      .bind(now, deviceToken)
      .run();
    return { ok: true, created: false, username: existing.username };
  }

  await db
    .prepare(
      `INSERT INTO devices (device_token, username, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(deviceToken, username, now, now)
    .run();

  return { ok: true, created: true, username };
}

export async function getDeviceStatus(
  db: D1Database,
  deviceTokenRaw: unknown
): Promise<
  | { ok: true; registered: false }
  | { ok: true; registered: true; username: string; createdAt: number; lastSeenAt: number }
  | { ok: false; error: string; status: number }
> {
  const deviceToken = validateDeviceToken(deviceTokenRaw);
  if (!deviceToken) return { ok: false, error: "invalid_device_token", status: 400 };
  const device = await getDeviceByToken(db, deviceToken);
  if (!device) return { ok: true, registered: false };
  return {
    ok: true,
    registered: true,
    username: device.username,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

export async function submitScore(
  db: D1Database,
  body: Record<string, unknown>
): Promise<
  | { ok: true; saved: boolean; username: string; bestLap: number; reason?: string }
  | { ok: false; error: string; status: number }
> {
  const deviceToken = validateDeviceToken(body.deviceToken);
  if (!deviceToken) return { ok: false, error: "invalid_device_token", status: 400 };
  const mode = normalizeMode(body.mode);
  if (!mode) return { ok: false, error: "invalid_mode", status: 400 };

  const device = await getDeviceByToken(db, deviceToken);
  if (!device) return { ok: false, error: "unregistered_device", status: 401 };

  const trackId = Number(body.trackId ?? body.track_id);
  const bestLap = Number(body.bestLap ?? body.best_lap);
  if (!Number.isFinite(trackId) || trackId < 0 || trackId > 999) {
    return { ok: false, error: "invalid_track", status: 400 };
  }
  if (!Number.isFinite(bestLap) || !(bestLap > 0) || bestLap > 3600) {
    return { ok: false, error: "invalid_lap", status: 400 };
  }

  const trackName = String(body.trackName ?? body.track_name ?? "").slice(0, 64) || null;
  const totalNum = body.total == null ? null : Number(body.total);
  const total = Number.isFinite(totalNum) && totalNum! > 0 ? totalNum : null;
  const winner = body.winner == null ? null : String(body.winner).slice(0, 12);
  const now = Date.now();

  await ensureLeaderboardSchema(db);
  const existing = await db
    .prepare(
      `SELECT id, best_lap
       FROM scores
       WHERE device_token = ? AND mode = ? AND track_id = ?`
    )
    .bind(deviceToken, mode, Math.floor(trackId))
    .first<{ id: number; best_lap: number }>();

  await db
    .prepare("UPDATE devices SET last_seen_at = ? WHERE device_token = ?")
    .bind(now, deviceToken)
    .run();

  if (existing && Number(existing.best_lap) <= bestLap) {
    return { ok: true, saved: false, username: device.username, bestLap: Number(existing.best_lap), reason: "not_better" };
  }

  if (existing) {
    await db
      .prepare(
        `UPDATE scores
         SET username_snapshot = ?, track_name = ?, best_lap = ?, total = ?, winner = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(device.username, trackName, bestLap, total, winner, now, existing.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO scores (device_token, username_snapshot, mode, track_id, track_name, best_lap, total, winner, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(deviceToken, device.username, mode, Math.floor(trackId), trackName, bestLap, total, winner, now, now)
      .run();
  }

  return { ok: true, saved: true, username: device.username, bestLap };
}

export async function getLeaderboard(
  db: D1Database,
  modeRaw: unknown,
  trackIdRaw: unknown
): Promise<
  | { ok: true; scores: Array<{ username: string; mode: string; trackId: number; trackName: string | null; bestLap: number; total: number | null; winner: string | null; createdAt: number }> }
  | { ok: false; error: string; status: number }
> {
  const mode = normalizeMode(modeRaw);
  if (!mode) return { ok: false, error: "invalid_mode", status: 400 };
  const trackId = Number(trackIdRaw);
  if (!Number.isFinite(trackId) || trackId < 0 || trackId > 999) {
    return { ok: false, error: "invalid_track", status: 400 };
  }

  await ensureLeaderboardSchema(db);
  const rows = await db
    .prepare(
      `SELECT username_snapshot, mode, track_id, track_name, best_lap, total, winner, created_at
       FROM scores
       WHERE mode = ? AND track_id = ?
       ORDER BY best_lap ASC
       LIMIT ?`
    )
    .bind(mode, Math.floor(trackId), TOP_N)
    .all<ScoreRow>();

  return {
    ok: true,
    scores: (rows.results || []).map((r) => ({
      username: r.username_snapshot,
      mode: r.mode,
      trackId: Number(r.track_id) || 0,
      trackName: r.track_name || null,
      bestLap: Number(r.best_lap) || 0,
      total: r.total == null ? null : Number(r.total),
      winner: r.winner || null,
      createdAt: Number(r.created_at) || 0,
    })),
  };
}
