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
| Completed-result validation | FastAPI | Plausibility and data-shape checks run after gameplay has ended. |
| Profiles, race history, and testing leaderboard | FastAPI + SQLite | These are persistent, non-frame-critical backend concerns. |
| Production leaderboard and verified input replay | Cloudflare Worker + D1 | Retained to avoid weakening or duplicating the live production authority. |
| Player preferences and cached progress | Browser/CrazyGames save | Existing saves must remain compatible. |

## Performance boundary

Performance is the first architectural priority. Movement, acceleration,
steering, braking, physics, collision response, input, canvas/WebGL rendering,
camera updates, animation frames, client prediction, and interpolation remain in
JavaScript. Python is never called by the render loop, simulation step, input
handlers, or checkpoint logic. The browser never waits for FastAPI before
updating or drawing a frame.

The target is a stable 60 FPS or better on supported hardware, treated as a
measured target rather than a guarantee. Repeatable Playwright telemetry records
average FPS, 5th-percentile FPS, 95th/99th-percentile frame time, long frames,
JavaScript task time, network requests during active gameplay, and memory where
Chromium exposes it. Shared-simulation parity tests continue to protect physics
consistency.

## Python-enabled testing flow

The FastAPI service is opt-in. With no backend URL configured, production makes
no Python requests and behaves exactly as before. A testing URL can be supplied
through the `backend` query parameter or `KARTBLITZ_BACKEND_URL` global.

1. The JavaScript engine completes a race or the player ends a time-trial
   session without involving Python.
2. After gameplay has ended, the browser submits one compact result through
   REST. No Python request is made for frames, inputs, physics, or checkpoints.
3. Python validates the mode, canonical track, lap bounds, totals, and payload.
4. SQLite appends an idempotent race-history record, updates the device profile,
   and replaces the personal best only when the accepted lap is faster.
5. Profile and leaderboard reads use REST outside active gameplay. Backend
   failures do not stop local play or rendering.

WebSockets are not added to the Python service. Existing multiplayer continues
to use its established Cloudflare WebSocket authority and shared JavaScript
simulation.

## Migration plan

1. Preserve the existing root static layout because deployment workflows and
   asset paths depend on it; finish the frontend split with a focused Python API
   client module rather than moving files into a new `frontend/` directory.
2. Add `backend/` with a FastAPI application, Pydantic contracts, deterministic
   completed-result validator, SQLite repository, configurable CORS, and a
   health endpoint.
3. Keep FastAPI routing separate from game rules and persistence.
4. Submit a single result after gameplay ends; never call Python from the input,
   simulation, collision, checkpoint, camera, or rendering paths.
5. Add pytest coverage for validation, idempotency, profiles, history,
   persistence, and API integration, plus browser performance/network tests.
6. Document local development and a separate testing deployment. Production
   workflows remain restricted to `main` and are not changed or deployed.

## Explicit non-goals

- No Python rendering or per-frame browser round trips.
- No Python movement, steering, braking, physics, collision, or prediction.
- No replacement of the production Cloudflare multiplayer service.
- No schema or save-format break.
- No automatic production deployment.
- No wholesale rewrite of the classic game runtime.
