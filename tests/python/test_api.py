from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


def make_bakes(path: Path) -> Path:
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "tracks": {
                    "0": {"id": 0, "totalLen": 6400, "cpLines": [{}, {}, {}]}
                },
            }
        ),
        encoding="utf-8",
    )
    return path


def make_client(tmp_path: Path) -> TestClient:
    settings = Settings(
        database_path=tmp_path / "kartblitz.db",
        track_bakes_path=make_bakes(tmp_path / "bakes.json"),
        cors_origins=("http://localhost:8000",),
    )
    return TestClient(create_app(settings))


def valid_result() -> dict:
    return {
        "clientResultId": "result-123",
        "playerId": "player-123",
        "playerName": "RACER",
        "mode": "trial",
        "trackId": 0,
        "trackName": "Test Track",
        "bestLapSeconds": 10.5,
        "laps": 2,
        "details": {"cleanRace": True},
    }


def test_health_result_profile_and_leaderboard_flow(tmp_path) -> None:
    client = make_client(tmp_path)
    assert client.get("/api/health").json()["trackCount"] == 1

    saved = client.post("/api/v1/results", json=valid_result())
    assert saved.status_code == 201
    assert saved.json()["accepted"] is True
    assert saved.json()["leaderboardSaved"] is True

    profile = client.get("/api/v1/profiles/player-123")
    assert profile.status_code == 200
    assert profile.json()["raceCount"] == 1
    assert profile.json()["history"][0]["details"] == {"cleanRace": True}

    board = client.get("/api/v1/leaderboard", params={"mode": "trial", "trackId": 0})
    assert board.status_code == 200
    assert board.json()["scores"][0]["playerName"] == "RACER"


def test_rejects_implausible_result_without_writing_profile(tmp_path) -> None:
    client = make_client(tmp_path)
    body = valid_result()
    body["bestLapSeconds"] = 1
    response = client.post("/api/v1/results", json=body)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "implausible_lap"
    assert client.get("/api/v1/profiles/player-123").status_code == 404


def test_cors_is_limited_to_configured_origins(tmp_path) -> None:
    client = make_client(tmp_path)
    allowed = client.options(
        "/api/health",
        headers={"Origin": "http://localhost:8000", "Access-Control-Request-Method": "GET"},
    )
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:8000"
    denied = client.get("/api/health", headers={"Origin": "https://example.invalid"})
    assert "access-control-allow-origin" not in denied.headers
