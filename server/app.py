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
                username_key TEXT NOT NULL,
                mode TEXT NOT NULL,
                track_id INTEGER NOT NULL,
                time REAL NOT NULL,
                total REAL,
                updated_at INTEGER NOT NULL,
                UNIQUE(username_key, mode, track_id)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scores_board ON scores(mode, track_id, time)"
        )


def normalize_username(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    name = raw.strip()
    if not USERNAME_RE.match(name):
        return None
    return name


def row_to_entry(row: sqlite3.Row) -> dict:
    return {
        "username": row["username"],
        "mode": row["mode"],
        "trackId": row["track_id"],
        "time": row["time"],
        "total": row["total"],
        "date": row["updated_at"],
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

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json(200, {"ok": True, "service": "kartblitz-leaderboard"})
            return

        if path == "/api/leaderboard":
            qs = parse_qs(parsed.query)
            mode = (qs.get("mode", ["trial"])[0] or "trial").strip().lower()
            if mode not in ALLOWED_MODES:
                self._send_json(400, {"error": "invalid mode"})
                return
            try:
                track_id = int(qs.get("trackId", ["0"])[0])
            except ValueError:
                self._send_json(400, {"error": "invalid trackId"})
                return
            try:
                limit = min(max(int(qs.get("limit", [str(TOP_N)])[0]), 1), 100)
            except ValueError:
                limit = TOP_N

            with get_db() as conn:
                rows = conn.execute(
                    """
                    SELECT username, mode, track_id, time, total, updated_at
                    FROM scores
                    WHERE mode = ? AND track_id = ?
                    ORDER BY time ASC
                    LIMIT ?
                    """,
                    (mode, track_id, limit),
                ).fetchall()

            self._send_json(
                200,
                {
                    "mode": mode,
                    "trackId": track_id,
                    "entries": [row_to_entry(r) for r in rows],
                },
            )
            return

        if path in ("/", "/index.html"):
            self.path = "/KartBlitz.html"

        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/scores":
            self._send_json(404, {"error": "not found"})
            return

        data = self._read_json()
        username = normalize_username(data.get("username"))
        if not username:
            self._send_json(400, {"error": "invalid username"})
            return

        mode = str(data.get("mode") or "").strip().lower()
        if mode not in ALLOWED_MODES:
            self._send_json(400, {"error": "invalid mode"})
            return

        try:
            track_id = int(data.get("trackId"))
            time_s = float(data.get("time"))
        except (TypeError, ValueError):
            self._send_json(400, {"error": "invalid trackId or time"})
            return

        if time_s <= 0 or time_s > 3600:
            self._send_json(400, {"error": "impossible time"})
            return

        total = data.get("total")
        total_s = None
        if total is not None:
            try:
                total_s = float(total)
                if total_s <= 0 or total_s > 7200:
                    total_s = None
            except (TypeError, ValueError):
                total_s = None

        lap_distance = data.get("lapDistance")
        if lap_distance is not None:
            try:
                lap_d = float(lap_distance)
                if lap_d > 0 and time_s < lap_d / 640.0:
                    self._send_json(400, {"error": "impossible time"})
                    return
            except (TypeError, ValueError):
                pass

        username_key = username.lower()
        now_ms = int(time.time() * 1000)

        with get_db() as conn:
            existing = conn.execute(
                """
                SELECT username, mode, track_id, time, total, updated_at
                FROM scores
                WHERE username_key = ? AND mode = ? AND track_id = ?
                """,
                (username_key, mode, track_id),
            ).fetchone()

            if existing and float(existing["time"]) <= time_s:
                self._send_json(
                    200,
                    {
                        "accepted": False,
                        "improved": False,
                        "entry": row_to_entry(existing),
                        "message": "existing best is equal or faster",
                    },
                )
                return

            conn.execute(
                """
                INSERT INTO scores (username, username_key, mode, track_id, time, total, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(username_key, mode, track_id) DO UPDATE SET
                    username = excluded.username,
                    time = excluded.time,
                    total = excluded.total,
                    updated_at = excluded.updated_at
                WHERE excluded.time < scores.time
                """,
                (username, username_key, mode, track_id, time_s, total_s, now_ms),
            )

            row = conn.execute(
                """
                SELECT username, mode, track_id, time, total, updated_at
                FROM scores
                WHERE username_key = ? AND mode = ? AND track_id = ?
                """,
                (username_key, mode, track_id),
            ).fetchone()

        self._send_json(
            200,
            {
                "accepted": True,
                "improved": True,
                "entry": row_to_entry(row) if row else None,
            },
        )


def main() -> None:
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"KartBlitz leaderboard serving on http://localhost:{PORT}")
    print(f"  Game:   http://localhost:{PORT}/KartBlitz.html")
    print(f"  Health: http://localhost:{PORT}/api/health")
    print(f"  DB:     {DB_PATH}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
