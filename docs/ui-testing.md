# UI architecture and testing

## Architecture

`index.html` contains the complete screen markup, import map, stylesheet links, and explicit script order. Markup is deliberately present before the classic game runtime starts; KartBlitz does not fetch HTML fragments at runtime.

Styles load in this order:

1. `ml/lab.css`
2. `ui/base.css` — the extracted legacy rules
3. `ui/kartblitz.css` — the redesign, scoped to `body.kb-ui`

Game scripts load in this order:

1. Online codec, browser simulator, and online client
2. `js/shared-modules.js` (module bridge)
3. `js/game.js` (classic main runtime)
4. `js/programme-runtime.js` (classic programme/ERS hooks)
5. `js/car-stage.js` (module-based Three.js previews)
6. `js/track-editor.js` (classic editor)
7. `js/ui-preview.js` (informational preview marker)
8. ML browser runtime and lab

Relative ES module imports in `js/shared-modules.js` use `../sim/`. Runtime asset strings such as `./rb6.glb` remain document-relative because the loaders resolve them from the page.

## Local play

Install the locked dependencies and run either static server from the repository root:

```powershell
npm ci --legacy-peer-deps
python -m http.server 8000
```

Open `http://localhost:8000/index.html`.

The test server is another option:

```powershell
node scripts/e2e-static-server.mjs
```

Open `http://127.0.0.1:4173/`. Add `?uiPreview=1` to display the branch marker locally.

The static frontend continues to use the existing multiplayer and leaderboard services unless it is opened on localhost with the repository's local-worker routing. Do not host/join public lobbies or submit laps during layout-only testing unless interaction with those services is intentional.

## Branch preview setup

No `netlify.toml` is present, so branch-deploy policy remains in the existing Netlify site's UI and production settings are not changed by this branch.

To enable a non-production preview safely:

1. Push `testing-ui-extra` to GitHub.
2. In Netlify, open the KartBlitz site and go to **Site configuration → Build & deploy → Continuous deployment**.
3. Under **Branches and deploy contexts**, enable branch deploys for selected branches and add `testing-ui-extra`.
4. Keep the production branch set to `main` and keep the existing publish directory/build settings.
5. Wait for the branch deploy, then verify `https://testing-ui-extra--kartblitz.netlify.app/` before sharing it.

The marker appears automatically only when the hostname starts with `testing-ui-extra--`. It does not change service endpoints or gameplay.

## Verification

```powershell
npm run tracks:export
npm run sim:browser
npm run test:static
npm run test:unit
npm run test:sim
npm run test:browser
git diff --check
```

Focused browser coverage in `e2e/ui-theme.spec.js` checks theme activation, main/mode/lobby navigation, live-region attributes, labelled host controls, hidden-screen state, 1440×900 desktop, 390×844 portrait, 844×390 landscape, horizontal overflow, reduced motion, and preview-marker gating.

The live Worker integration test stays opt-in and is skipped unless the local Worker is deliberately running. Visual verification should confirm the Three.js car preview separately because deterministic Playwright fixtures intentionally abort `rb6.glb` and external CDN requests.

## Limitations

- A branch preview can use the current production multiplayer and leaderboard services; it is not an isolated backend.
- External fonts, CrazyGames SDK, Three.js CDN modules, and the GLB model require network access. The menu remains usable if a dependency is unavailable.
- The canvas race HUD is intentionally outside the HTML theme scope.
- Production Pages and Worker jobs are conditioned on `refs/heads/main`; `testing-ui-extra` runs tests but does not publish through those workflows.

## Rollback

No production rollback is required until this branch is intentionally merged. For local rollback, switch back to `main`. To remove the redesign while preserving extraction, revert the UI and later compatibility/test commits in reverse order. To remove the extraction too, also revert the extraction commit; do not delete `ui/` or `js/` without restoring the corresponding inline blocks and deployment packaging.
