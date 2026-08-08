# KartBlitz shared leaderboard (school laptop)

Run this on your school laptop so anyone on the internet can submit lap times to one shared board.

**Requires Python 3 only** (no `pip install` needed). Node is not required for the API.

## Setup (once)

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (Cloudflare Tunnel) and make sure `cloudflared` is on your PATH.

## Start every session

**Option A — double-click** `start-leaderboard.bat`  
It opens the Python API and a Cloudflare quick tunnel.

**Option B — two terminals**

```bash
cd server
python app.py
```

```bash
cloudflared tunnel --url http://localhost:8787
```

Cloudflare prints a public URL like `https://random-words.trycloudflare.com`.

Share: `https://YOUR-TUNNEL-URL/KartBlitz.html`

## Keep the laptop awake

- Plug in power
- Disable sleep / screen sleep while hosting
- Leave both Command Prompt windows open
- Quick-tunnel URLs change every restart unless you create a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/)

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/health` | `{ "ok": true }` |
| GET | `/api/leaderboard?mode=trial&trackId=0` | Top scores |
| POST | `/api/scores` | Body: `{ "username", "mode", "trackId", "time", "total?", "lapDistance?" }` |

Scores are stored in `server/scores.db` (SQLite). Best time per username + mode + track wins.

## Hosting the HTML elsewhere

If the game is on GitHub Pages / itch and only the API runs on the laptop, set in `KartBlitz.html`:

```js
const LB_API_BASE = 'https://YOUR-TUNNEL-URL';
```

Same-origin (serving the game from this Python server) can leave `LB_API_BASE = ''`.
