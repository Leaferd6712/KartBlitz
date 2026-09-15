import { test as base, expect } from '@playwright/test';

export { expect };

const PATCH_VERSION_LS_KEY = 'kartblitz_last_patch_version';
const CURRENT_PATCH_VERSION = '2025-08-20';

function crazyGamesStub() {
  window.CrazyGames = {
    SDK: {
      init: async () => {},
      game: {
        loadingStart() {},
        loadingStop() {},
        gameplayStart() {},
        gameplayStop() {},
        happytime() {},
        addSettingsChangeListener() {},
      },
      data: {
        async get() { return null; },
        async set() {},
      },
      ad: {
        requestAd(_type, cbs) {
          if (cbs && typeof cbs.adFinished === 'function') cbs.adFinished();
        },
      },
    },
  };
}

async function installDeterministicRoutes(page) {
  await page.route('https://sdk.crazygames.com/**', (route) => route.abort());
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.route('**/rb6.glb', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/device-status')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, registered: true, username: 'E2EBOT' }),
      });
      return;
    }
    if (url.includes('/api/runs/start')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, runId: 'e2e-run-1' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await installDeterministicRoutes(page);
    await page.addInitScript(crazyGamesStub);
    await use(page);
  },
});

export async function seedStorage(page, entries) {
  await page.addInitScript((data) => {
    if (sessionStorage.getItem('kartblitz_e2e_seeded') === '1') return;
    sessionStorage.setItem('kartblitz_e2e_seeded', '1');
    for (const [key, value] of Object.entries(data)) {
      window.localStorage.setItem(key, value);
    }
  }, entries);
}

export function returningPlayerStorage(extra = {}) {
  return {
    kartblitz_devicemode: 'keyboard',
    [PATCH_VERSION_LS_KEY]: CURRENT_PATCH_VERSION,
    ...extra,
  };
}

export function playerSaveJson(overrides = {}) {
  return JSON.stringify({
    coins: 0,
    gems: 0,
    lastPatchVersion: CURRENT_PATCH_VERSION,
    schemaVersion: 1,
    revision: 1,
    updatedAt: Date.now(),
    ...overrides,
  });
}

export async function gotoGame(page, opts = {}) {
  if (opts.storage) await seedStorage(page, opts.storage);
  await page.goto('/');
  await page.waitForFunction(() =>
    window.KartBlitzProgramme
    && window.KartBlitzRewards
    && window.KartBlitzRnD
    && window.KartBlitzSave
    && typeof window.getActiveRace === 'function'
  );
}

export async function dismissOnboarding(page) {
  const patch = page.locator('#patch-notes-overlay.open');
  if (await patch.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'GOT IT' }).click();
  }
  const device = page.locator('#device-prompt');
  if (await device.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'KEYBOARD ONLY' }).click();
  }
  await expect(page.locator('#patch-notes-overlay.open')).toHaveCount(0);
  await expect(page.locator('#device-prompt')).toBeHidden();
}

export async function waitForMenu(page) {
  await expect(page.locator('#screen-menu')).toBeVisible();
  await expect(page.getByRole('button', { name: /TIME TRIAL/ })).toBeVisible();
}

export async function pickFirstTrack(page) {
  await expect(page.locator('#screen-track')).toBeVisible();
  await page.getByRole('button', { name: /Select track/ }).first().click();
}

export async function startTimeTrial(page) {
  await page.getByRole('button', { name: /TIME TRIAL/ }).click();
  await pickFirstTrack(page);
  await expect(page.locator('#screen-setup')).toBeVisible();
  await expect(page.locator('#setup-start-btn')).toHaveText(/START SESSION/);
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#gameCanvas')).toBeVisible();
  await page.waitForFunction(() => {
    const race = window.getActiveRace();
    return !!(race && race.mode === 'trial');
  });
}

