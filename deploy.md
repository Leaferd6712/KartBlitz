# Deploying KartBlitz

KartBlitz is a browser racer. The game files can live on **Netlify**. Online multiplayer uses a **Cloudflare Worker**. An optional **shared leaderboard** can run on your laptop via Python + Cloudflare Tunnel.

## Required game files (Netlify)

| File | Role |
|------|------|
| `KartBlitz.html` | The game |
| `online.js` | Online Host/Join client |
| `rb6.glb` | Menu/garage 3D cover car |

Upload all three into the **same folder** on Netlify (rename HTML to `index.html` if your site expects that).

---

## A. Netlify (static game)

1. Close old terminals you do not need.
2. Upload/replace `KartBlitz.html`, `online.js`, `rb6.glb`.
3. Open your Netlify URL over `https://`.
4. Online Lobby needs **no server IP** — the Worker host is baked into `online.js` as `kartblitz-online.kartblitz.workers.dev`.

---

## B. Online multiplayer (Cloudflare Worker)

Runs in Cloudflare’s cloud. **Laptop can be off** after deploy.

### Deploy / redeploy

```bash
cd path\to\KartBlitz
npm install --legacy-peer-deps
npx wrangler login
npx wrangler deploy
```

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

## C. Shared leaderboard (optional laptop stack)

This is **separate** from online racing. Use it when you want a SQLite board on your machine exposed to the internet.

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
- Or keep the game on Netlify and point the game’s `LB_API_BASE` (if configured in HTML) at the tunnel origin with **no** trailing slash.

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
| Shared leaderboard | `python server/app.py` + `cloudflared tunnel --url http://localhost:8787` | Yes, both |
| Netlify game + Worker online + no LB | Netlify upload + Worker already deployed | No laptop needed |

**Port 8787:** used by both `python app.py` and `wrangler dev`. Never both at once.

---

## Checklist

- [ ] Netlify has `KartBlitz.html`, `online.js`, `rb6.glb`
- [ ] Worker deployed (`npx wrangler deploy`) → `kartblitz-online.kartblitz.workers.dev`
- [ ] Online Lobby: Host Game / Join Game works (no SERVER field)
- [ ] Optional: `python app.py` + tunnel only if you want the laptop shared leaderboard
- [ ] Old PartyKit / stale tunnel terminals closed when unused
