import { createActivityHost } from './activity-host.js';
const host = createActivityHost();
host.register({
  id: 'racing', title: 'KartBLitz',
  start(context, options) { if (options.attach) return; return options.practice ? window.startDrivingPractice(context) : window.startQuickRace(context); },
  pause() { window.pauseGame(); },
  resume() { window.resumeGame(); },
  dispose() { window.returnToMainMenu(); }
});
// Future activities register here; no menus or placeholder mini-games are created.
window.KartBlitzActivities = host;
