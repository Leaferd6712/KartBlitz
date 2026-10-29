from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime settings loaded without a framework-specific settings package."""

    database_path: Path
    track_bakes_path: Path
    cors_origins: tuple[str, ...]

    @classmethod
    def from_environment(cls) -> "Settings":
        database_path = Path(
            os.getenv("KARTBLITZ_DATABASE_PATH", str(PROJECT_ROOT / "backend" / "kartblitz.db"))
        ).expanduser()
        track_bakes_path = Path(
            os.getenv(
                "KARTBLITZ_TRACK_BAKES_PATH",
                str(PROJECT_ROOT / "sim" / "tracks" / "bakes.json"),
            )
        ).expanduser()
        origins_raw = os.getenv(
            "KARTBLITZ_CORS_ORIGINS",
            "http://localhost:8000,http://127.0.0.1:8000,"
            "http://localhost:4173,http://127.0.0.1:4173",
        )
        origins = tuple(origin.strip() for origin in origins_raw.split(",") if origin.strip())
        return cls(
            database_path=database_path,
            track_bakes_path=track_bakes_path,
            cors_origins=origins,
        )
