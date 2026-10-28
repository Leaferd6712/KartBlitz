# KartBlitz UI redesign handoff

Updated: 2026-10-29 (Australia/Sydney)

## Branch and safety

- Working branch: `testing-ui-extra`
- Base: `origin/main` at `763e7edda6842941f30cf2aa2e9a3c85783987bc`
- `testing-ui-extra` did not exist locally or remotely when work began, so it was created from the fetched latest `origin/main`.
- Do not merge, commit, or push this work to `main` during follow-up tasks.
- GitHub Pages and Cloudflare Worker production jobs are job-gated to `refs/heads/main`.
- No production deployment was run.

## Commits created so far

1. `a59642e` — `docs: define KartBlitz interface design direction`
2. `d8c4e28` — `refactor: extract game scripts and base styles from HTML`
3. `6e3fcf3` — `ui: apply KartBlitz arcade theme and accessible lobby controls`
4. `78ab75d` — `fix: preserve track export and patch version editing after extraction`
5. `e019587` — `test: cover themed navigation and document branch preview setup`

A final validation/context commit may follow this handoff file.

## Resulting source layout

- `index.html` — screen markup, import map, patch-version metadata, stylesheet links, and explicit script order
- `ui/base.css` — mechanically extracted legacy inline CSS
- `ui/kartblitz.css` — scoped redesign under `body.kb-ui`
- `js/shared-modules.js` — shared ESM bridge with `../sim/` imports
- `js/game.js` — classic main runtime and track definitions
- `js/programme-runtime.js` — classic programme/ERS compatibility hooks
- `js/car-stage.js` — Three.js module for menu/garage previews
- `js/track-editor.js` — classic track editor runtime
- `js/ui-preview.js` — informational branch marker only
- `design.md` — tokens and component/accessibility/responsive contract
- `docs/ui-testing.md` — architecture, local play, preview, verification, limitations, rollback

Classic/module script types and runtime order were preserved. Screen markup remains in `index.html` before the main runtime; no fragment fetching or framework conversion was introduced.

## UI behaviour

- Theme tokens match the requested dark KartBlitz palette.
- Time Trial is the cyan primary action; menu secondary actions are neutral.
- Panels use 16px corners, controls use 10px corners, and controls have 44px minimum targets.
- Lobby statuses are polite atomic live regions and host settings have accessible names.
- Desktop 1440×900, portrait 390×844, and landscape 844×390 were visually inspected.
- The Three.js car rendered successfully during live local-browser inspection.
- Hidden screens remained hidden and there was no major horizontal overflow.
- Online Lobby Back returns to mode selection; mode Back returns to the main menu.
- `prefers-reduced-motion` and `html[data-reduced-motion="1"]` are covered.
- The marker appears only on hostnames beginning `testing-ui-extra--` or with `?uiPreview=1`; it never changes endpoints.

## Tooling and deployment compatibility

- `scripts/export-track-bakes.mjs` now prefers `js/game.js` and retains `index.html`/`KartBlitz.html` fallbacks.
- Track output remains 8 tracks with SHA-256 `9F74D085B6FC97A704BC476B91EBDF6AA1D4720B1935ECAF7EBFB243E4D37A66`.
- Patch version `2026-09-15` is stored in `<meta name="kartblitz-patch-version">` and read by `js/game.js`.
- `patch-notes-editor.html` updates the meta value first and retains legacy inline-constant support.
- Pages packaging copies and verifies complete `ui/` and `js/` folders.
- The test workflow runs on pushes to `testing-ui-extra`; production deploy workflows remain `main` only.
- No `netlify.toml` exists. Branch preview enablement must be configured in the existing Netlify site UI as documented in `docs/ui-testing.md`.
- A branch preview frontend may still use the existing multiplayer and leaderboard services.

## Validation status

Completed successfully during this task:

- `npm ci --legacy-peer-deps`
- `npm run tracks:export`
- `npm run sim:browser`
- `npm run test:static`
- `npm run test:unit`
- `npm run test:sim`
- focused Playwright UI suite (`e2e/ui-theme.spec.js`): 6/6 passed
- focused onboarding/responsive/Time Trial suite: 7/7 passed
- onboarding metadata suite: 3/3 passed
- progression suite after fixture correction: passed in 28.6s
- JavaScript syntax checks
- static-package copy/required-asset check
- `git diff --check`

The final full browser sweep was stopped at the user's request to avoid duplicating the focused coverage above. On the unchanged base it reproduced four failures: two unrelated ML Lab expectation mismatches, one accessibility timeout, and one progression timeout. The progression timeout is fixed by updating the stale fixture patch version. The user explicitly said ML Lab is not important for this task and can be fixed later.

## Deferred ML Lab follow-up

Keep this separate from the UI redesign:

1. `e2e/ml-lab.spec.js` expects `/KartBlitz Apex/`, while the current bundled model reports `KartBlitz Pre-Tuned Driver`.
2. The displayed PowerShell commands lose backslashes in rendered HTML, e.g. `.ml_traininginstall.ps1` instead of `.\ml_training\install.ps1`.

Reproduce on the latest branch before fixing; do not assume the old baseline result is still current.

## Resume commands

```powershell
git switch testing-ui-extra
npm ci --legacy-peer-deps
npm run tracks:export
npm run sim:browser
npm run test:static
npm run test:unit
npm run test:sim
npm run test:browser
git diff --check
```

For local play:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000/index.html`; add `?uiPreview=1` to inspect the branch marker.
