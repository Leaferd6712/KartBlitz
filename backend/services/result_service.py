from __future__ import annotations

from typing import Any

from backend.game.engine import ResultValidator

from .result_repository import ResultRepository


class ResultService:
    def __init__(self, validator: ResultValidator, repository: ResultRepository):
        self.validator = validator
        self.repository = repository

    def submit(self, **payload: Any) -> dict:
        result = self.validator.validate(**payload)
        return self.repository.save_result(result)

