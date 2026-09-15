import {
  decodeTrialInputsBase64,
  LEADERBOARD_RULES_VERSION,
  minPlausibleLapSec,
  trialRunSpec,
  TRIAL_RUN_TTL_MS,
  verifyTrialReplay,
} from "../sim/trial-run";
import { TRACK_BAKE_VERSION } from "../sim/constants";
import { loadTrackBake } from "../sim/tracks";
import {
  ensureLeaderboardSchema,
  getDeviceByToken,
  type DeviceRecord,
} from "./leaderboard";
import { classifyTrialRunCompletion } from "./trial-run-guards";
export type TrustLevel = "legacy" | "verified" | "unverified";

function validateDeviceToken(raw: unknown): string | null {
  const token = String(raw || "").trim();
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) return null;
  return token;
}

function mintRunId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let s = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < bytes.length; i++) s += alphabet[bytes[i] & 63];
  return s;
}

async function ensureTrialRunSchema(db: D1Database): Promise<void> {
  await ensureLeaderboardSchema(db);
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS validated_runs (
        run_id TEXT PRIMARY KEY,
        device_token TEXT NOT NULL,
        mode TEXT NOT NULL,
        track_id INTEGER NOT NULL,
        track_name TEXT,
        rules_version INTEGER NOT NULL,
        track_bake_version INTEGER NOT NULL,
        weather TEXT NOT NULL,
        tyres TEXT NOT NULL,
        car_config TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at REAL NOT NULL,
        expires_at REAL NOT NULL,
        completed_at REAL,
        verified_best_lap REAL,
        lap_count INTEGER NOT NULL DEFAULT 0,
        consume_count INTEGER NOT NULL DEFAULT 0,
        max_consumes INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT
      )`
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_runs_device_status ON validated_runs(device_token, status)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency ON validated_runs(idempotency_key)"),
  ]);

  // Additive columns on scores (SQLite ignores duplicates via try).
  const alters = [
    "ALTER TABLE scores ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'legacy'",
    "ALTER TABLE scores ADD COLUMN rules_version INTEGER",
    "ALTER TABLE scores ADD COLUMN verified_run_id TEXT",
  ];
  for (const sql of alters) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* column may already exist */
    }
  }
}

type RunRow = {
  run_id: string;
  device_token: string;
  mode: string;
  track_id: number;
  track_name: string | null;
  rules_version: number;
  track_bake_version: number;
  weather: string;
  tyres: string;
  car_config: string;
  status: string;
  started_at: number;
  expires_at: number;
  completed_at: number | null;
  verified_best_lap: number | null;
  lap_count: number;
  consume_count: number;
  max_consumes: number;
  idempotency_key: string | null;
};

async function getRun(db: D1Database, runId: string): Promise<RunRow | null> {
  return (
    (await db
      .prepare(
        `SELECT run_id, device_token, mode, track_id, track_name, rules_version, track_bake_version,
                weather, tyres, car_config, status, started_at, expires_at, completed_at,
                verified_best_lap, lap_count, consume_count, max_consumes, idempotency_key
         FROM validated_runs WHERE run_id = ?`
      )
      .bind(runId)
      .first<RunRow>()) || null
  );
}

export async function startTrialRun(
  db: D1Database,
  body: Record<string, unknown>
): Promise<
  | {
      ok: true;
      runId: string;
      rulesVersion: number;
      trackBakeVersion: number;
      trackId: number;
      weather: string;
      tyres: string;
      carConfig: string;
      expiresAt: number;
      maxConsumes: number;
    }
  | { ok: false; error: string; status: number }
> {
  const deviceToken = validateDeviceToken(body.deviceToken);
  if (!deviceToken) return { ok: false, error: "invalid_device_token", status: 400 };

  const device = await getDeviceByToken(db, deviceToken);
  if (!device) return { ok: false, error: "unregistered_device", status: 401 };

  const trackId = Number(body.trackId ?? body.track_id);
  if (!Number.isFinite(trackId) || trackId < 0 || trackId > 999) {
    return { ok: false, error: "invalid_track", status: 400 };
  }
  const bake = loadTrackBake(Math.floor(trackId));
  if (!bake) return { ok: false, error: "unknown_track", status: 400 };

  const mode = String(body.mode || "trial");
  if (mode !== "trial") return { ok: false, error: "invalid_mode", status: 400 };

  const spec = trialRunSpec(trackId);
  const now = Date.now();
  const runId = mintRunId();
  const trackName = String(body.trackName ?? body.track_name ?? "").slice(0, 64) || null;

  await ensureTrialRunSchema(db);
  await db
    .prepare(
      `INSERT INTO validated_runs (
         run_id, device_token, mode, track_id, track_name, rules_version, track_bake_version,
         weather, tyres, car_config, status, started_at, expires_at, completed_at,
         verified_best_lap, lap_count, consume_count, max_consumes, idempotency_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL, 0, 0, 1, NULL)`
    )
    .bind(
      runId,
      deviceToken,
      spec.mode,
      spec.trackId,
      trackName,
      spec.rulesVersion,
      spec.trackBakeVersion,
      spec.weather,
      spec.tyres,
      spec.carConfig,
      now,
      now + TRIAL_RUN_TTL_MS
    )
    .run();

  await db
    .prepare("UPDATE devices SET last_seen_at = ? WHERE device_token = ?")
    .bind(now, deviceToken)
    .run();

  return {
    ok: true,
    runId,
    rulesVersion: spec.rulesVersion,
    trackBakeVersion: spec.trackBakeVersion,
    trackId: spec.trackId,
    weather: spec.weather,
    tyres: spec.tyres,
    carConfig: spec.carConfig,
    expiresAt: now + TRIAL_RUN_TTL_MS,
    maxConsumes: 1,
  };
}

async function upsertVerifiedScore(
  db: D1Database,
  device: DeviceRecord,
  trackId: number,
  trackName: string | null,
  bestLap: number,
  runId: string,
  rulesVersion: number
): Promise<{ saved: boolean; bestLap: number; reason?: string }> {
  const now = Date.now();
  const existing = await db
    .prepare(
      `SELECT id, best_lap, trust_level
       FROM scores
       WHERE device_token = ? AND mode = 'trial' AND track_id = ?`
    )
    .bind(device.deviceToken, trackId)
    .first<{ id: number; best_lap: number; trust_level?: string }>();

  if (existing) {
    const existingTrust = String(existing.trust_level || "legacy");
    const existingBetterOrEqual = Number(existing.best_lap) <= bestLap;
    // Fresh verified runs always displace legacy times — even if the number is slower.
    if (existingTrust !== "legacy" && existingBetterOrEqual) {
      return { saved: false, bestLap: Number(existing.best_lap), reason: "not_better" };
    }
  }

  if (existing) {
    await db
      .prepare(
        `UPDATE scores
         SET username_snapshot = ?, track_name = ?, best_lap = ?, total = NULL, winner = NULL,
             updated_at = ?, trust_level = 'verified', rules_version = ?, verified_run_id = ?
         WHERE id = ?`
      )
      .bind(device.username, trackName, bestLap, now, rulesVersion, runId, existing.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO scores (
           device_token, username_snapshot, mode, track_id, track_name, best_lap, total, winner,
           created_at, updated_at, trust_level, rules_version, verified_run_id
         ) VALUES (?, ?, 'trial', ?, ?, ?, NULL, NULL, ?, ?, 'verified', ?, ?)`
      )
      .bind(
        device.deviceToken,
        device.username,
        trackId,
        trackName,
        bestLap,
        now,
        now,
        rulesVersion,
        runId
      )
      .run();
  }
  return { saved: true, bestLap };
}

