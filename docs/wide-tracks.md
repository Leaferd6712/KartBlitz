# 2.5× width pass

The immutable backup is `backups/tracks/before-wide-2026-11-02.json`. It includes all eight supplied authored layouts and the actual pre-change in-game widths. The new widths are exactly 2.5 times those in-game widths, without scaling cars or pit-lane widths.

`npm run tracks:widen` regenerates the candidate layouts from that backup, validates curved-road separation, bend radii and pit corridors, and writes the catalog only if all eight pass. It never compounds a prior widening. `scripts/calibrate-wide-tracks.mjs` measures clean stock-car reference laps and assigns a 5% allowance for the new target times. These are reference targets, not optimal lap records.

The current pass opens tight sections through separation and smoothing. Several routes are substantially reshaped and shorter, particularly Blue Bay Run and Hurricane Pass. Review the before/after preview at `ui/track-widening.html` before publishing. The backup makes the original shapes recoverable.

Geometry version 2 stores explicit widths and bypasses legacy remapping and width clamps. The editor preserves this flag and three-decimal coordinate precision. The authoritative online bakes now come from the same finalized geometry as offline races and training.

`npm run test:wide-tracks` checks the exact width multiplier, non-overlap constraints, pit clearance and online/offline geometry equality. The generation report is saved alongside the backup and shipped to the preview. Old trained models are incompatible with the new physics/geometry contract and need retraining. Existing historical lap records and ghosts have not been migrated or cleared; they need a revision-aware transition before production publishing.

This is a local candidate build. It has not been published.
