import { ensureLeaderboardSchema, validateUsername } from "./leaderboard";
import { listTrackIds } from "../sim/tracks";

const TRACK_NAMES: Record<number, string> = {
  0: "SUNSET SPEEDWAY",
  1: "MEADOW PARK",
  2: "BLUE BAY RUN",
  3: "HURRICANE PASS",
  4: "RIVIERA GP",
  5: "TITAN LOOP",
  6: "AMBER HIGHWAY",
  7: "NEON CITY GP",
};

const TRACK_TARGET_LAP: Record<number, number> = {
  0: 42,
  1: 38,
  2: 44,
  3: 52,
  4: 58,
  5: 63,
  6: 55,
  7: 65,
};

const RANDOM_PREFIXES = ["RACER", "NITRO", "DRIFT", "TURBO", "SPEED", "LAP", "GRID", "POLE", "BOOST", "WHEEL"];

export function checkAdminPassword(expected: string | undefined, provided: string | null): boolean {
  if (!expected || !provided) return false;
  return provided === expected;
}

function isSeededToken(token: string): boolean {
  return token.startsWith("seed_");
}

export function makeSeedToken(username: string): string {
  const base = `seed_${username}_`;
  const pad = "0000000000000000000000000000000000000000";
  return (base + pad).slice(0, 48);
}

function parseLapTime(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 3600) return raw;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 0 && n <= 3600 ? n : null;
  }
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) {
    const sec = Number(m[1]) * 60 + Number(m[2]);
    return sec > 0 && sec <= 3600 ? sec : null;
  }
  return null;
}

function trackName(trackId: number): string {
  return TRACK_NAMES[trackId] || `TRACK ${trackId}`;
}

function buildTracksList() {
  return listTrackIds().map((id) => ({
    id,
    name: trackName(id),
    targetLap: TRACK_TARGET_LAP[id] ?? 60,
  }));
}

type OnlineWinRow = {
  device_token: string;
  username_snapshot: string;
  wins: number;
  updated_at: number;
};

