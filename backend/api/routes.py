from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status

from backend.game.engine import ResultValidationError
from backend.services.result_service import ResultService

from .models import ResultCreateRequest


router = APIRouter()


def service(request: Request) -> ResultService:
    return request.app.state.results


@router.get("/health")
async def health(request: Request) -> dict:
    results = service(request)
    return {
        "ok": True,
        "service": "kartblitz-python",
        "trackCount": len(results.validator.tracks),
        "trackBakeVersion": results.validator.tracks.bake_version,
    }


@router.post("/v1/results", status_code=status.HTTP_201_CREATED)
async def create_result(payload: ResultCreateRequest, request: Request) -> dict:
    try:
        saved = service(request).submit(
            client_result_id=payload.client_result_id,
            player_id=payload.player_id,
            player_name=payload.player_name,
            mode=payload.mode,
            track_id=payload.track_id,
            track_name=payload.track_name,
            best_lap_seconds=payload.best_lap_seconds,
            total_seconds=payload.total_seconds,
            laps=payload.laps,
            details=payload.details,
        )
    except ResultValidationError as exc:
        raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)}) from exc
    return {"accepted": True, **saved}


@router.get("/v1/leaderboard")
async def leaderboard(
    request: Request,
    track_id: int = Query(alias="trackId", ge=0, le=9999),
    mode: Literal["trial", "ai", "versus", "shootout", "online"] = Query(default="trial"),
    limit: int = Query(default=50, ge=1, le=100),
) -> dict:
    scores = service(request).repository.leaderboard(mode=mode, track_id=track_id, limit=limit)
    return {"scores": scores}


@router.get("/v1/profiles/{player_id}")
async def profile(player_id: str, request: Request, history_limit: int = Query(default=20, alias="historyLimit", ge=1, le=100)) -> dict:
    data = service(request).repository.profile(player_id, history_limit)
    if data is None:
        raise HTTPException(status_code=404, detail={"code": "profile_not_found"})
    return data

