# KartBlitz interface design direction

KartBlitz uses a Discord-inspired dark surface hierarchy adapted to a colourful browser arcade racer. The interface should feel clear, social, and immediately playable while preserving the existing 3D car, circuit previews, player paint colours, tyre compound colours, and canvas race HUD.

## Design tokens

| Role | Token | Value |
| --- | --- | --- |
| Background | `--kb-background` | `#111325` |
| Panel | `--kb-panel` | `#1d213a` |
| Raised surface | `--kb-raised` | `#282e4b` |
| Border | `--kb-border` | `#454e73` |
| Primary text | `--kb-text` | `#f7f8ff` |
| Supporting text | `--kb-text-supporting` | `#c1c8e4` |
| Primary action | `--kb-primary` | `#78e7f5` |
| Selection | `--kb-selection` | `#b7a4ff` |
| Rewards | `--kb-reward` | `#ffe18a` |
| Success | `--kb-success` | `#8aefb2` |
| Error | `--kb-error` | `#ff9eae` |

Nunito remains the interface typeface. Timing, lap, leaderboard, and result values use tabular numerals. Panels use 16px corners, controls use 10px corners, and spacing follows a 4px rhythm.

## Surface and component rules

- The background frames the experience; panels organise screens; raised surfaces identify cards, inputs, and grouped controls.
- Primary race actions are cyan. Secondary navigation and utility actions are neutral. Rewards and earned values use gold. Selection uses lavender.
- Controls have a minimum 44px target. Hover and pressed states adjust colour and border only; controls do not jump or translate.
- Selected controls combine colour, border, and a persistent surface change. Disabled controls remain legible, lower contrast, and use a non-interactive cursor.
- Keyboard focus uses a high-contrast two-layer outline that remains visible on every surface.
- Status text uses live regions where asynchronous lobby state changes. Success and error colours are never the sole state indicator.
- Cards keep their working IDs/classes and JavaScript handlers. The theme layers over the existing markup rather than replacing game behaviour.
- The existing paint and tyre colours are content, not chrome, and are not remapped to theme tokens.

## Screen patterns

- Main menu: a two-panel hero/action layout on wide screens, with Time Trial as the single primary action and other destinations as neutral controls.
- Mode, circuit, garage, leaderboard, and results screens: a clear title region followed by scrollable card or table content inside the safe viewport.
- Setup and public lobbies: labelled grouped controls, readable status messages, and a strong primary start/host action.
- Controls: concise grouped settings while retaining explanatory copy and full keyboard/touch instructions.
- Pause and pit overlays: HTML surfaces use the same panels, borders, focus states, and action hierarchy; the canvas HUD remains unchanged.

## Accessibility

- Preserve semantic buttons, labels, `.hidden`, inert states, and JavaScript-managed `display` values.
- Use visible `:focus-visible` styling with at least 3:1 contrast against adjacent surfaces.
- Provide programmatic names for host settings and polite atomic announcements for lobby status.
- Body text and controls target WCAG AA contrast. Supporting text is not used for critical information without a stronger companion cue.
- Respect both `prefers-reduced-motion: reduce` and `html[data-reduced-motion="1"]`; remove non-essential animation and shorten transitions in either mode.
- Do not hide explanatory content solely to make small screens fit. Allow content regions to scroll instead.

## Responsive behaviour

- Desktop (1440x900): retain the two-column main menu and multi-column card grids with bounded line lengths.
- Phone portrait (390x844): use a single column, safe-area padding, full-width controls, and vertical scrolling.
- Short landscape (844x390): compact decorative spacing, keep primary controls reachable, and allow panels to scroll without major horizontal overflow.
- Layout sizing must continue to honour `--ui-scale` and safe-area insets.
- The 3D preview may reduce in height on constrained screens but remains available when WebGL and its dependencies load.

## Scope

This redesign covers the main menu, mode selection, circuit cards, setup, garage, public lobbies, controls, leaderboard, results, and HTML pause/pit overlays. It does not change race physics, networking protocols or endpoints, saves, progression, rewards, track data, or the canvas HUD.
