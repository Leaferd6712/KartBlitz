# Saved AI model packages

`approved/` holds model packages saved for the repository after validation, where present. New experimental weights and their recordings remain under `ml_training/runs/`, grouped by trainer and run ID. An experimental candidate is not automatically an approved race driver.

The game's selection page is `ui/ai-models.html`; its source is `ui/ai-models.js`. Standalone experimental imports remain manual candidates. The authorised [continuous V2 campaign](../docs/ai-training/continuous-v2.md) automatically selects verified improvements using `active.json` and immutable `approved/continuous/` packages. `backups/` preserves the old controller/source and prior approved files; AI Models also supports restoring Legacy and disabling automatic replacement in that browser. Files stay local and uncommitted until separately published.
