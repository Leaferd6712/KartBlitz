"""HTTP client for KartBlitz ml-env-server."""
from __future__ import annotations

import requests

DEFAULT_URL = "http://127.0.0.1:8765/"


class SimClient:
    def __init__(self, base_url: str = DEFAULT_URL, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout = timeout

    def _post(self, body: dict) -> dict:
        r = requests.post(self.base_url, json=body, timeout=self.timeout)
        r.raise_for_status()
        out = r.json()
        if not out.get("ok", True) and "error" in out:
            raise RuntimeError(out["error"])
        return out

    def ping(self) -> dict:
        return self._post({"cmd": "ping"})

    def reset(self, track_id: int = 0, seconds: float = 18.0) -> dict:
        return self._post({"cmd": "reset", "trackId": track_id, "seconds": seconds})

    def step(self, action: int) -> dict:
        return self._post({"cmd": "step", "action": int(action)})

    def observe(self) -> dict:
        return self._post({"cmd": "observe"})
