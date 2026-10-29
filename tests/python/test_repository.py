from backend.game.state import ValidatedResult
from backend.services.result_repository import ResultRepository


def result(client_result_id: str, best_lap: float) -> ValidatedResult:
    return ValidatedResult(
        client_result_id=client_result_id,
        player_id="player-123",
        player_name="RACER",
        mode="trial",
        track_id=2,
        track_name="Track 2",
        best_lap_seconds=best_lap,
        total_seconds=None,
        laps=2,
        details={"cleanRace": True},
    )


def test_repository_stores_history_and_only_better_personal_best(tmp_path) -> None:
    repository = ResultRepository(tmp_path / "scores.db")

    first = repository.save_result(result("result-001", 30.5))
    slower = repository.save_result(result("result-002", 31.0))
    faster = repository.save_result(result("result-003", 29.75))

    assert first["leaderboardSaved"] is True
    assert slower["leaderboardSaved"] is False
    assert faster["leaderboardSaved"] is True
    assert repository.leaderboard(mode="trial", track_id=2)[0]["bestLap"] == 29.75
    profile = repository.profile("player-123")
    assert profile is not None
    assert profile["raceCount"] == 3
    assert len(profile["history"]) == 3


def test_repository_is_idempotent_by_client_result_id(tmp_path) -> None:
    repository = ResultRepository(tmp_path / "scores.db")
    repository.save_result(result("result-001", 30.5))

    duplicate = repository.save_result(result("result-001", 30.5))

    assert duplicate["idempotent"] is True
    assert repository.profile("player-123")["raceCount"] == 1

