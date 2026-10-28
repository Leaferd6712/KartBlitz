# Python migration architecture

## Current application

KartBlitz is a static browser game deployed from `index.html`. The testing branch
has already extracted the former inline CSS and JavaScript into `ui/` and `js/`.
The main classic runtime remains in `js/game.js`; it owns canvas rendering,
keyboard/touch input, audio, menus, local race modes, local persistence, and the
animation loop.

Online races already use a server-authoritative Cloudflare Durable Object. The
Worker in `party/` runs the shared TypeScript simulation from `sim/` at 60 Hz and
broadcasts snapshots at 30 Hz. The browser predicts and interpolates those
snapshots. D1 stores the production leaderboard, registered devices, verified
time-trial runs, and ghost data. Replacing this real-time path would change the
production hosting model and risk existing multiplayer, so it remains in place.

The repository also contains two narrower Python applications:

- `server/app.py` is a legacy standard-library SQLite leaderboard and static
  server.
- `ml_training/` is an optional loopback-only PyTorch training companion.

Production frontend deployment is static (GitHub Pages/Netlify), so it cannot
run FastAPI. A Python-enabled testing deployment needs a separate backend URL.

## Responsibility split

| Concern | Owner | Reason |
| --- | --- | --- |
| HTML layout, menus, canvas, audio, responsive UI | Browser | DOM and graphics are browser-native. |
| Keyboard, pointer, and touch input | Browser | Input needs immediate feedback and cannot wait for a network round trip. |
| Local animation and client prediction | Browser | `requestAnimationFrame` keeps motion smooth between server updates. |
| Existing online race simulation | Cloudflare Worker | It is already authoritative, deployed, and covered by parity/reconnect tests. |
| Python testing sessions and lap/checkpoint rules | FastAPI | This makes the rule flow readable, structured, and independently testable. |
| Python testing leaderboard and score acceptance | FastAPI + SQLite | Scores can be validated against a server-owned session before persistence. |
| Production leaderboard and verified input replay | Cloudflare Worker + D1 | Retained to avoid weakening or duplicating the live production authority. |
| Player preferences and cached progress | Browser/CrazyGames save | Existing saves must remain compatible. |

## Python-enabled testing flow

The FastAPI service is opt-in. With no backend URL configured, production makes
no Python requests and behaves exactly as before. A testing URL can be supplied
through the `backend` query parameter or `KARTBLITZ_BACKEND_URL` global.

1. The browser creates a time-trial session through REST.
2. Checkpoint crossings are sent asynchronously; rendering and input never wait.
3. The Python engine checks the exact checkpoint sequence, session expiry, lap
   bounds derived from the canonical track bake, and monotonically increasing
   actions.
4. A finish action can only produce an accepted lap after all checkpoints have
   been observed in order.
5. The session manager stores reconnect-safe state and SQLite stores accepted
   personal-best scores.
6. The browser can fetch the Python testing leaderboard through the same client
   module. Backend errors degrade to the existing browser/Worker behaviour.

This session protocol is intentionally REST rather than WebSocket: checkpoint
events are infrequent, are not used to animate the kart, and do not justify a
second continuous real-time channel. Existing multiplayer continues to use its
WebSocket connection.

## Migration plan

1. Preserve the existing root static layout because deployment workflows and
   asset paths depend on it; finish the frontend split with a focused Python API
   client module rather than moving files into a new `frontend/` directory.
2. Add `backend/` with a FastAPI application, Pydantic contracts, deterministic
   session engine, SQLite repository, configurable CORS, and health/readiness
   endpoints.
3. Keep FastAPI routing separate from game rules and persistence.
4. Integrate time-trial lifecycle/checkpoint events without putting requests in
   the render loop or blocking local gameplay.
5. Add pytest coverage for rules, validation, persistence, session expiry, and
   API integration, plus browser tests for configuration and failure handling.
6. Document local development and a separate testing deployment. Production
   workflows remain restricted to `main` and are not changed or deployed.

## Explicit non-goals

- No Python rendering or per-frame browser round trips.
- No replacement of the production Cloudflare multiplayer service.
- No schema or save-format break.
- No automatic production deployment.
- No wholesale rewrite of the classic game runtime.
