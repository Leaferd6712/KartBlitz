# Developing KartBlitz

The player entry point is `index.html`. Keep the browser game usable without the desktop wrapper or an online service.

## Run locally

Serve the repository with `python -m http.server 8000`, then open `http://localhost:8000/`. Modules and asset requests need an HTTP origin. The checked-in preview bundle and fonts support a fresh checkout without a JavaScript build step.

For development tools, use Node.js 24:

```sh
npm ci --legacy-peer-deps
npm run assets:build
```

`assets:build` bundles `ui/car-preview.js` and Three.js and copies Nunito fonts and licences. Regenerate the bundle after editing preview source. No renderer or font CDN is used at runtime. The optional CrazyGames SDK only loads on that portal.

## Where things live

- `index.html`: current race engine, canvas renderer, screens and track editor.
- `ui/`: shared visual tokens, slate controls, local assets and presentation helpers. `experience.css` covers first-play and responsive refinements; `player-experience.js` handles welcome, confirmations and the driving guide.
- `core/`: activity lifecycle, racing adapter and application metadata. See [activities.md](activities.md).
- `sim/`: shared physics, save/reward systems and exported track geometry.
- `online.js`, `online-sim.js`, `online-codec.js`: online client, prediction and transport.
- `party/`, `d1/`: Cloudflare authoritative races and cloud persistence.
- `desktop/`: isolated Electron host. Its generated `game/` folder uses the same runtime as the website.
- `e2e/`: browser journeys; `sim/__tests__/`: physics and state checks.
- `ml/`, `ml_training/`: optional learning lab and Python trainer.

## Check changes

```sh
npm run test:activities
npm run test:unit
npm run test:sim
npx playwright install chromium
npm run test:browser
npm run build:web
npm run test:runtime
```

Browser tests use a local static server and stub cloud services, so they do not submit real leaderboard records. Check real online multiplayer separately with `npm run party:dev` and `npm run test:live`. After physics or track changes, also regenerate `npm run tracks:export` and `npm run sim:browser` before comparing the client and Worker.

Use `node scripts/capture-screenshots.mjs` to refresh README captures from real play (Playwright Chromium and Python Pillow required for documentation capture only). The script blocks API requests, captures the UI, and converts its own PNG captures to WebP; it does not fabricate lap results.

Before a UI pull request, inspect a desktop screen, a portrait phone, and a short landscape viewport. Check keyboard focus, maximum UI scale, reduced motion, mute, and both touch and keyboard controls. See [improvements.md](improvements.md) for this pass's player-facing scope.

## Player controls

Player 1: W/S throttle/brake, A/D steer, X Boost, C Zone, P Pit. Player 2: arrow keys, `.` Boost, `,` Zone, `/` Pit. Key bindings and hold/toggle behaviour are configurable in Controls & Settings. Touch uses steering buttons and separate GO / BRAKE pedals in single-player landscape, with the existing face-to-face controls for Versus.

Boost is the underlying ERS system. Zone is the underlying DRS system and can only activate in eligible blue zones. The detailed help retains these technical names for interested players.

## Optional ML Lab

Open Controls & Settings → Settings → Advanced tools to enable ML Lab. Training runs in the loopback-only Python companion:

```powershell
.\ml_training\install.ps1
.\ml_training\start.ps1
```

Follow [the trainer guide](../ml_training/README.md) for pairing and model validation. The bundled reference driver is hand tuned; it is not presented as a trained policy.
