from __future__ import annotations

import json
import math
from typing import Any

from .state import ValidatedResult
from .tracks import TrackRegistry


SUPPORTED_MODES = frozenset({"trial", "ai", "versus", "shootout", "online"})


class ResultValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ResultValidator:
    """Validates completed results without participating in live simulation."""

    def __init__(self, tracks: TrackRegistry):
        self.tracks = tracks

    def validate(
        self,
        *,
        client_result_id: str,
        player_id: str,
        player_name: str,
        mode: str,
        track_id: int,
        track_name: str,
        best_lap_seconds: float,
        total_seconds: float | None,
        laps: int,
        details: dict[str, Any] | None = None,
    ) -> ValidatedResult:
        if mode not in SUPPORTED_MODES:
            raise ResultValidationError("invalid_mode", f"Unsupported mode: {mode}")
        try:
            rules = self.tracks.get(track_id)
        except KeyError as exc:
            raise ResultValidationError("unknown_track", str(exc)) from exc
        if not math.isfinite(best_lap_seconds) or best_lap_seconds <= 0:
            raise ResultValidationError("invalid_lap", "Best lap must be finite and positive")
        if best_lap_seconds < rules.minimum_lap_seconds:
            raise ResultValidationError("implausible_lap", "Best lap is faster than the track limit")
        if best_lap_seconds > rules.maximum_lap_seconds:
            raise ResultValidationError("lap_too_long", "Best lap exceeds the accepted limit")
        if laps < 1 or laps > 999:
            raise ResultValidationError("invalid_lap_count", "Lap count must be between 1 and 999")
        if total_seconds is not None:
            if not math.isfinite(total_seconds) or total_seconds <= 0:
                raise ResultValidationError("invalid_total", "Total time must be finite and positive")
            if total_seconds + 0.25 < best_lap_seconds:
                raise ResultValidationError("invalid_total", "Total time cannot be below the best lap")
            if total_seconds > 24 * 60 * 60:
                raise ResultValidationError("invalid_total", "Total time exceeds 24 hours")

        safe_details = dict(details or {})
        try:
            encoded_details = json.dumps(safe_details, separators=(",", ":"), allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ResultValidationError("invalid_details", "Result details must be JSON data") from exc
        if len(encoded_details.encode("utf-8")) > 4096:
            raise ResultValidationError("details_too_large", "Result details exceed 4 KiB")

        return ValidatedResult(
            client_result_id=client_result_id,
            player_id=player_id,
            player_name=player_name or f"PLAYER-{player_id[-6:].upper()}",
            mode=mode,
            track_id=track_id,
            track_name=track_name or f"Track {track_id}",
            best_lap_seconds=round(best_lap_seconds, 3),
            total_seconds=round(total_seconds, 3) if total_seconds is not None else None,
            laps=laps,
            details=safe_details,
        )
