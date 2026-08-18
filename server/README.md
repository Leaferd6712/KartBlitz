# Legacy local leaderboard (laptop)

The main leaderboard path is now the Cloudflare Worker + D1 backend. This Python server is only for legacy/local-only use when you explicitly want the old laptop-hosted SQLite leaderboard.

```bash
cd server
python app.py
```

Then (separate terminal):

```bash
cloudflared tunnel --url http://localhost:8787
```

Or run `start-leaderboard.bat`.

See root [`deploy.md`](../deploy.md) section **C** for legacy local usage and section **B** for the cloud leaderboard setup.
