# KartBlitz Track Editor

Standalone development tool for **manually** designing track layouts and exporting coordinate data for KartBlitz.

**This editor does not modify the game.** It never reads from or writes to `KartBlitz.html`. You copy exported coordinates into the game yourself.

---

## Quick start

1. Open `track-editor.html` in a browser (double-click or drag into Chrome/Edge/Firefox).
2. Use **Track** layer + **Add** to place road waypoints; **Select/Move** to drag; **Insert** to split a segment.
3. Switch to **AI Line** layer (or **Copy from centerline**) and nudge the purple path through apexes.
4. Set start position, pit path, checkpoints (`cpFracs`), and DRS zones in the right panel.
5. Choose **Game TRACKS object** under Export → **Copy** or **Download**.
6. Paste the object into the `TRACKS` array in `KartBlitz.html`.

---

## How it integrates with the game (conceptually)

KartBlitz tracks are authored as closed loops of `{x, y, brake?}` waypoints inside the `TRACKS` array. On load the game:

1. Optionally remaps waypoints for braking corners
2. Builds a dense Catmull-Rom spline (`buildSpline(waypoints, 28)`)
3. If `racingLine` is present (≥3 points), bakes it to per-spline lateral offsets for AI
4. If any waypoint has `brake` > 0, bakes a stretched brake plan for AI speed targets
5. Derives lap length, checkpoint lines, DRS zones, pit densify, scenery, and start grid

### Brake tags (AI guideline)

On each **track** waypoint (not racing-line nodes):

| `brake` | Meaning | Editor color |
|--------|---------|--------------|
| **0** | No brake / keep pace | white / green (start) |
| **1** | Very light | amber |
| **2** | Light | orange |
| **3** | Medium | red |
| **4** | Heavy | brighter red |
| **5** | Maximum | dark red |

The game stretches each tagged point into an **approach zone** before the node and a short **hold** after it, then AI uses the max tag ahead when setting target speed. Untagged tracks keep the old curvature-only braking.

In the editor: select Track nodes → **0–5** (or keys `0`–`5`) → Export → paste into `KartBlitz.html`.

`all-tracks-coords.json` ships all three circuits with `brake: 0` on every waypoint so you can import and paint tags.

The editor:

- Lets you author the **same fields** the game expects (including optional `racingLine`)
- **Mirrors** the game’s spline/remap math for preview only (copied into the editor, not linked)
- Exports **authored (pre-remap) data** — do **not** paste `spline`, `cpLines`, `racingLineOffset`, or `scenery`; the game rebuilds those

Typical world scale: roughly `0–5200` in X and `0–6200` in Y. About **21–60** nodes works well. Start/finish usually sits on an eastbound straight with `startAngle: 0`.

---

## AI racing line (rebuild workflow)

AI still uses the existing pure-pursuit + curvature/brake-plan braking + traffic logic. Your `racingLine` **biases** where they aim (~95% toward the authored line, 5% procedural lane offsets). Omitting `racingLine` leaves AI behaviour unchanged.

### Rebuild all tracks

1. Import a track from `all-tracks-coords.json` (copy one object into Import).
2. Edit **waypoints** for the road shape (widen very technical sections if needed).
3. Tag brake points on Track nodes: `5` for hairpins, `3–4` for medium stops, `1–2` for lifts, leave `0` on straights.
4. Click **Copy from centerline**, switch to **AI Line**, then nudge:
   - Outside on corner entry
   - Inside near the apex
   - Outside on exit
5. Export **Game TRACKS object** → paste into `TRACKS` in `KartBlitz.html`.
6. Playtest. If AI still cuts or misses, nudge the purple line first; only then widen waypoints or raise `aiBrakeLookaheadScale`.

### Authoring tips

- Prefer a **smooth** racing line over a hyper-technical geometric middle
- Keep the line inside the track ribbon (the game clamps offsets to ~±42% of width)
- Tight chicanes: one clean compromise path works better than zigzagging the centerline

Toolbar: **Track** edits waypoints; **AI Line** edits `racingLine`. Purple polyline = AI preferred path (drawn as a **Catmull-Rom curve** through your nodes — same smoothing as the track centreline). Place a few nodes through each corner for a smooth outside→apex→outside line; you do not need dense points. **Clear** removes it from export.

---

## Editing tools

| Tool | Shortcut | Action |
|------|----------|--------|
| Select | `V` | Click node or drag a box (Shift multi-select) |
| Move | `G` | Drag selected nodes |
| Add | `A` | Click canvas to append a node |
| Insert | `I` | Click near a segment to insert a node |
| Delete | `Del` | Remove selected nodes |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` | History |
| Pan | Middle/right mouse, or Space+drag | Move camera |
| Zoom | Mouse wheel | Zoom toward cursor |

Toggles: grid, snap, nodes, authored line, track ribbon, AI racing line, remap preview, pit, direction, CP/DRS.

---

## Import formats

Paste into the Import box or use **Import File**:

- **JSON** — `[{x,y}, …]` or a full editor project / TRACKS-like object with `waypoints` (and optional `racingLine`)
- **CSV** — `x,y` lines (header optional)
- **Plain text** — `x y` or `x,y` per line
- **JS-ish arrays** — `{x:800,y:5200}, …` (unquoted keys accepted)

---

## Export formats

| Format | Use |
|--------|-----|
| **Game TRACKS object** | Paste directly into `TRACKS` in `KartBlitz.html` (includes `racingLine` when set) |
| **JS waypoints array** | Replace only the `waypoints:[…]` block |
| **JSON** | Generic `[{x,y},…]` |
| **CSV** | Spreadsheets |
| **Plain text** | Simple lists |

### Pasting into the game

1. Open `KartBlitz.html` in a text editor.
2. Find `const TRACKS = [ … ];`
3. Paste your exported object as a new or replacement entry (unique `id`).
4. Save and reload the game in the browser.

Example fields:

```js
{
  id: 12,
  name: 'MY CIRCUIT',
  // …
  waypoints: [ /* {x,y,brake} — brake 0/1/3; do NOT repeat first point */ ],
  racingLine: [ /* optional AI preferred path */ ],
  startPos: { x: 1200, y: 5200 },
  startAngle: 0,
  pitLane: { path: […], entryPt, garagePos, exitPos, width },
  cpFracs: [0.0, 0.15, /* … */],
  drsFracs: [[0.02, 0.12], [0.50, 0.60]],
  surface: { offTrackMult: 1.0, label: 'GRASS' }
}
```

---

## Save / Load (editor projects only)

- **Save Project** → `.kbtrack.json` (waypoints + racingLine + meta)
- **Load Project** / **Autosave** (`kartblitz_track_editor_project`) — editor data only; never writes game files

---

## Mirrored / game functions

**Editor preview (copied):** `catmullRom`, `buildSpline`, remap helpers.

**Game (live):** `bakeRacingLineOffsets` + blend in `makeAIInput` (~95% toward authored offset). Traffic, cruise lanes, and recovery still apply on top.

---

## Important reminders

- Editor and game stay **separate**; you paste exports yourself.
- Tracks **without** `racingLine` keep the original AI behaviour.