export async function confirmStartTyres(page, label = /MED/) {
  const overlay = page.locator('#pit-ui-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.locator('#pit-ui-title')).toContainText(/TIME TRIAL/i);
  // Confirm is ignored while the pit-select lock (held throttle / pit key) is armed.
  await page.waitForFunction(() => {
    const race = window.getActiveRace();
    const k = race && race.karts && race.karts[0];
    return !!(k && k.pitPhase === 'selecting' && (k._pitSelectLock || 0) <= 0);
  });
  const choice = page.locator('.pit-ui-choice').filter({ hasText: label }).first();
  if (await choice.count()) await choice.click();
  else await page.locator('.pit-ui-choice').first().click();
  await page.getByRole('button', { name: /CONFIRM & DRIVE OUT/ }).click();
  await expect(overlay).toBeHidden();
}

export async function openCustomRace(page) {
  await page.getByRole('button', { name: /CUSTOM RACE/ }).click();
  await expect(page.locator('#screen-mode')).toBeVisible();
}

export async function startAiRace(page, { laps = 1, opponents = 1 } = {}) {
  await openCustomRace(page);
  await page.getByRole('button', { name: /AI Race/ }).click();
  await expect(page.locator('#ai-difficulty')).toBeVisible();
  await page.locator('#ai-count-slider').fill(String(opponents));
  await page.getByRole('button', { name: 'CHOOSE TRACK' }).click();
  await pickFirstTrack(page);
  await expect(page.locator('#screen-setup')).toBeVisible();
  await page.getByRole('button', { name: `${laps}LAP${laps === 1 ? '' : 'S'}` }).click();
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#gameCanvas')).toBeVisible();
  await page.waitForFunction(() => {
    const race = window.getActiveRace();
    return !!(race && race.mode === 'ai');
  });
}

export async function startVersusRace(page, { laps = 1 } = {}) {
  await openCustomRace(page);
  await page.getByRole('button', { name: /Versus Race/ }).click();
  await pickFirstTrack(page);
  await expect(page.locator('#screen-setup')).toBeVisible();
  await page.getByRole('button', { name: `${laps}LAP${laps === 1 ? '' : 'S'}` }).click();
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#gameCanvas')).toBeVisible();
  await page.waitForFunction(() => {
    const race = window.getActiveRace();
    return !!(race && race.mode === 'versus');
  });
}

export async function skipCountdown(page) {
  await page.waitForFunction(() => {
    const race = window.getActiveRace();
    return !!(race && (race.phase === 'countdown' || race.phase === 'racing' || race.phase === 'launch'));
  });
  await page.evaluate(() => {
    const race = window.getActiveRace();
    if (race && race.phase !== 'racing' && typeof race._applyLaunch === 'function') {
      race._applyLaunch();
    }
    const cd = document.getElementById('countdownOverlay');
    if (cd) cd.style.display = 'none';
  });
  await page.waitForFunction(() => {
    const race = window.getActiveRace();
    return !!(race && race.phase === 'racing');
  });
}

export async function completeLaps(page, { kartIndex = 0, laps = 1 } = {}) {
  const result = await page.evaluate(({ kartIndex, laps }) => {
    const race = window.getActiveRace();
    if (!race) throw new Error('no active race');
    const kart = race.karts[kartIndex];
    const track = race.track;
    const cps = track && track.cpLines;
    if (!kart || !cps || !cps.length) throw new Error('missing kart or checkpoints');
    const before = kart.lapTimes.length;

    function cross(line) {
      const mx = (line.x1 + line.x2) / 2;
      const my = (line.y1 + line.y2) / 2;
      const dx = line.x2 - line.x1;
      const dy = line.y2 - line.y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      kart.prevX = mx - nx * 36;
      kart.prevY = my - ny * 36;
      kart.x = mx + nx * 36;
      kart.y = my + ny * 36;
      kart.checkCheckpoints(track);
    }

    for (let n = 0; n < laps; n++) {
      if (kart.lapStart == null) cross(cps[0]);
      for (let i = 1; i < cps.length; i++) cross(cps[i]);
      cross(cps[0]);
    }

    // Keep medal payouts out of behavioural reward asserts (instant laps would be gold).
    kart.bestLap = 99;
    kart.lapTimes = kart.lapTimes.map(() => 99);
    if (kart.finished) kart.finishTime = kart.lapTimes.reduce((a, b) => a + b, 0);

    return {
      before,
      after: kart.lapTimes.length,
      finished: !!kart.finished,
      nextCp: kart.nextCp,
    };
  }, { kartIndex, laps });

  if (result.after < result.before + laps) {
    throw new Error(`expected ${laps} more lap(s), got ${JSON.stringify(result)}`);
  }
  return result;
}

export async function finishRemainingField(page) {
  await page.evaluate(() => {
    const race = window.getActiveRace();
    if (!race) throw new Error('no active race');
    const human = race.karts[0];
    const humanTime = Number.isFinite(human && human.finishTime) ? human.finishTime : 90;
    race.karts.forEach((k, i) => {
      if (i === 0) return;
      k.finished = true;
      k.finishTime = humanTime + 8 + i;
      k.lapTimes = k.lapTimes && k.lapTimes.length ? k.lapTimes : [k.finishTime];
      k.finishOrder = race._nextFinishOrder++;
    });
    race.phase = 'finished';
    race.resultsShown = true;
    race.showResults();
  });
}

export async function endSession(page) {
  await page.locator('#race-ctrl-exit').click();
}

export async function expectResults(page, title) {
  await expect(page.locator('#screen-results')).toBeVisible();
  await expect(page.locator('#results-title')).toContainText(title);
}

export async function readPlayerSave(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('kartblitz_player') || 'null');
    } catch (e) {
      return null;
    }
  });
}

export async function rndSnapshotValid(page) {
  return page.evaluate(() => {
    const race = window.getActiveRace();
    const snap = window.KartBlitzRnD.snapshotRaceForRnD(race);
    return {
      snap,
      valid: window.KartBlitzRnD.isValidRnDCompletion(snap),
    };
  });
}

export async function assertNoMajorHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      clientWidth: doc.clientWidth,
      scrollWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
    };
  });
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 2);
}

export async function expectMostlyInViewport(locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const vp = locator.page().viewportSize();
  expect(box).toBeTruthy();
  expect(vp).toBeTruthy();
  expect(box.width).toBeGreaterThan(8);
  expect(box.height).toBeGreaterThan(8);
  expect(box.x + box.width).toBeGreaterThan(8);
  expect(box.x).toBeLessThan(vp.width - 8);
  expect(box.y + Math.min(box.height, 24)).toBeGreaterThan(0);
  expect(box.y).toBeLessThan(vp.height);
}

export async function tabUntilLocatorFocused(page, locator, maxTabs = 90) {
  for (let i = 0; i < maxTabs; i++) {
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) {
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error('keyboard focus never reached the target control');
}
