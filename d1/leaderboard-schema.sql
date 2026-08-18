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
  updated_at REAL NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_device_board
  ON scores(device_token, mode, track_id);

CREATE INDEX IF NOT EXISTS idx_scores_rankings
  ON scores(mode, track_id, best_lap);
