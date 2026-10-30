# Deploying KartBlitz

KartBlitz's primary browser build lives at [GitHub Pages](https://leaferd6712.github.io/KartBlitz/). Online multiplayer and cloud leaderboards use a Cloudflare Worker. Desktop packaging is separate; see [Windows builds](docs/desktop.md).

## Online architecture (for sharing)

Open [docs/online-mode.html](docs/online-mode.html) in a browser. That is the full host / guest / Worker diagram. Details: [docs/README.md](docs/README.md).

---

## Static game runtime

Run `npm ci --legacy-peer-deps`, then `npm run build:web` and `npm run test:runtime`. Deploy the complete generated `public/` directory. The explicit asset list in `scripts/prepare-game.mjs` includes `index.html`, online client bundles, shared modules, local renderer/fonts and UI assets. No font or Three.js CDN is required. The original `rb6.glb` is included for the home-page and garage preview.

**Ship browser assets and the Worker together** after online changes. Mismatched `ONLINE_PROTOCOL` or `TRACK_BAKE_VERSION` causes a hard disconnect / bake error; read their current values from the shared source before deploying.

Online races are **server-authoritative**: the Cloudflare Durable Object runs the shared `sim/` at 60 Hz and broadcasts 30 Hz binary snapshots (including `lastProcessedInput` for client replay). Lobby “host” only controls settings / start — not simulation. Tracks are **canonical on the Worker** (`sim/tracks/bakes.json`); clients send `trackId` + protocol only.

---

## A. GitHub Pages (static game)

`.github/workflows/deploy.yml` builds and verifies `public/`, uploads it as the Pages artifact and deploys on pushes to `main` or manual dispatch. Assets use relative paths so they work under `/KartBlitz/`. The workflow does not publish the Windows executable or change the Worker.

For another static host, upload the same complete `public/` directory and serve `index.html` over HTTPS. After shared simulation changes, regenerate the browser simulator and deploy the Worker with `npm run deploy:online` (section B). Online Lobby's default Worker host remains `kartblitz-online.kartblitz.workers.dev`.

---

## B. Online multiplayer (Cloudflare Worker)

Runs in Cloudflare’s cloud. **Laptop can be off** after deploy.

### One-time D1 setup for cloud leaderboard

Create a D1 database and bind it to the Worker as `LEADERBOARD_DB`.

```bash
npx wrangler d1 create kartblitz-leaderboard
```

Then copy the returned `database_id` into `wrangler.jsonc` under:

```jsonc
"d1_databases": [
  {
    "binding": "LEADERBOARD_DB",
    "database_name": "kartblitz-leaderboard",
    "database_id": "PASTE_DATABASE_ID_HERE"
  }
]
```

Optional manual schema bootstrap:

```bash
npx wrangler d1 execute kartblitz-leaderboard --remote --file d1/leaderboard-schema.sql
```

The Worker also creates the tables lazily on first leaderboard request, so the SQL file is mainly for explicit setup / inspection.

Local Time Trial works as a guest. Players can register a username from the leaderboard when they want cloud records. Registered devices submit eligible completed laps through the existing run-verification flow.

### Admin station

Edit leaderboard data and open the track and patch-notes editors from one password-protected admin station:

1. Set the admin password (production — do **not** commit this):
   ```bash
   npx wrangler secret put LEADERBOARD_ADMIN_PASSWORD
   ```
2. Deploy the Worker: `npm run deploy:online`
3. Include `leaderboard-admin.html` alongside the game (the web build already does this)
4. Open `https://YOUR-SITE/leaderboard-admin.html` and log in

Local `wrangler dev` uses a password from `.dev.vars` (copy from `.dev.vars.example`). Production uses only `wrangler secret` — do **not** put the admin password in `wrangler.jsonc` `vars` or deploy will overwrite your remote secret.