type ScoreAdminRow = {
  id: number;
  device_token: string;
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

function groupScores(rows: ScoreAdminRow[]) {
  const trial: Record<string, unknown[]> = {};
  const versus: Record<string, unknown[]> = {};
  for (const r of rows) {
    const bucket = r.mode === "versus" ? versus : r.mode === "trial" ? trial : null;
    if (!bucket) continue;
    const key = String(r.track_id);
    if (!bucket[key]) bucket[key] = [];
    bucket[key].push({
      id: r.id,
      deviceToken: r.device_token,
      username: r.username_snapshot,
      bestLap: Number(r.best_lap) || 0,
      total: r.total == null ? null : Number(r.total),
      winner: r.winner || null,
      createdAt: Number(r.created_at) || 0,
      updatedAt: Number(r.updated_at) || 0,
      seeded: isSeededToken(r.device_token),
    });
  }
  return { trial, versus };
}

export async function getAdminLeaderboard(db: D1Database): Promise<{ ok: true; payload: unknown } | { ok: false; error: string; status: number }> {
  await ensureLeaderboardSchema(db);

  const onlineRows = await db
    .prepare(
      `SELECT device_token, username_snapshot, wins, updated_at
       FROM online_wins
       ORDER BY wins DESC, username_snapshot ASC`
    )
    .all<OnlineWinRow>();

  const scoreRows = await db
    .prepare(
      `SELECT id, device_token, username_snapshot, mode, track_id, track_name, best_lap, total, winner, created_at, updated_at
       FROM scores
       WHERE mode IN ('trial', 'versus')
       ORDER BY mode ASC, track_id ASC, best_lap ASC`
    )
    .all<ScoreAdminRow>();

  const onlineWins = (onlineRows.results || []).map((r) => ({
    deviceToken: r.device_token,
    username: r.username_snapshot,
    wins: Number(r.wins) || 0,
    updatedAt: Number(r.updated_at) || 0,
    seeded: isSeededToken(r.device_token),
  }));

  return {
    ok: true,
    payload: {
      tracks: buildTracksList(),
      onlineWins,
      scores: groupScores(scoreRows.results || []),
    },
  };
}

export async function upsertAdminEntry(
  db: D1Database,
  body: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const kind = String(body.kind || "");
  const now = Date.now();

  await ensureLeaderboardSchema(db);

  if (kind === "online") {
    const wins = Math.floor(Number(body.wins));
    if (!Number.isFinite(wins) || wins < 0 || wins > 999999) {
      return { ok: false, error: "invalid_wins", status: 400 };
    }

    let deviceToken = String(body.deviceToken || body.device_token || "").trim();
    let username = validateUsername(body.username);

    if (deviceToken) {
      const row = await db
        .prepare(`SELECT device_token, username_snapshot FROM online_wins WHERE device_token = ?`)
        .bind(deviceToken)
        .first<{ device_token: string; username_snapshot: string }>();
      if (!row) return { ok: false, error: "not_found", status: 404 };
      username = validateUsername(body.username) || row.username_snapshot;
    } else {
      if (!username) return { ok: false, error: "invalid_username", status: 400 };
      const existing = await db
        .prepare(`SELECT device_token FROM online_wins WHERE username_snapshot = ? LIMIT 1`)
        .bind(username)
        .first<{ device_token: string }>();
      deviceToken = existing?.device_token || makeSeedToken(username);
    }

    if (!username) return { ok: false, error: "invalid_username", status: 400 };

    await db
      .prepare(
        `INSERT INTO online_wins (device_token, username_snapshot, wins, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_token) DO UPDATE SET
           wins = excluded.wins,
           username_snapshot = excluded.username_snapshot,
           updated_at = excluded.updated_at`
      )
      .bind(deviceToken, username, wins, now)
      .run();

    return { ok: true };
  }

  if (kind === "score") {
    const mode = String(body.mode || "");
    if (mode !== "trial" && mode !== "versus") return { ok: false, error: "invalid_mode", status: 400 };

    const trackId = Math.floor(Number(body.trackId ?? body.track_id));
    if (!Number.isFinite(trackId) || trackId < 0 || trackId > 999) {
      return { ok: false, error: "invalid_track", status: 400 };
    }

    const bestLap = parseLapTime(body.bestLap ?? body.best_lap);
    if (bestLap == null) return { ok: false, error: "invalid_lap", status: 400 };

    const totalRaw = body.total == null || body.total === "" ? null : parseLapTime(body.total);
    const total = totalRaw != null ? totalRaw : bestLap * 3;

    const scoreId = body.id != null ? Math.floor(Number(body.id)) : null;
    let deviceToken = String(body.deviceToken || body.device_token || "").trim();
    let username = validateUsername(body.username);
    const tName = String(body.trackName || body.track_name || trackName(trackId)).slice(0, 64);

    if (scoreId && Number.isFinite(scoreId)) {
      const row = await db
        .prepare(`SELECT id, device_token, username_snapshot FROM scores WHERE id = ?`)
        .bind(scoreId)
        .first<{ id: number; device_token: string; username_snapshot: string }>();
      if (!row) return { ok: false, error: "not_found", status: 404 };
      username = username || row.username_snapshot;
      await db
        .prepare(
          `UPDATE scores
           SET username_snapshot = ?, track_name = ?, best_lap = ?, total = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(username, tName, bestLap, total, now, scoreId)
        .run();
      return { ok: true };
    }

    if (deviceToken) {
      const row = await db
        .prepare(`SELECT device_token, username_snapshot FROM scores WHERE device_token = ? AND mode = ? AND track_id = ?`)
        .bind(deviceToken, mode, trackId)
        .first<{ device_token: string; username_snapshot: string }>();
      if (row) {
        deviceToken = row.device_token;
        username = username || row.username_snapshot;
      }
    } else {
      if (!username) return { ok: false, error: "invalid_username", status: 400 };
      const existing = await db
        .prepare(`SELECT device_token FROM scores WHERE username_snapshot = ? AND mode = ? AND track_id = ? LIMIT 1`)
        .bind(username, mode, trackId)
        .first<{ device_token: string }>();
      deviceToken = existing?.device_token || makeSeedToken(username);
    }

    if (!username) return { ok: false, error: "invalid_username", status: 400 };

    const existingByKey = await db
      .prepare(`SELECT id FROM scores WHERE device_token = ? AND mode = ? AND track_id = ?`)
      .bind(deviceToken, mode, trackId)
      .first<{ id: number }>();

    if (existingByKey) {
      await db
        .prepare(
          `UPDATE scores
           SET username_snapshot = ?, track_name = ?, best_lap = ?, total = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(username, tName, bestLap, total, now, existingByKey.id)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO scores (device_token, username_snapshot, mode, track_id, track_name, best_lap, total, winner, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .bind(deviceToken, username, mode, trackId, tName, bestLap, total, now, now)
        .run();
    }

    return { ok: true };
  }

  return { ok: false, error: "invalid_kind", status: 400 };
}

export async function deleteAdminEntry(
  db: D1Database,
  body: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const kind = String(body.kind || "");
  await ensureLeaderboardSchema(db);

  if (kind === "online") {
    const deviceToken = String(body.deviceToken || body.device_token || "").trim();
    if (!deviceToken) return { ok: false, error: "missing_device_token", status: 400 };
    await db.prepare(`DELETE FROM online_wins WHERE device_token = ?`).bind(deviceToken).run();
    return { ok: true };
  }

  if (kind === "score") {
    const scoreId = Math.floor(Number(body.id));
    if (Number.isFinite(scoreId) && scoreId > 0) {
      await db.prepare(`DELETE FROM scores WHERE id = ?`).bind(scoreId).run();
      return { ok: true };
    }
    const deviceToken = String(body.deviceToken || body.device_token || "").trim();
    const mode = String(body.mode || "");
    const trackId = Math.floor(Number(body.trackId ?? body.track_id));
    if (!deviceToken || (mode !== "trial" && mode !== "versus") || !Number.isFinite(trackId)) {
      return { ok: false, error: "invalid_delete_target", status: 400 };
    }
    await db
      .prepare(`DELETE FROM scores WHERE device_token = ? AND mode = ? AND track_id = ?`)
      .bind(deviceToken, mode, trackId)
      .run();
    return { ok: true };
  }

  return { ok: false, error: "invalid_kind", status: 400 };
}

function randomUsername(existing: Set<string>): string {
  for (let i = 0; i < 40; i++) {
    const prefix = RANDOM_PREFIXES[Math.floor(Math.random() * RANDOM_PREFIXES.length)];
    const n = Math.floor(Math.random() * 9000 + 100);
    const name = (prefix + n).slice(0, 12).toUpperCase();
    if (!existing.has(name) && validateUsername(name)) {
      existing.add(name);
      return name;
    }
  }
  const fallback = ("BOT" + Math.floor(Math.random() * 999999)).slice(0, 12);
  existing.add(fallback);
  return fallback;
}

export async function addRandomAdminEntries(
  db: D1Database,
  body: Record<string, unknown>
): Promise<{ ok: true; added: number } | { ok: false; error: string; status: number }> {
  const kind = String(body.kind || "");
  const count = Math.max(1, Math.min(25, Math.floor(Number(body.count) || 5)));
  const now = Date.now();

  await ensureLeaderboardSchema(db);

  const existingNames = new Set<string>();
  const onlineRows = await db.prepare(`SELECT username_snapshot FROM online_wins`).all<{ username_snapshot: string }>();
  const scoreRows = await db.prepare(`SELECT username_snapshot FROM scores`).all<{ username_snapshot: string }>();
  for (const r of onlineRows.results || []) existingNames.add(r.username_snapshot);
  for (const r of scoreRows.results || []) existingNames.add(r.username_snapshot);

  if (kind === "online") {
    for (let i = 0; i < count; i++) {
      const username = randomUsername(existingNames);
      const wins = Math.floor(Math.random() * 120 + 1);
      const token = makeSeedToken(username);
      await db
        .prepare(
          `INSERT INTO online_wins (device_token, username_snapshot, wins, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(device_token) DO UPDATE SET wins = excluded.wins, updated_at = excluded.updated_at`
        )
        .bind(token, username, wins, now)
        .run();
    }
    return { ok: true, added: count };
  }

  if (kind === "trial" || kind === "versus") {
    const trackId = Math.floor(Number(body.trackId ?? body.track_id));
    if (!Number.isFinite(trackId) || trackId < 0 || trackId > 999) {
      return { ok: false, error: "invalid_track", status: 400 };
    }
    const base = TRACK_TARGET_LAP[trackId] ?? 60;
    const tName = trackName(trackId);

    for (let i = 0; i < count; i++) {
      const username = randomUsername(existingNames);
      const token = makeSeedToken(username);
      const jitter = (Math.random() - 0.5) * 8;
      const bestLap = Math.max(8, base + jitter);
      const total = bestLap * 3 + Math.random() * 4;
      await db
        .prepare(
          `INSERT INTO scores (device_token, username_snapshot, mode, track_id, track_name, best_lap, total, winner, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(device_token, mode, track_id) DO UPDATE SET
             best_lap = excluded.best_lap,
             total = excluded.total,
             updated_at = excluded.updated_at`
        )
        .bind(token, username, kind, trackId, tName, bestLap, total, now, now)
        .run();
    }
    return { ok: true, added: count };
  }

  return { ok: false, error: "invalid_kind", status: 400 };
}
