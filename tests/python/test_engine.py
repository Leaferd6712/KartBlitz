import pytest

from backend.game.engine import ResultValidationError, ResultValidator
from backend.game.state import TrackRules


class Tracks:
    def get(self, track_id: int) -> TrackRules:
        if track_id != 0:
            raise KeyError(track_id)
        return TrackRules(
            track_id=0,
            checkpoint_count=6,
            total_length=6400,
            minimum_lap_seconds=10,
        )


def payload(**overrides):
    values = {
        "client_result_id": "result-123",
        "player_id": "player-123",
        "player_name": "RACER",
        "mode": "trial",
        "track_id": 0,
        "track_name": "Test Track",
        "best_lap_seconds": 12.3456,
        "total_seconds": None,
        "laps": 2,
        "details": {"cleanRace": True},
    }
    values.update(overrides)
    return values


def test_validates_and_normalises_completed_result() -> None:
    result = ResultValidator(Tracks()).validate(**payload())

    assert result.best_lap_seconds == 12.346
    assert result.laps == 2
    assert result.details == {"cleanRace": True}


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"best_lap_seconds": 9.99}, "implausible_lap"),
        ({"best_lap_seconds": float("inf")}, "invalid_lap"),
        ({"laps": 0}, "invalid_lap_count"),
        ({"total_seconds": 5}, "invalid_total"),
        ({"track_id": 99}, "unknown_track"),
        ({"details": {"value": float("nan")}}, "invalid_details"),
        ({"details": {"value": "x" * 5000}}, "details_too_large"),
    ],
)
def test_rejects_invalid_results(overrides, code) -> None:
    with pytest.raises(ResultValidationError) as error:
        ResultValidator(Tracks()).validate(**payload(**overrides))
    assert error.value.code == code


def test_does_not_contain_live_physics_operations() -> None:
    validator_methods = set(dir(ResultValidator))
    assert not validator_methods.intersection({"step", "move", "steer", "collide", "render"})
