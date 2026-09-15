CREATE TABLE IF NOT EXISTS devices (
  device_token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_seen_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
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
  updated_at REAL NOT NULL,
  -- legacy = pre-validation era; verified = server-replayed trial run; unverified = client-reported (versus)
  trust_level TEXT NOT NULL DEFAULT 'legacy',
  rules_version INTEGER,
  verified_run_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_device_board
  ON scores(device_token, mode, track_id);

CREATE INDEX IF NOT EXISTS idx_scores_rankings
  ON scores(mode, track_id, best_lap);

-- Global (all-track) online race wins.
-- Stored per-device token to keep writes simple; leaderboard query aggregates by username.
CREATE TABLE IF NOT EXISTS online_wins (
  device_token TEXT PRIMARY KEY,
  username_snapshot TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_online_wins_rank ON online_wins(wins DESC);

-- Server-minted Time Trial runs. Completion requires shared-sim input replay.
CREATE TABLE IF NOT EXISTS validated_runs (
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
);

CREATE INDEX IF NOT EXISTS idx_runs_device_status ON validated_runs(device_token, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency ON validated_runs(idempotency_key);
