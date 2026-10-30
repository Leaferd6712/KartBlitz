# Windows desktop builds

The portable Windows x64 target packages the existing game, local fonts and kart renderer with Electron. There is one game runtime and one set of game saves per origin: the web and desktop versions use separate local storage. They can use existing cloud features when online; offline local progress does not depend on the cloud.

## Build and run

Use Windows 10/11 x64 and Node.js 24 for this target:

```powershell
npm ci --legacy-peer-deps
node node_modules/electron/install.js
npm run desktop:dev
```

The explicit Electron installation handles environments that disable dependency install scripts. A normal install may already have downloaded it. To package:

```powershell
npm run test:activities
npm run test:desktop
npm run desktop:build
node scripts/release-checksums.mjs
npm run test:portable
```

Output: `dist/windows/KartBlitz-1.0.0-windows-x64-portable.exe` and `SHA256SUMS.txt`. The portable launcher extracts its bundled runtime to a temporary directory at launch; it does not install the game or need administrator rights. Saves use Electron's normal per-user application data folder, rather than the executable's directory. “Portable” describes deployment, not saves carried on a USB drive.

To smoke-test the actual packaged application:

```powershell
$env:KARTBLITZ_PACKAGED_EXE = "$PWD\dist\windows\win-unpacked\KartBlitz.exe"
$env:KARTBLITZ_TEST_USER_DATA = "$env:TEMP\kartblitz-packaged-smoke"
npx playwright test --config desktop/playwright.config.mjs
```

This checks boot, a Quick Race, persistent storage after relaunch, and denial of requests for files outside the runtime manifest. Network requests are blocked during the game checks. Before publication, additionally run the portable launcher on a clean Windows account, check sound/touch input and external links, and compare `Get-FileHash -Algorithm SHA256` with the checksum file. Desktop smoke checks do not establish support on every graphics driver or school-managed PC.

## Why Electron

Electron bundles Chromium, giving the canvas game, Three.js preview and audio the same engine across Windows machines. Its main cost is download size: the browser engine is much larger than the game assets. The wrapper stays small and uses the repository's existing JavaScript/Node toolchain.

Tauri generally has a smaller application payload because it uses the system webview, but brings Rust and Windows build tools and depends on WebView2 availability/version. Its Windows distribution supports MSI/NSIS and several WebView2 installation strategies; bundling an offline WebView2 runtime reduces the size advantage. For this canvas-heavy project, predictable rendering and fewer build toolchains take priority. These are project tradeoffs, not benchmark claims about the two frameworks. See [Tauri's Windows distribution guide](https://v2.tauri.app/distribute/windows-installer/) and [Electron's distribution documentation](https://www.electronjs.org/docs/latest/tutorial/application-distribution).

An installer is deferred. It would add shortcuts, registration and uninstall support; it would not make the game itself more capable. Add one when managed deployment or update requirements justify testing a second format.

## Runtime boundaries

`scripts/prepare-game.mjs` copies an explicit player-runtime allowlist. ML Lab assets, Python trainer downloads, standalone admin HTML, credentials, `node_modules` and tests are excluded from desktop builds; the website hosts the README-linked tools. The embedded track editor still shares engine code for browser playtests but has no player-menu entry. The `kbapp://game/` protocol serves only manifest-listed files. The renderer has Node integration disabled, context isolation and sandboxing enabled, and no preload bridge. External navigation is limited to the project's GitHub and Pages hosts in the system browser. The game never runs Python or native commands through the renderer. These choices follow [Electron's security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

Keep Electron on a supported stable line and update its pinned version and lockfile together; review [Electron's support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) before releases. No auto-updater is included.

## Release workflow

`.github/workflows/desktop-release.yml` runs manually or for `v*` tags. It prepares shared assets, runs lifecycle and desktop checks, builds the portable executable, verifies the packaged application and uploads the executable plus checksum as workflow artifacts. A tag also creates a **draft** GitHub Release; a maintainer verifies and publishes it separately.

Current builds have no signing certificate configured and are **unsigned**. The README links to the releases index and states that no public download is available until one is published; it never guesses an asset URL. Keep `package.json`, `desktop/package.json` and `core/game-manifest.json` versions aligned before tagging. Do not commit generated executables.
