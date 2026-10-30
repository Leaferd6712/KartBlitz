/* DOM presentation only. Racing rules and saves remain in the game adapter. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let lastFocus = null;
  let confirmation = null;
  let guideStep = 0;
  let guideMoved = false;
  let guideEnabled = false;
  let announcementAt = 0;
  const guide = [
    ['Get moving', 'Hold your accelerator. Follow the gold pit lane to the exit.'],
    ['Take the corner', 'Steer gently left or right while moving. Look ahead along the road.'],
    ['Slow down smoothly', 'Brake before the next corner. Release the brake to accelerate again.'],
    ['Try your boost', 'On a straight, tap Boost once to switch it on. Tap again to save charge.'],
    ['You’re ready', 'Cross the chequered line to start a lap. Practise as long as you like.']
  ];
  function open(id) {
    lastFocus = document.activeElement;
    const el = $(id); if (!el) return;
    el.hidden = false; el.inert = false;
    el.querySelector('button')?.focus();
  }
  function close(id) { const el = $(id); if (el) el.hidden = true; lastFocus?.focus?.(); }
  function beginGuide() { guideStep = 0; guideMoved = false; guideEnabled = true; }
  function onScreen(id) {
    document.body.dataset.screen = id;
    if (id !== 'setup') $('setup-advanced')?.removeAttribute('open');
    if (id === 'garage') {
      const coins = getPlayerData().coins || 0;
      $('garage-first-goal').textContent = coins >= 160 ? 'Your first power upgrade is ready: High-Flow Intake · 160 coins.' : `Paint is free. Race to earn coins — ${160 - coins} more unlocks High-Flow Intake for stronger acceleration.`;
    }
    if (id !== 'menu') $('menu-tools')?.removeAttribute('open');
    const screen = $('screen-' + id);
    if (screen && !getA11yPrefs().reducedMotion && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      screen.animate([{ opacity: .45, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 150, easing: 'ease-out' });
    }
  }
  function guideTick(kart, input) {
    if (!guideEnabled || !kart) return;
    const panel = $('driving-guide');
    if (isPaused || kart.pitPhase === 'selecting') { panel.hidden = true; return; }
    panel.hidden = false;
    if (guideStep === 0 && Math.abs(kart.speed) > 45 && !kart._onPitLane) { guideStep++; guideMoved = true; }
    else if (guideStep === 1 && guideMoved && (input.left || input.right || Math.abs(input.steer || 0) > .3)) guideStep++;
    else if (guideStep === 2 && (input.down || input.brake > .3)) guideStep++;
    else if (guideStep === 3 && kart.ersActive) guideStep++;
    const [title, copy] = guide[guideStep];
    $('guide-step').textContent = `${guideStep + 1} / ${guide.length} · ${title}`;
    $('guide-copy').textContent = copy;
    $('guide-keys').textContent = touchMode ? 'Steer ◀ ▶ · GO · BRAKE · BOOST' : `${keyLabel(BINDINGS.p1.up)} accelerate · ${keyLabel(BINDINGS.p1.left)} / ${keyLabel(BINDINGS.p1.right)} steer · ${keyLabel(BINDINGS.p1.down)} brake · ${keyLabel(BINDINGS.p1.ers)} boost`;
  }
  function confirmExit(action, label = 'Leave this race?') {
    confirmation = action; $('leave-title').textContent = label;
    open('leave-dialog');
  }
  function welcome() {
    $('welcome-input').textContent = touchMode ? 'Touch controls are selected. You can change this below.' : 'Keyboard controls are selected. You can change this below.';
    open('welcome-dialog');
  }
  function finishWelcome(practice) {
    safeLocalSet('kartblitz_welcome_v1', '1');
    _onboardingStep = 'done';
    close('welcome-dialog');
    if (practice) startDrivingPractice();
  }
  function announce(text) {
    if (performance.now() - announcementAt < 500) return;
    announcementAt = performance.now(); $('game-announcement').textContent = text;
  }
  document.addEventListener('keydown', e => {
    const modal = ['welcome-dialog', 'leave-dialog'].map($).find(el => el && !el.hidden);
    if (!modal) return;
    if (e.key === 'Escape' && modal.id === 'leave-dialog') { close('leave-dialog'); confirmation = null; resumeGame(); e.preventDefault(); e.stopImmediatePropagation(); }
    if (e.key === 'Tab') {
      const buttons = [...modal.querySelectorAll('button')].filter(el => !el.disabled && el.getClientRects().length);
      const first = buttons[0], last = buttons.at(-1);
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    $('welcome-play').onclick = () => finishWelcome(false);
    $('welcome-practice').onclick = () => finishWelcome(true);
    $('welcome-keyboard').onclick = () => { setDeviceMode(false); $('welcome-input').textContent = 'Keyboard selected · W / A / S / D to drive.'; };
    $('welcome-touch').onclick = () => { setDeviceMode(true); $('welcome-input').textContent = 'Touch selected · steer buttons and GO / BRAKE pedals.'; };
    $('leave-stay').onclick = () => { confirmation = null; close('leave-dialog'); resumeGame(); };
    $('leave-confirm').onclick = () => { const action = confirmation; confirmation = null; close('leave-dialog'); action?.(); };
    $('guide-dismiss').onclick = () => { guideEnabled = false; $('driving-guide').hidden = true; safeLocalSet('kartblitz_practice_complete', '1'); };
    const fallback = () => {
      const stage = $('menu-car-stage');
      if (stage && !stage.dataset.ready) { stage.classList.add('preview-fallback'); $('menu-car-status').textContent = 'YOUR COLOURS. YOUR KART.'; }
    };
    setTimeout(fallback, 6000);
    window.addEventListener('kb:preview-ready', () => { const stage = $('menu-car-stage'); stage.dataset.ready = 'true'; stage.classList.remove('preview-fallback'); });
  });
  window.KartBlitzExperience = Object.freeze({ welcome, onScreen, beginGuide, guideTick, confirmExit, announce });
})();
