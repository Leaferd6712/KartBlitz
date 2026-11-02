# Publishing tracks from the editor

Draft autosave only stores the current editor project in this browser. Apply to Game is a session preview. Save Project downloads a project backup. **Save to Actual Game** commits the selected track to `index.html` on `Leaferd6712/KartBlitz`'s `main` branch and queues the existing deployments for everyone.

The confirmation warns about changed lap times, stale records/targets and AI retraining. Cancelling sends no save request. Publishing uses the existing admin password; the GitHub credential stays on the Worker. A page built from an older source cannot overwrite a newer source file. After a successful save, the button stays disabled until the page is reloaded after deployment.

## One-time setup

1. Create a fine-grained GitHub personal access token restricted to `Leaferd6712/KartBlitz`, with repository **Contents: read and write**. The token owner needs permission to commit to `main`; branch protections still apply.
2. From the repository, run `npx wrangler secret put TRACK_PUBLISH_GITHUB_TOKEN` and enter the token at the prompt. Do not put it in HTML, source control, browser storage, or chat. Use an appropriate expiration and rotate it when needed.
3. Deploy the Worker and website containing this feature. Keep `LEADERBOARD_ADMIN_PASSWORD` configured as before.

Alternatively, store the publishing token as a GitHub Actions repository secret named `TRACK_PUBLISH_GITHUB_TOKEN`. The Worker deployment workflow installs it as a Worker secret using the existing Cloudflare deployment credentials. This is useful when local Wrangler is not signed in. If neither location has a token, the button reports that publishing is unconfigured and does not claim a successful save.

Official references: [GitHub Contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents), [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## What updates

GitHub Pages builds the new game and the actual-game training core from the saved source. The Worker deployment also runs on changes to `index.html`, regenerating the online track bakes. Deployment can take several minutes; existing loaded pages and running races do not hot-reload. The editor links to Actions and the saved commit and never claims that a queued deployment is already live.

The save does not erase or recalculate records, change target lap times beyond the editor's explicit target setting, migrate ghosts, or restart AI training. Pull the new source before a new local training run. Review timing baselines and trained models against the new track. To recover a previous track, revert the publishing commit in GitHub; that starts the same deployment process.

If publishing is unconfigured, blocked, or fails, the editor displays the error and keeps the local draft. Reloading to resolve a conflict does not automatically restore the draft into the game; use Save Project before reloading, then Load Project to recover your edits.
