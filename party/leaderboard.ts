const USERNAME_RE = /^[A-Z0-9]{3,12}$/;
const ALLOWED_MODES = new Set(["trial", "versus", "online"]);
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
    db.prepare(
      `CREATE TABLE IF NOT EXISTS online_wins (
        device_token TEXT PRIMARY KEY,
        username_snapshot TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0,
        updated_at REAL NOT NULL
      )`
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_online_wins_rank ON online_wins(wins DESC)"),
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

function normalizeMode(raw: unknown): "trial" | "versus" | "online" | null {
  const mode = String(raw || "");
  return ALLOWED_MODES.has(mode) ? (mode as "trial" | "versus" | "online") : null;
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

export async function recordOnlineWin(db: D1Database, deviceTokenRaw: unknown): Promise<{
  ok: true;
  username: string;
  wins: number;
} | { ok: false; error: string; status: number }> {
  const deviceToken = validateDeviceToken(deviceTokenRaw);
  if (!deviceToken) return { ok: false, error: "invalid_device_token", status: 400 };

  const device = await getDeviceByToken(db, deviceToken);
  if (!device) return { ok: false, error: "unregistered_device", status: 401 };

  const now = Date.now();
  await ensureLeaderboardSchema(db);
  await db
    .prepare(
      `INSERT INTO online_wins (device_token, username_snapshot, wins, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(device_token) DO UPDATE SET
         wins = wins + 1,
         username_snapshot = excluded.username_snapshot,
         updated_at = excluded.updated_at`
    )
    .bind(deviceToken, device.username, now)
    .run();

  const row = await db
    .prepare(`SELECT wins FROM online_wins WHERE device_token = ?`)
    .bind(deviceToken)
    .first<{ wins: number }>();

  return { ok: true, username: device.username, wins: Number(row?.wins) || 0 };
}

type OnlineWinsRow = {
  username_snapshot: string;
  wins: number;
  updated_at: number;
};

export async function getOnlineWinsLeaderboard(
  db: D1Database
): Promise<{ ok: true; scores: Array<{ username: string; wins: number; createdAt: number }> } | { ok: false; error: string; status: number }> {
  await ensureLeaderboardSchema(db);

  const rows = await db
    .prepare(
      `SELECT username_snapshot, SUM(wins) as wins, MAX(updated_at) as updated_at
       FROM online_wins
       GROUP BY username_snapshot
       ORDER BY wins DESC
       LIMIT ?`
    )
    .bind(TOP_N)
    .all<OnlineWinsRow>();

  return {
    ok: true,
    scores: (rows.results || []).map((r) => ({
      username: r.username_snapshot,
      wins: Number(r.wins) || 0,
      createdAt: Number(r.updated_at) || 0,
    })),
  };
}

export async function getLeaderboard(
  db: D1Database,
  modeRaw: unknown,
  trackIdRaw: unknown
): Promise<
  | {
      ok: true;
      scores: Array<{
        username: string;
        mode: string;
        trackId: number;
        trackName: string | null;
        bestLap: number;
        total: number | null;
        winner: string | null;
        createdAt: number;
        wins?: number;
      }>;
    }
  | { ok: false; error: string; status: number }
> {
  const mode = normalizeMode(modeRaw);
  if (!mode) return { ok: false, error: "invalid_mode", status: 400 };

  if (mode === "online") {
    const wins = await getOnlineWinsLeaderboard(db);
    if (!wins.ok) return wins;
    return {
      ok: true,
      scores: wins.scores.map((r) => ({
        username: r.username,
        mode: "online",
        trackId: 0,
        trackName: null,
        bestLap: r.wins, // legacy field; UI for online will read `wins` when present
        total: null,
        winner: null,
        createdAt: r.createdAt,
        wins: r.wins,
      })) as unknown as Array<{
        username: string;
        mode: string;
        trackId: number;
        trackName: string | null;
        bestLap: number;
        total: number | null;
        winner: string | null;
        createdAt: number;
        wins: number;
      }>,
    };
  }

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

type BackupDeviceRow = {
  username: string;
  created_at: number;
  last_seen_at: number;
};

type BackupScoreRow = {
  username_snapshot: string;
  mode: string;
  track_id: number;
  track_name: string | null;
  best_lap: number;
  total: number | null;
  winner: string | null;
  created_at: number;
  updated_at: number;
};

export type LeaderboardBackupPayload = {
  version: 1;
  generatedAt: string;
  deviceCount: number;
  scoreCount: number;
  onlineWinCount: number;
  devices: Array<{ username: string; registeredAt: string; lastSeenAt: string }>;
  scores: Array<{
    mode: string;
    trackId: number;
    trackName: string | null;
    username: string;
    bestLap: number;
    bestLapText: string;
    total: number | null;
    totalText: string | null;
    winner: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  onlineWins: Array<{
    username: string;
    wins: number;
    winsText: string;
    updatedAt: string;
  }>;
};

function isoFromEpoch(value: number): string {
  const ms = Number(value) || 0;
  if (!ms) return "";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

function formatLapTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || !(sec >= 0)) return "-";
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return m + ":" + s;
}

function pad(value: unknown, width: number): string {
  return String(value ?? "").padEnd(width, " ");
}

export function formatLeaderboardBackupText(payload: LeaderboardBackupPayload): string {
  const lines: string[] = [
    "KartBlitz Leaderboard Backup",
    "Generated (UTC): " + payload.generatedAt,
    "Registered devices: " + payload.deviceCount,
    "Saved scores: " + payload.scoreCount,
    "Saved online wins: " + payload.onlineWinCount,
    "",
    "This file is a full snapshot of cloud leaderboard records (usernames and times).",
    "Device tokens are omitted so the file is safe to keep in git.",
    "Use this if D1 data is lost and you need to refer back to previous records.",
    "",
    "------------------------------------------------------------------------------",
    "REGISTERED USERNAMES",
    "------------------------------------------------------------------------------",
  ];

  if (!payload.devices.length) {
    lines.push("No registered devices yet.");
  } else {
    lines.push(pad("USERNAME", 16) + pad("REGISTERED (UTC)", 26) + "LAST SEEN (UTC)");
    for (const device of payload.devices) {
      lines.push(pad(device.username, 16) + pad(device.registeredAt, 26) + device.lastSeenAt);
    }
  }

  lines.push(
    "",
    "------------------------------------------------------------------------------",
    "SCORES (best lap first within each mode/track)",
    "------------------------------------------------------------------------------"
  );

  if (!payload.scores.length) {
    lines.push("No scores saved yet.");
  } else {
    lines.push(
      pad("MODE", 10) +
        pad("TRACK", 8) +
        pad("TRACK NAME", 24) +
        pad("USERNAME", 14) +
        pad("BEST LAP", 12) +
        pad("TOTAL", 12) +
        pad("WINNER", 10) +
        "CREATED (UTC)"
    );
    for (const score of payload.scores) {
      lines.push(
        pad(score.mode, 10) +
          pad(score.trackId, 8) +
          pad(score.trackName || "-", 24) +
          pad(score.username, 14) +
          pad(score.bestLapText, 12) +
          pad(score.totalText || "-", 12) +
          pad(score.winner || "-", 10) +
          score.createdAt
      );
    }
  }

  lines.push(
    "",
    "------------------------------------------------------------------------------",
    "ONLINE WINS (wins desc)",
    "------------------------------------------------------------------------------"
  );

  if (!payload.onlineWins.length) {
    lines.push("No online wins saved yet.");
  } else {
    lines.push(
      pad("USERNAME", 16) +
        pad("WINS", 12) +
        "UPDATED (UTC)"
    );
    for (const win of payload.onlineWins) {
      lines.push(pad(win.username, 16) + pad(win.winsText, 12) + win.updatedAt);
    }
  }

  lines.push(
    "",
    "------------------------------------------------------------------------------",
    "MACHINE-READABLE JSON (for restore / import)",
    "------------------------------------------------------------------------------",
    JSON.stringify(payload, null, 2),
    ""
  );

  return lines.join("\n");
}

export async function exportLeaderboardBackup(db: D1Database): Promise<{
  ok: true;
  text: string;
  payload: LeaderboardBackupPayload;
}> {
  await ensureLeaderboardSchema(db);
  const deviceRows = await db
    .prepare(
      `SELECT username, created_at, last_seen_at
       FROM devices
       ORDER BY created_at ASC`
    )
    .all<BackupDeviceRow>();
  const scoreRows = await db
    .prepare(
      `SELECT username_snapshot, mode, track_id, track_name, best_lap, total, winner, created_at, updated_at
       FROM scores
       ORDER BY mode ASC, track_id ASC, best_lap ASC`
    )
    .all<BackupScoreRow>();

  type BackupOnlineWinRow = {
    username_snapshot: string;
    wins: number;
    updated_at: number;
  };

  const onlineWinRows = await db
    .prepare(
      `SELECT username_snapshot, SUM(wins) as wins, MAX(updated_at) as updated_at
       FROM online_wins
       GROUP BY username_snapshot
       ORDER BY wins DESC`
    )
    .all<BackupOnlineWinRow>();

  const devices = (deviceRows.results || []).map((row) => ({
    username: String(row.username || ""),
    registeredAt: isoFromEpoch(Number(row.created_at) || 0),
    lastSeenAt: isoFromEpoch(Number(row.last_seen_at) || 0),
  }));
  const scores = (scoreRows.results || []).map((row) => {
    const bestLap = Number(row.best_lap) || 0;
    const total = row.total == null ? null : Number(row.total);
    return {
      mode: String(row.mode || ""),
      trackId: Number(row.track_id) || 0,
      trackName: row.track_name || null,
      username: String(row.username_snapshot || ""),
      bestLap,
      bestLapText: formatLapTime(bestLap),
      total: total != null && Number.isFinite(total) ? total : null,
      totalText: total != null && Number.isFinite(total) ? formatLapTime(total) : null,
      winner: row.winner || null,
      createdAt: isoFromEpoch(Number(row.created_at) || 0),
      updatedAt: isoFromEpoch(Number(row.updated_at) || 0),
    };
  });

  const onlineWins = (onlineWinRows.results || []).map((row) => {
    const wins = Number(row.wins) || 0;
    return {
      username: String(row.username_snapshot || ""),
      wins,
      winsText: String(wins),
      updatedAt: isoFromEpoch(Number(row.updated_at) || 0),
    };
  });

  const payload: LeaderboardBackupPayload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    deviceCount: devices.length,
    scoreCount: scores.length,
    onlineWinCount: onlineWins.length,
    devices,
    scores,
    onlineWins,
  };

  return { ok: true, text: formatLeaderboardBackupText(payload), payload };
}
