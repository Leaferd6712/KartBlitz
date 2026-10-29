# KartBlitz FastAPI backend

This optional backend stores completed race results, player profiles, race
history, and testing leaderboards. It does **not** run movement, physics,
collision, input, rendering, camera logic, prediction, or interpolation. Those
performance-sensitive systems remain in JavaScript.

## Local development

From the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-dev.txt
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --port 8001
```

Serve the static frontend separately:

```powershell
python -m http.server 8000
```

Open:

```text
http://127.0.0.1:8000/index.html?backend=http://127.0.0.1:8001
```

The frontend performs no Python request during active gameplay. When results
are shown, it submits one idempotent result. Profile and leaderboard reads are
available for non-gameplay screens.

Useful endpoints:

- `GET /api/health`
- `POST /api/v1/results`
- `GET /api/v1/profiles/{player_id}`
- `GET /api/v1/leaderboard?mode=trial&trackId=0`
- Interactive schema: `GET /docs`

Run tests with:

```powershell
.\.venv\Scripts\python.exe -m pytest tests\python -q
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `KARTBLITZ_DATABASE_PATH` | `backend/kartblitz.db` | SQLite database path. Use persistent storage in deployment. |
| `KARTBLITZ_TRACK_BAKES_PATH` | `sim/tracks/bakes.json` | Canonical track metadata used for plausibility limits. |
| `KARTBLITZ_CORS_ORIGINS` | Local ports `8000` and `4173` | Comma-separated approved frontend origins. Do not use `*` in a public deployment. |

No credentials are required by this testing service. Player identity uses the
existing browser device token and is not account-grade authentication.

## Deployment boundary

GitHub Pages and Netlify static hosting cannot execute Python. Deploy FastAPI to
a separate Python-capable testing service with persistent storage, set
`KARTBLITZ_CORS_ORIGINS` to the exact testing frontend origin, and configure the
frontend with `?backend=https://testing-api.example`. Keep the production
frontend unconfigured until a separately reviewed production migration is
authorised.

The production Cloudflare Worker remains authoritative for multiplayer and its
verified time-trial input replay. The FastAPI plausibility checks protect data
shape and obvious impossible times; they are not a replacement for replay-based
anti-cheat validation.

