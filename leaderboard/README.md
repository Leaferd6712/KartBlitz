# KartBlitz leaderboard seed files

These text files are optional "fake data" helpers for local development / testing.

## Recommended: `admin.html`

For live editing with auto-sync to the cloud leaderboard **and** the track editor, use the password-protected admin page:

1. Set the admin password on the Worker (production):
   ```bash
   npx wrangler secret put LEADERBOARD_ADMIN_PASSWORD
   ```
2. Deploy the Worker: `npm run party:deploy`
3. Host `admin.html` next to `index.html` (Netlify or local static server)
4. Open `https://yoursite/admin.html` and log in

The admin page can edit **Online Wins**, **Time Trial** lap times, **Versus** lap times, and **Track layouts** (via the Track Editor tab). Leaderboard changes save automatically and appear in the in-game leaderboard on refresh. Track changes must be exported from the editor and pasted into `tracks-shared.js` to ship permanently.

Local dev: copy `.dev.vars.example` to `.dev.vars` and set `LEADERBOARD_ADMIN_PASSWORD`. Do not commit `.dev.vars`.

**Keep the admin URL private** — it is not linked from the game menu.

## `online-wins.txt` (legacy / fallback)

Used as a fallback merge source for the in-game "ONLINE WINS" leaderboard when the cloud API is unavailable or for quick static seeding.

### Format

- One entry per line
- Whitespace-separated fields

```
USERNAME WINS
```

### Rules

- `USERNAME` is 3-12 characters, A-Z and 0-9 only (anything else is stripped).
- `WINS` must be a non-negative integer.
- Lines starting with `#` are ignored.

### Behavior

- The game merges this seed file with real cloud data (if available).
- If the same `USERNAME` appears in both places, the higher win total is used for display.

For cloud-only fake entries without editing a text file, use **admin.html** or `npm run seed:online-wins`.
