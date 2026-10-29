from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ResultCreateRequest(BaseModel):
    client_result_id: str = Field(alias="clientResultId", min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    player_id: str = Field(alias="playerId", min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    player_name: str = Field(default="", alias="playerName", max_length=16, pattern=r"^[A-Za-z0-9_-]*$")
    mode: Literal["trial", "ai", "versus", "shootout", "online"]
    track_id: int = Field(alias="trackId", ge=0, le=9999)
    track_name: str = Field(default="", alias="trackName", max_length=64)
    best_lap_seconds: float = Field(alias="bestLapSeconds", gt=0, le=3600)
    total_seconds: float | None = Field(default=None, alias="totalSeconds", gt=0, le=86400)
    laps: int = Field(ge=1, le=999)
    details: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}

