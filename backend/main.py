from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes import router
from backend.config import Settings
from backend.game.engine import ResultValidator
from backend.game.tracks import TrackRegistry
from backend.services.result_repository import ResultRepository
from backend.services.result_service import ResultService


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_environment()
    tracks = TrackRegistry(settings.track_bakes_path)
    repository = ResultRepository(settings.database_path)
    results = ResultService(ResultValidator(tracks), repository)

    app = FastAPI(
        title="KartBlitz Python Backend",
        version="1.0.0",
        description="Completed race results, profiles, history, and leaderboard service.",
    )
    app.state.settings = settings
    app.state.results = results
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Content-Type"],
        )
    app.include_router(router, prefix="/api")
    return app


app = create_app()