The root [README tools directory](README.md#tools--feature-directory) links directly to this station and its editors; player menus do not expose them. Anyone with the password can use its editor tools and edit leaderboard rows, including real players.

Cloud scores are also snapshotted to [`backups/leaderboard.txt`](backups/leaderboard.txt) automatically every 6 hours (GitHub Action). Download a live dump from `/api/leaderboard-backup.txt`, or run `npm run backup:leaderboard` locally. For a full D1 restore file (includes device tokens, keep private): `npx wrangler d1 export kartblitz-leaderboard --remote --output backups/leaderboard-full.sql`.

### Deploy / redeploy

```bash
cd path\to\KartBlitz
npm install --legacy-peer-deps
npm run deploy:online
```

That runs `tracks:export` → `sim:browser` → `test:sim` → `wrangler deploy` (via `preparty:deploy`).

Do **not** use bare `npx wrangler deploy` after sim/track changes — it skips bake/export and can ship a Worker that disagrees with `online-sim.js`.

Confirm the URL is:

`https://kartblitz-online.kartblitz.workers.dev`

### Play

1. Custom Race → **Online Lobby**
2. **Host Game** — wait for friends; set track/laps; Ready → Start
3. **Join Game** — pick an open lobby from the list (no room code)

### Local Worker testing only

```bash
npm run party:dev
```

Opens `http://127.0.0.1:8787`. Serve the HTML from another static server and open the game on `localhost` so `online.js` targets the local Worker.

Do **not** run the Python leaderboard on `:8787` at the same time as `wrangler dev` (same port).

---

## C. Legacy local leaderboard (optional laptop stack)

The preferred leaderboard is now the **cloud leaderboard** served by the Worker + D1. The Python server below is legacy/local-only and only needed if you explicitly want the old laptop-hosted SQLite stack.

### Start the API

```bash
cd server
python app.py
```

Or double-click `server/start-leaderboard.bat`.

### Localhost checks

- Health: http://localhost:8787/api/health  
- Game via API static server: http://localhost:8787/KartBlitz.html  
- Leaderboard: http://localhost:8787/api/leaderboard?mode=trial&trackId=0  

### Cloudflare Tunnel (public URL)

With the API already running:

```bash
cloudflared tunnel --url http://localhost:8787
```

If `cloudflared` is not on PATH, use the full exe path, for example:

```bat
"C:\Users\%USERNAME%\Downloads\Applications\cloudflared-windows-amd64.exe" tunnel --url http://localhost:8787
```

Copy the printed URL, e.g. `https://random-words.trycloudflare.com`.

- Share: `https://YOUR-TUNNEL/KartBlitz.html`  
- Or keep the game on static hosting and point custom leaderboard code at the tunnel origin with **no** trailing slash.

**Leave open while people use the shared board:**

1. The `python app.py` window  
2. The `cloudflared tunnel` window  

Quick tunnels get a **new** URL each restart — share the new one.

---

## D. Localhost cheatsheet

| Goal | Commands | Leave open? |
|------|----------|-------------|
| Play local static game | `python -m http.server 8000` → `http://localhost:8000/KartBlitz.html` | Yes, that server |
| Test online multiplayer locally | `npm run party:dev` + static game on localhost | Yes, wrangler |
| Production online races | `npx wrangler deploy` once; play on Netlify | No |
| Legacy local leaderboard | `python server/app.py` + `cloudflared tunnel --url http://localhost:8787` | Yes, both |
| Production online + cloud leaderboard | Worker deployed with D1 bound + static site uploaded | No laptop needed |

**Port 8787:** used by both `python app.py` and `wrangler dev`. Never both at once.

---

## Checklist

- [ ] Netlify has `KartBlitz.html`, `online.js`, `online-codec.js`, `online-sim.js`, `rb6.glb`
- [ ] Worker deployed (`npx wrangler deploy`) → `kartblitz-online.kartblitz.workers.dev`
- [ ] Client + Worker share `ONLINE_PROTOCOL` (hard-refresh after deploy)
- [ ] Online Lobby: Host Game / Join Game works (no SERVER field)
- [ ] D1 database bound as `LEADERBOARD_DB` for the cloud leaderboard
- [ ] Optional: `python app.py` + tunnel only if you want the legacy laptop leaderboard
- [ ] Old PartyKit / stale tunnel terminals closed when unused
