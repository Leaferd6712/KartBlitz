# Where everything lives in KartBlitz

Start here when looking for a file. The game entry points keep their existing names and URLs; supporting scripts and guides are grouped by purpose.

```text
KartBlitz/
  index.html                 Main browser game: racing, rendering, physics and menus
  ui/                        Game screens, styling, cameras and interface assets
  sim/                       Shared simulation, AI controllers, policies and track data
  ml/                        Original educational ML Lab in the browser
  ml_training/               Python trainers, simulator workers and local training data
  ai-models/                  Approved model packages intended for the repository

  scripts/
    ai-training/             RL launchers, pace research, coaching and evaluation
    build/                   Game packaging, assets, track export and runtime checks
    testing/                 Test launchers and native-browser regression checks
    leaderboards/            Leaderboard backups, recording exports and seed tools
    development/             Local test server and documentation screenshots
    release/                 Release checksum generation

  docs/
    ai-training/             Trainer setup, campaigns, research and experiment findings
    development/             Setup, desktop builds, hosting and developer tools
    multiplayer/             Online-racing fixes and reconnection notes
    track-editing/           Track-editor publishing setup
    planning/                Improvement lists and original loose project notes
    assets/                  Images used in project documentation

  design/reference-images/   Visual inspiration and its source links
  logs/                      Archived local debugging logs
  Old Track Editor/          Legacy standalone editor; its published URL stays stable

  party/                     Cloudflare multiplayer and leaderboard backend
  d1/                        Cloud database migrations/schema
  leaderboard/               Leaderboard data and seeding documentation
  backups/                   Saved leaderboard snapshots/backups
  server/                    Older Python leaderboard server
  desktop/                   Windows/Electron application and packaging
  core/                      Application shell, activity host and version manifest
  e2e/                       Browser integration tests
```

## Find a specific feature

- **Change the game itself:** [index.html](index.html). This is still the main game source, including the original AI driving logic.
- **Official ML training page:** [ui/official-ml.js](ui/official-ml.js).
- **Choose AI models per track:** [ui/ai-models.js](ui/ai-models.js) and [sim/ai-model-library.mjs](sim/ai-model-library.mjs).
- **AI driving at runtime:** [sim/official-runtime.mjs](sim/official-runtime.mjs), [V1 controller](sim/official-policy.mjs), [V2 controller](sim/official-policy-v2.mjs).
- **Python training:** [V1 trainer](ml_training/official_train.py), [V2 trainer](ml_training/official_train_v2.py), [race experiments](ml_training/race_rnd.py).
- **Run AI research:** [scripts/ai-training/](scripts/ai-training/) and [AI setup/research guides](docs/ai-training/).
- **Watch recordings and racing lines:** [ui/racing-lines.js](ui/racing-lines.js) and [ui/lap-replay.js](ui/lap-replay.js).
- **Browser online racing:** [online.js](online.js), [online-codec.js](online-codec.js), [online-sim.js](online-sim.js) and [party/](party/).
- **Track publishing:** [docs/track-editing/track-publishing.md](docs/track-editing/track-publishing.md).
- **Build or host the game:** [docs/development/hosting-and-deployment.md](docs/development/hosting-and-deployment.md), [scripts/build/](scripts/build/), [desktop/](desktop/).
- **Kart 3D model:** [rb6.glb](rb6.glb). Keeping it at the root preserves the game asset URL.
- **Design inspiration:** [design/reference-images/](design/reference-images/).
- **Old improvement notes:** [docs/planning/](docs/planning/). Original note contents have been preserved.

## Where trained weights and recordings are saved

These large local data folders have not been moved or renamed:

- `ml_training/runs/official/<job ID>/`: official runs, attempt archives and exported track packages.
- `ml_training/runs/campaign/`: campaign status, scheduling and validation history.
- `ml_training/runs/energy-v2/`: V2 energy/racing-line training experiments.
- `ml_training/runs/pace-rnd/`: pace and race R&D, candidate weights, comparisons and recordings.
- `ai-models/approved/`: approved packages saved for the repository, where present.

Inside a run, `attempts.jsonl.gz` contains recordings, `attempt-index.jsonl` indexes them, `last.zip` is a resumable checkpoint and `best.zip` is the retained best checkpoint where that trainer supports it. `*.kartai.json` files are exported game policies. Browser model selections and imported candidates also live in that browser's local storage/IndexedDB.

## Generated folders and installed dependencies

`public/`, `dist/` and `desktop/game/` are generated game builds. Edit source files, then rebuild. `test-results/` contains test output. `node_modules/` holds JavaScript dependencies; `.venv-official/` holds the Python training environment. `.wrangler/` and `playwright/` contain local tool state/cache. These folders remain in their expected locations.

Root configuration files (`package.json`, `package-lock.json`, `playwright.config.mjs`, `wrangler.jsonc`, `electron-builder.yml`, `tsconfig.json`) stay at the root because the build tools expect them there. Existing `npm run ...` command names are unchanged.

Three script entry points retain their original paths for simulator/model compatibility: `scripts/build-official-core.mjs`, `scripts/build-online-sim.mjs` and `scripts/campaign-browser-check.mjs`. The generated simulator files remain at their established runtime paths too.

[Exact old-to-new filename map](docs/repository-file-moves.json) records every file moved in this tidy-up, including renamed reference images. Historical training metadata can still mention old script locations; use this map to find their current locations.
