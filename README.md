# KartBlitz

A browser-based kart racer with ERS boost, DRS zones, tyre strategy, weather, and online multiplayer for up to six players.

**[Play now](https://kartblitz.netlify.app/)**

---

## Game modes

| Mode | Description |
|------|-------------|
| **Time Trial** | Press Enter on the title screen for solo hot laps. Infinite session — end when you are ready via the pause menu. Laps auto-save to the cloud leaderboard. |
| **Versus Race** | Split-screen two-player racing on the same track. |
| **AI Race** | Race a full field of AI opponents. Choose difficulty before starting. |
| **One Lap Shootout** | One flying lap against the AI. Beat their time. |
| **Online Lobby** | Host or join a room. Up to six players over the network. |

---

## Controls

### Player 1 (keyboard)
| Key | Action |
|-----|--------|
| W / S | Throttle / Brake |
| A / D | Steer |
| X | ERS boost (toggle) |
| C | DRS (toggle, in blue zones) |
| P | Pit (near garage) |

### Player 2 (keyboard)
| Key | Action |
|-----|--------|
| Arrow Up / Down | Throttle / Brake |
| Arrow Left / Right | Steer |
| `.` | ERS |
| `,` | DRS |
| `/` | Pit |

### Touch
On-screen joysticks handle steering, throttle, and brake. ERS, DRS, and pit buttons appear on the right side of the screen. Versus mode uses face-to-face seating layout.

Rebind keys and toggle ERS/DRS between hold and toggle modes from **Controls & Settings** on the main menu.

---

## ERS and DRS

**ERS (Energy Recovery System)** stores boost charge from braking, lifting off the throttle, and sustained flat-out straights. Press X to deploy for roughly +25% top speed and +14% acceleration. Charge drains over about five seconds while active.

**DRS (Drag Reduction System)** gives roughly +15% top speed when activated inside the blue zones marked on track.

---

## Local development

Serve the game from the repo root:

```bash
python -m http.server 8000
```

Open [http://localhost:8000/index.html](http://localhost:8000/index.html) in your browser.

### Online multiplayer (optional)

```bash
npm install --legacy-peer-deps
npm run party:dev
```

Run a static server for the HTML on a separate port. See [deploy.md](deploy.md) for full Netlify + Cloudflare Worker deployment.

After changing shared physics in `sim/`:

```bash
npm run sim:browser
npm run test:sim
```

---

## Project layout

| Path | Purpose |
|------|---------|
| `index.html` | Full offline game (rendering, UI, physics, tracks) |
| `sim/` | Shared physics used by online multiplayer and client prediction |
| `party/` | Cloudflare Worker / Durable Object for online races |
| `online.js`, `online-sim.js`, `online-codec.js` | Browser online client and netcode |
| `server/` | Optional legacy local leaderboard (Python) |
| `deploy.md` | Deployment guide for Netlify and Cloudflare |

---

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
