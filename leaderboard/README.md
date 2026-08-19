# KartBlitz leaderboard seed files

These text files are optional "fake data" helpers for local development / testing.

## Recommended: `leaderboard-admin.html`

For live editing with auto-sync to the cloud leaderboard, use the password-protected admin page:

1. Set the admin password on the Worker (production):
   ```bash
   npx wrangler secret put LEADERBOARD_ADMIN_PASSWORD
   ```
2. Deploy the Worker: `npm run party:deploy`
3. Host `leaderboard-admin.html` next to `index.html` (Netlify or local static server)
4. Open `https://yoursite/leaderboard-admin.html` and log in

The admin page can edit **Online Wins**, **Time Trial** lap times, and **Versus** lap times. Changes save automatically and appear in the in-game leaderboard on refresh.

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

For cloud-only fake entries without editing a text file, use **leaderboard-admin.html** or `npm run seed:online-wins`.
