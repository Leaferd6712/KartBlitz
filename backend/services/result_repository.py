from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

from backend.game.state import ValidatedResult


class ResultRepository:
    """SQLite persistence for profiles, race history, and leaderboards."""

    def __init__(self, database_path: Path):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialise()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialise(self) -> None:
        with self._lock, self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS profiles (
                    player_id TEXT PRIMARY KEY,
                    player_name TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS race_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_result_id TEXT NOT NULL UNIQUE,
                    player_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    track_id INTEGER NOT NULL,
                    track_name TEXT NOT NULL,
                    best_lap REAL NOT NULL,
                    total REAL,
                    laps INTEGER NOT NULL,
                    details_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    FOREIGN KEY(player_id) REFERENCES profiles(player_id)
                );
                CREATE TABLE IF NOT EXISTS scores (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    player_id TEXT NOT NULL,
                    player_name TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    track_id INTEGER NOT NULL,
                    track_name TEXT NOT NULL,
                    best_lap REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    UNIQUE(player_id, mode, track_id)
                );
                CREATE INDEX IF NOT EXISTS idx_scores_board
                    ON scores(mode, track_id, best_lap, updated_at);
                CREATE INDEX IF NOT EXISTS idx_history_player
                    ON race_history(player_id, created_at DESC);
                """
            )

    def save_result(self, result: ValidatedResult) -> dict:
        now = time.time()
        with self._lock, self._connect() as connection:
            existing = connection.execute(
                "SELECT id FROM race_history WHERE client_result_id = ?",
                (result.client_result_id,),
            ).fetchone()
            if existing:
                return {
                    "resultId": int(existing["id"]),
                    "idempotent": True,
                    "leaderboardSaved": False,
                    "bestLap": result.best_lap_seconds,
                }

            connection.execute(
                """
                INSERT INTO profiles(player_id, player_name, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(player_id) DO UPDATE SET
                    player_name = excluded.player_name,
                    updated_at = excluded.updated_at
                """,
                (result.player_id, result.player_name, now, now),
            )
            cursor = connection.execute(
                """
                INSERT INTO race_history(
                    client_result_id, player_id, mode, track_id, track_name,
                    best_lap, total, laps, details_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    result.client_result_id,
                    result.player_id,
                    result.mode,
                    result.track_id,
                    result.track_name,
                    result.best_lap_seconds,
                    result.total_seconds,
                    result.laps,
                    json.dumps(result.details, separators=(",", ":"), sort_keys=True),
                    now,
                ),
            )
            prior = connection.execute(
                "SELECT best_lap FROM scores WHERE player_id = ? AND mode = ? AND track_id = ?",
                (result.player_id, result.mode, result.track_id),
            ).fetchone()
            leaderboard_saved = not prior or result.best_lap_seconds < float(prior["best_lap"])
            if leaderboard_saved:
                connection.execute(
                    """
                    INSERT INTO scores(
                        player_id, player_name, mode, track_id, track_name, best_lap, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(player_id, mode, track_id) DO UPDATE SET
                        player_name = excluded.player_name,
                        track_name = excluded.track_name,
                        best_lap = excluded.best_lap,
                        updated_at = excluded.updated_at
                    """,
                    (
                        result.player_id,
                        result.player_name,
                        result.mode,
                        result.track_id,
                        result.track_name,
                        result.best_lap_seconds,
                        now,
                    ),
                )
            return {
                "resultId": int(cursor.lastrowid),
                "idempotent": False,
                "leaderboardSaved": leaderboard_saved,
                "bestLap": result.best_lap_seconds,
            }

    def leaderboard(self, *, mode: str, track_id: int, limit: int = 50) -> list[dict]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT player_name, mode, track_id, track_name, best_lap, updated_at
                FROM scores WHERE mode = ? AND track_id = ?
                ORDER BY best_lap ASC, updated_at ASC LIMIT ?
                """,
                (mode, track_id, max(1, min(limit, 100))),
            ).fetchall()
        return [
            {
                "rank": index + 1,
                "playerName": row["player_name"],
                "mode": row["mode"],
                "trackId": row["track_id"],
                "trackName": row["track_name"],
                "bestLap": row["best_lap"],
                "updatedAt": row["updated_at"],
            }
            for index, row in enumerate(rows)
        ]

    def profile(self, player_id: str, history_limit: int = 20) -> dict | None:
        with self._lock, self._connect() as connection:
            profile = connection.execute(
                "SELECT player_id, player_name, created_at, updated_at FROM profiles WHERE player_id = ?",
                (player_id,),
            ).fetchone()
            if not profile:
                return None
            history = connection.execute(
                """
                SELECT id, mode, track_id, track_name, best_lap, total, laps, details_json, created_at
                FROM race_history WHERE player_id = ?
                ORDER BY created_at DESC LIMIT ?
                """,
                (player_id, max(1, min(history_limit, 100))),
            ).fetchall()
            count = connection.execute(
                "SELECT COUNT(*) AS count FROM race_history WHERE player_id = ?",
                (player_id,),
            ).fetchone()["count"]
        return {
            "playerId": profile["player_id"],
            "playerName": profile["player_name"],
            "createdAt": profile["created_at"],
            "updatedAt": profile["updated_at"],
            "raceCount": count,
            "history": [
                {
                    "resultId": row["id"],
                    "mode": row["mode"],
                    "trackId": row["track_id"],
                    "trackName": row["track_name"],
                    "bestLap": row["best_lap"],
                    "total": row["total"],
                    "laps": row["laps"],
                    "details": json.loads(row["details_json"]),
                    "createdAt": row["created_at"],
                }
                for row in history
            ],
        }