export async function completeTrialRun(
  db: D1Database,
  body: Record<string, unknown>
): Promise<
  | {
      ok: true;
      runId: string;
      saved: boolean;
      username: string;
      bestLap: number;
      lapTimes: number[];
      trustLevel: "verified";
      rulesVersion: number;
      reason?: string;
      idempotent?: boolean;
    }
  | { ok: false; error: string; status: number }
> {
  const deviceToken = validateDeviceToken(body.deviceToken);
  if (!deviceToken) return { ok: false, error: "invalid_device_token", status: 400 };
  const runId = String(body.runId || body.run_id || "").trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(runId)) {
    return { ok: false, error: "invalid_run_id", status: 400 };
  }

  const device = await getDeviceByToken(db, deviceToken);
  if (!device) return { ok: false, error: "unregistered_device", status: 401 };

  await ensureTrialRunSchema(db);
  const run = await getRun(db, runId);
  if (!run) return { ok: false, error: "unknown_run", status: 404 };
  if (run.device_token !== deviceToken) {
    return { ok: false, error: "run_device_mismatch", status: 403 };
  }
  if (run.mode !== "trial") return { ok: false, error: "invalid_mode", status: 400 };

  const now = Date.now();

  const gate = classifyTrialRunCompletion(
    run,
    deviceToken,
    now,
    LEADERBOARD_RULES_VERSION,
    TRACK_BAKE_VERSION
  );
  if (!gate.ok) {
    if (gate.markExpired) {
      await db.prepare(`UPDATE validated_runs SET status = 'expired' WHERE run_id = ?`).bind(runId).run();
    }
    return { ok: false, error: gate.error, status: gate.status };
  }
  if (gate.idempotent) {
    return {
      ok: true,
      runId,
      saved: false,
      username: device.username,
      bestLap: gate.bestLap,
      lapTimes: [],
      trustLevel: "verified",
      rulesVersion: Number(run.rules_version) || LEADERBOARD_RULES_VERSION,
      reason: "already_consumed",
      idempotent: true,
    };
  }

  const packed = decodeTrialInputsBase64(String(body.inputs || body.inputLog || ""));
  if (!packed) return { ok: false, error: "invalid_inputs", status: 400 };

  const bake = loadTrackBake(Number(run.track_id));
  if (!bake) return { ok: false, error: "unknown_track", status: 400 };

  const verified = verifyTrialReplay(bake, packed, {
    weather: run.weather || "dry",
    tyres: run.tyres || "med",
  });
  if (!verified.ok) {
    await db
      .prepare(`UPDATE validated_runs SET status = 'rejected', completed_at = ? WHERE run_id = ?`)
      .bind(now, runId)
      .run();
    return { ok: false, error: verified.error, status: 422 };
  }

  // Ignore any client-claimed lap entirely — board time is server-verified only.
  const floor = minPlausibleLapSec(bake);
  if (verified.bestLap < floor) {
    await db
      .prepare(`UPDATE validated_runs SET status = 'rejected', completed_at = ? WHERE run_id = ?`)
      .bind(now, runId)
      .run();
    return { ok: false, error: "implausible_lap", status: 422 };
  }

  const upsert = await upsertVerifiedScore(
    db,
    device,
    Number(run.track_id),
    run.track_name,
    verified.bestLap,
    runId,
    verified.rulesVersion
  );

  await db
    .prepare(
      `UPDATE validated_runs
       SET status = 'consumed', completed_at = ?, verified_best_lap = ?, lap_count = ?,
           consume_count = consume_count + 1, idempotency_key = ?
       WHERE run_id = ? AND status = 'open'`
    )
    .bind(now, verified.bestLap, verified.lapTimes.length, `consume:${runId}`, runId)
    .run();

  await db
    .prepare("UPDATE devices SET last_seen_at = ? WHERE device_token = ?")
    .bind(now, deviceToken)
    .run();

  return {
    ok: true,
    runId,
    saved: upsert.saved,
    username: device.username,
    bestLap: verified.bestLap,
    lapTimes: verified.lapTimes,
    trustLevel: "verified",
    rulesVersion: verified.rulesVersion,
    reason: upsert.reason,
  };
}
