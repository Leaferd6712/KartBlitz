"""KartBlitz shared leaderboard API + static file server (stdlib only)."""

from __future__ import annotations

import json
import re
import sqlite3
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(__file__).resolve().parent / "scores.db"
PORT = 8787
TOP_N = 50

USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-]{3,16}$")
ALLOWED_MODES = {"trial", "versus"}


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                mode TEXT NOT NULL,
                track_id INTEGER NOT NULL,
                track_name TEXT,
                best_lap REAL NOT NULL,
                total REAL,
                created_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scores_board ON scores(mode, track_id, best_lap)"
        )


def cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **getattr(SimpleHTTPRequestHandler, "extensions_map", {}),
        ".glb": "model/gltf-binary",
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        for k, v in cors_headers().items():
            self.send_header(k, v)
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self._json(200, {"ok": True, "service": "kartblitz-leaderboard"})
        if parsed.path == "/api/leaderboard":
            qs = parse_qs(parsed.query)
            mode = (qs.get("mode") or ["trial"])[0]
            try:
                track_id = int((qs.get("trackId") or qs.get("track_id") or ["0"])[0])
            except ValueError:
                track_id = 0
            if mode not in ALLOWED_MODES:
                mode = "trial"
            rows = []
            with get_db() as conn:
                cur = conn.execute(
                    """
                    SELECT username, mode, track_id, track_name, best_lap, total, created_at
                    FROM scores
                    WHERE mode = ? AND track_id = ?
                    ORDER BY best_lap ASC
                    LIMIT ?
                    """,
                    (mode, track_id, TOP_N),
                )
                for r in cur.fetchall():
                    rows.append(
                        {
                            "username": r["username"],
                            "mode": r["mode"],
                            "trackId": r["track_id"],
                            "trackName": r["track_name"],
                            "bestLap": r["best_lap"],
                            "total": r["total"],
                            "createdAt": r["created_at"],
                        }
                    )
            return self._json(200, {"scores": rows})
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/scores", "/api/submit"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._json(400, {"error": "invalid_json"})

        username = str(body.get("username") or "").strip()
        if not USERNAME_RE.match(username):
            return self._json(400, {"error": "invalid_username"})
        mode = str(body.get("mode") or "trial")
        if mode not in ALLOWED_MODES:
            return self._json(400, {"error": "invalid_mode"})
        try:
            track_id = int(body.get("trackId", body.get("track_id", 0)))
            best_lap = float(body.get("bestLap", body.get("best_lap")))
        except (TypeError, ValueError):
            return self._json(400, {"error": "invalid_fields"})
        if not (best_lap > 0) or best_lap > 3600:
            return self._json(400, {"error": "invalid_lap"})
        track_name = str(body.get("trackName") or body.get("track_name") or "")[:64]
        total = body.get("total")
        try:
            total_f = float(total) if total is not None else None
        except (TypeError, ValueError):
            total_f = None

        with get_db() as conn:
            existing = conn.execute(
                """
                SELECT id, best_lap FROM scores
                WHERE username = ? AND mode = ? AND track_id = ?
                ORDER BY best_lap ASC LIMIT 1
                """,
                (username, mode, track_id),
            ).fetchone()
            if existing and float(existing["best_lap"]) <= best_lap:
                return self._json(
                    200,
                    {"ok": True, "saved": False, "reason": "not_better", "bestLap": existing["best_lap"]},
                )
            if existing:
                conn.execute("DELETE FROM scores WHERE id = ?", (existing["id"],))
            conn.execute(
                """
                INSERT INTO scores (username, mode, track_id, track_name, best_lap, total, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (username, mode, track_id, track_name, best_lap, total_f, time.time()),
            )
        return self._json(200, {"ok": True, "saved": True, "bestLap": best_lap})

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("KartBlitz leaderboard on http://localhost:%s" % PORT)
    print("  GET  /api/health")
    print("  GET  /api/leaderboard?mode=trial&trackId=0")
    print("  POST /api/scores")
    print("  Static files from %s" % ROOT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
