from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class TrackRules:
    track_id: int
    checkpoint_count: int
    total_length: float
    minimum_lap_seconds: float
    maximum_lap_seconds: float = 3600.0


@dataclass(frozen=True, slots=True)
class ValidatedResult:
    client_result_id: str
    player_id: str
    player_name: str
    mode: str
    track_id: int
    track_name: str
    best_lap_seconds: float
    total_seconds: float | None
    laps: int
    details: dict[str, Any]
