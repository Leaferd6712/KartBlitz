# Deploying KartBlitz

KartBlitz is mostly a single HTML file. The menu/garage cover car loads a Three.js GLB beside it. Three.js and fonts load from CDNs.

## Required files

| File | Role |
|------|------|
| `KartBlitz.html` | The game |
| `rb6.glb` | Menu/garage 3D cover car (~3.9 MB) |

Optional for development only (not needed to play/deploy the game):

- `Old Track Editor/`
- `rb6_dribble-main/` (source demo for the GLB)
- `LICENSE`

## Local play

From the project folder, start any static server, then open the URL it prints.

**Python:**

```bash
python -m http.server 8000
```

Then open: `http://localhost:8000/KartBlitz.html`

**Node (npx):**

```bash
npx --yes serve .
```

**VS Code / Cursor:** use the “Live Server” extension and open `KartBlitz.html` through it.

Opening over `http://`/`https://` is preferred so CDN modules and `rb6.glb` load reliably; some browsers restrict ES modules on `file://`.

## Deploy to the web

Upload/serve `KartBlitz.html` **and** `rb6.glb` in the same directory (rename the HTML to `index.html` if the host expects that).

### GitHub Pages / Netlify / Cloudflare Pages

Publish the HTML as a static site. No build command needed.

### itch.io / CrazyGames / other portals

Upload `KartBlitz.html` (or zip it alone) as an HTML project and set it as the embed entry file.

## Checklist

- [ ] `KartBlitz.html` is the entry page
- [ ] You open the game over `http://` or `https://` when possible
- [ ] Browser console shows no CDN / module load errors for Three.js
