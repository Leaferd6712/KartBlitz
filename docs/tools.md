# Tools outside the player menus

The root [README directory](../README.md#tools--feature-directory) lists browser launch links and setup guides. Start a local static server with `python -m http.server 8000` from the repository root to use the tools before deployment.

## ML Lab

Open `http://localhost:8000/index.html?tool=ml` directly. The lab loads its course, model runtime and trainer tools only for this URL. The former `kartblitz_ml_lab_enabled` preference no longer adds a menu button or Settings toggle.

In **Build**, select a demonstration circuit, press **Load verified laps**, and choose **Use for ML**. Only ghosts from the top ten leaderboard rows are offered; the replay endpoint checks their eligibility again when imported. Recording and demonstration exports stay in this panel. **Train** contains the trainer ZIP and setup commands; **Race** imports/exports models and starts a comparison race. Returning from a race reopens the lab. The lab's Back button opens the normal game.

See [Python training instructions](../ml_training/README.md). The trainer runs separately; a normal game session neither loads the lab nor connects to Python.

## Admin and editors

Open `http://localhost:8000/leaderboard-admin.html` for leaderboard edits, wins, deletion and random test data. Use its **Track Editor** and **Patch Notes Editor** buttons, or open `index.html?admin=track` and `patch-notes-editor.html` directly on the same server. Existing server-verified admin login remains required. Track target lap times are set in the track editor; recorded leaderboard lap times are edited in Admin Station.

The track editor shares the racing engine for **Apply to Game** playtests. Its direct entry skips player onboarding. These tools have no links in player menus. See [admin deployment](../deploy.md#admin-station) for password and Worker setup.

The [legacy standalone editor](../Old%20Track%20Editor/track-editor.html) remains available for manual coordinate export. Its [guide](../Old%20Track%20Editor/TRACK-EDITOR.md) describes the older workflow. The current game file is `index.html`; old references to `KartBlitz.html` and bundled coordinate examples are historical, not required files in the current repository.

## Legacy Node AI trainer

The older [headless REINFORCE experiment](../scripts/rl-train.mjs) uses the online simulator and a small discrete-action policy. Its [saved policy](../sim/rl/policy.json) is separate from the current continuous-control Python trainer and is not automatically used by game opponents.

Run it directly from the repository root after installing Node dependencies:

```sh
node scripts/rl-train.mjs --episodes 3000 --track 0 --seconds 18
node scripts/rl-train.mjs --eval --load sim/rl/policy.json --track 0
```

Training writes to `sim/rl/policy.json` by default; use `--out` to choose another file. Historical `npm run rl:train` examples in the script refer to this experiment, but that npm command now starts the current Python trainer.

## Leaderboard backups

- [Saved text snapshot](../backups/leaderboard.txt): usernames, times and wins, without device tokens.
- [Live text export](https://kartblitz-online.kartblitz.workers.dev/api/leaderboard-backup.txt): current service export when available.
- [Backup script](../scripts/backup-leaderboard.mjs): run `npm run backup:leaderboard` to refresh `backups/leaderboard.txt`.
- [Automatic workflow](../.github/workflows/backup-leaderboard.yml): configured every six hours, with manual dispatch and a deployment-workflow trigger.
- [D1 export instructions](../deploy.md): full database exports include device tokens and belong outside shared documentation.

For test data, see the [seed-file guide](../leaderboard/README.md) and [seeding script](../scripts/seed-online-wins.mjs). `npm run seed:online-wins` writes to the remote database; reading the fallback text file does not seed the cloud. The [legacy local server](../server/README.md) provides a separate SQLite-backed option.

## Developer diagnostics

- `http://localhost:8000/index.html?debug=1`: performance overlay during races. F9 toggles it; Alt+V toggles the developer pit-intent control. These shortcuts and saved debug overlays are inactive in normal play.
- `http://localhost:8000/index.html?netDebug=1`: online delay, jitter, bandwidth and correction HUD during online races; also enables the developer shortcuts.
- F8 still cycles graphics quality during normal play.
- `http://localhost:8000/index.html?partyHost=localhost:8787`: test online multiplayer against `npm run party:dev`.
- Add `&lbHost=localhost:8787` to an admin/tool URL to use a local leaderboard Worker. The legacy Python leaderboard and Wrangler both default to port 8787; run one at a time.

The [architecture page](online-mode.html), [position notes](online-mode-fixes.md), [reconnection guide](online-reconnect.md), [development guide](development.md) and [Windows build guide](desktop.md) cover the remaining development workflows. The [activity framework](activities.md) supports future work; it does not contain additional playable mini-games.
