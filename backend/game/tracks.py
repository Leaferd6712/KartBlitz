from __future__ import annotations

import json
from pathlib import Path

from .state import TrackRules


TRIAL_MAX_MEAN_SPEED = 640.0


class TrackRegistry:
    """Reads rule metadata from the same canonical bake used by the online sim."""

    def __init__(self, bakes_path: Path):
        self.bakes_path = Path(bakes_path)
        payload = json.loads(self.bakes_path.read_text(encoding="utf-8"))
        raw_tracks = payload.get("tracks")
        if not isinstance(raw_tracks, dict) or not raw_tracks:
            raise ValueError(f"No tracks found in {self.bakes_path}")

        self.bake_version = int(payload.get("version", 0))
        self._rules: dict[int, TrackRules] = {}
        for raw in raw_tracks.values():
            track_id = int(raw["id"])
            checkpoint_count = len(raw.get("cpLines") or [])
            total_length = float(raw.get("totalLen") or 0)
            if checkpoint_count < 2 or total_length <= 0:
                raise ValueError(f"Track {track_id} has incomplete bake metadata")
            self._rules[track_id] = TrackRules(
                track_id=track_id,
                checkpoint_count=checkpoint_count,
                total_length=total_length,
                minimum_lap_seconds=max(8.0, total_length / TRIAL_MAX_MEAN_SPEED),
            )

    def get(self, track_id: int) -> TrackRules:
        try:
            return self._rules[int(track_id)]
        except (KeyError, ValueError) as exc:
            raise KeyError(f"Unknown track: {track_id}") from exc

    def __len__(self) -> int:
        return len(self._rules)

