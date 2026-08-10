# Shared leaderboard (laptop)

```bash
cd server
python app.py
```

Then (separate terminal):

```bash
cloudflared tunnel --url http://localhost:8787
```

Or run `start-leaderboard.bat`.

See root [`deploy.md`](../deploy.md) section **C** for full details.
