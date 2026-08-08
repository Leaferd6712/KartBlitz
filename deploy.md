# KartBlitz — laptop leaderboard backend

Your game is already on **Netlify**. This guide is only how to run the **score API on your laptop** so the shared leaderboard works.

Players use the Netlify URL. Scores only sync while this laptop API + tunnel are running.

## What you need

- Python 3 on PATH (`python --version` works in Command Prompt)
- `cloudflared` (you already have it at something like `C:\Users\663208\Downloads\Applications\cloudflared-windows-amd64.exe`)
- This project folder, especially `server/app.py`
- In `KartBlitz.html` on Netlify, `LB_API_BASE` must match your **current** tunnel URL (no trailing slash)

Example:

```js
const LB_API_BASE = 'https://casinos-theaters-agencies-boards.trycloudflare.com';
```

If the tunnel URL changes, update that line and **redeploy Netlify**.

## Every time you want the leaderboard online

### 1. Start the API

Open Command Prompt:

```bat
cd C:\Users\663208\Downloads\KartBlitz\server
python app.py
```

Leave this window open. You should see something like:

```text
KartBlitz leaderboard serving on http://localhost:8787
```

Quick check in a browser: http://localhost:8787/api/health  
Should show: `{"ok": true, ...}`

### 2. Start the Cloudflare tunnel

Open a **second** Command Prompt (do not close the first):

```bat
"C:\Users\663208\Downloads\Applications\cloudflared-windows-amd64.exe" tunnel --url http://localhost:8787
```

Wait for the box that says **Your quick Tunnel has been created!** and copy the URL, for example:

```text
https://something-random.trycloudflare.com
```

Leave this window open too.

### 3. Match Netlify to the tunnel URL

1. Open `KartBlitz.html` (the copy you deploy to Netlify).
2. Set:

```js
const LB_API_BASE = 'https://YOUR-CURRENT-TUNNEL-URL';
```

3. Redeploy that file to Netlify (keep `rb6.glb` in the same Netlify folder).

Skip this step only if `LB_API_BASE` already equals today’s tunnel URL.

### 4. Play / share

- Share your **Netlify** site URL.
- On the Leaderboard screen it should say **ONLINE · SHARED LEADERBOARD**.
- If it says **OFFLINE**, the API or tunnel is down, or `LB_API_BASE` is wrong.

## Keep both windows open

| Window | Role |
|--------|------|
| `python app.py` | Stores scores in `server/scores.db` |
| `cloudflared ...` | Lets the internet reach your laptop |

Also:

- Keep the laptop **plugged in and awake** (sleep kills the board).
- Closing either window = shared leaderboard goes offline (game on Netlify still loads).

## Optional: start script

You can run `server/start-leaderboard.bat` to open the API. The tunnel still needs `cloudflared` on PATH, or start it manually with the full `.exe` path as above.

## Useful checks

| Check | URL |
|-------|-----|
| Local API | http://localhost:8787/api/health |
| Public API (via tunnel) | `https://YOUR-TUNNEL-URL/api/health` |

Both should return `{"ok": true, ...}`.

## Stopping

Press `Ctrl+C` in each Command Prompt window, or just close them.
