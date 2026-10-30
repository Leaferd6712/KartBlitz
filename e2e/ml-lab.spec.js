import { test, expect, gotoGame, dismissOnboarding, returningPlayerStorage, waitForMenu } from './fixtures/game.js';

test('README ML Lab entry launches a race and returns to the lab', async ({ page }) => {
  await gotoGame(page, { path: '/index.html?tool=ml' });
  await expect(page.locator('#screen-ml-lab')).toBeVisible();
  await expect(page.locator('#welcome-dialog')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'ML LAB' })).toBeVisible();
  await expect(page.locator('.ml-tab')).toHaveCount(5);

  await page.getByRole('button', { name: '5 / RACE' }).click();
  await expect(page.getByText('OUR MODEL', { exact: true })).toBeVisible();
  await expect(page.getByText('YOUR MODEL', { exact: true })).toBeVisible();
  await expect(page.locator('#ml-select-player')).toBeDisabled();
  await page.getByRole('button', { name: 'RACE SELECTED MODEL' }).click();

  await page.waitForFunction(() => {
    const race = window.getActiveRace && window.getActiveRace();
    return !!(race && race.mode === 'ai' && race.karts[1] && race.karts[1]._mlLabDriver);
  });
  const state = await page.evaluate(() => {
    const race = window.getActiveRace();
    return {
      model: race.karts[1].mlModelName,
      driver: race.karts[1]._mlLabDriver,
      consumed: window._mlRaceConfig === null,
      opponents: race.karts.length - 1,
    };
  });
  expect(state.driver).toBe(true);
  expect(state.model).toBe('KartBlitz Pre-Tuned Driver');
  expect(state.consumed).toBe(true);
  expect(state.opponents).toBe(1);
  await page.evaluate(() => returnToMainMenu());
  await expect(page.locator('#screen-ml-lab')).toBeVisible();
});

test('ML Lab does not fabricate checkpoint playback without a trained model', async ({ page }) => {
  await gotoGame(page, { path: '/index.html?tool=ml' });
  await expect(page.locator('#screen-ml-lab')).toBeVisible();
  await expect(page.locator('#welcome-dialog')).toBeHidden();
  await page.getByRole('button', { name: '4 / WATCH' }).click();
  await expect(page.locator('#ml-replay-label')).toHaveText(/NO CHECKPOINT DATA/);
  await expect(page.getByText('No evaluation report is loaded.')).toBeVisible();
});

test('ML Lab teaches through prediction, reward experiments, and training stages', async ({ page }) => {
  await gotoGame(page, { path: '/index.html?tool=ml' });
  await expect(page.locator('#screen-ml-lab')).toBeVisible();
  await expect(page.locator('#welcome-dialog')).toBeHidden();

  await page.getByRole('combobox', { name: 'Situation' }).selectOption('fastLeft');
  await page.getByRole('button', { name: 'LEFT', exact: true }).click();
  await page.getByRole('button', { name: 'BRAKE', exact: true }).click();
  await page.getByRole('button', { name: 'CHECK MY DECISION' }).click();
  await expect(page.getByText('2/2 matched the safe teacher.')).toBeVisible();

  await page.getByRole('button', { name: '2 / BUILD' }).click();
  await page.getByRole('slider', { name: /Forward movement/ }).fill('0');
  await page.getByRole('checkbox', { name: 'Off track' }).check();
  await expect(page.locator('#ml-reward-total')).toContainText('-0.040');

  await page.getByRole('button', { name: '3 / TRAIN' }).click();
  await expect(page.getByText('READ THIS / TRAINING LOOP')).toBeVisible();
  await expect(page.getByText('DO NOW / GPU LAPTOP')).toBeVisible();
  await expect(page.locator('#ml-command-install')).toHaveText('powershell -ExecutionPolicy Bypass -File .\\ml_training\\install.ps1');
  await expect(page.locator('#ml-command-start')).toHaveText('powershell -ExecutionPolicy Bypass -File .\\ml_training\\start.ps1');
  await expect(page.getByRole('button', { name: 'COPY' })).toHaveCount(2);
  await page.getByRole('button', { name: /4 UPDATE/ }).click();
  await expect(page.locator('#ml-phase-explanation')).toContainText('Reinforcement learning with PPO (90%)');
  await expect(page.locator('#ml-run-explain')).toContainText('300,000');
  await expect(page.locator('#ml-run-explain')).toContainText('2,700,000');
  await expect(page.locator('#ml-run-explain')).toContainText('12,288 RL experiences');
});

test('normal play has no tool links even with old ML and debug preferences', async ({ page }) => {
  const labRequests = [];
  page.on('request', request => { if (/\/ml\//.test(request.url())) labRequests.push(request.url()); });
  await page.route('**/api/leaderboard?**', route => route.fulfill({ json: { scores: [{ username: 'RACER', bestLap: 40, trustLevel: 'verified', hasGhost: true, verifiedRunId: 'verified-run-123456' }] } }));
  await gotoGame(page, { storage: returningPlayerStorage({ kartblitz_ml_lab_enabled: '1', kartblitz_debugoverlay: '1' }) });
  await dismissOnboarding(page);
  await waitForMenu(page);
  await page.locator('#menu-tools summary').click();
  await expect(page.getByRole('button', { name: 'What’s new' })).toBeVisible();
  await expect(page.locator('#btn-admin, #ml-lab-menu-btn')).toHaveCount(0);
  await page.getByRole('button', { name: 'CONTROLS & SETTINGS' }).click();
  await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
  await expect(page.locator('.advanced-tools, .ml-settings-row')).toHaveCount(0);
  await page.getByRole('button', { name: /back/i }).click();
  await page.getByRole('button', { name: 'LEADERBOARD', exact: true }).click();
  await expect(page.getByRole('button', { name: 'RACE GHOST', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'USE FOR ML' })).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.KartBlitzMLLab)).toBe('undefined');
  expect(labRequests).toEqual([]);
  await page.evaluate(() => showScreen('menu'));
  await page.locator('#quick-race-btn').click();
  await page.waitForFunction(() => getActiveRace()?.mode === 'ai');
  await page.keyboard.press('F9');
  expect(await page.evaluate(() => _showDebugOverlay)).toBe(false);
});

test('ML Lab imports verified laps from its own Build panel', async ({ page }) => {
  const runId = 'verified-run-123456';
  await page.route('**/api/leaderboard?**', route => route.fulfill({ json: { scores: [{ username: 'RACER', bestLap: 40, hasGhost: true, verifiedRunId: runId }] } }));
  const frames = Array.from({ length: 45 }, (_, i) => [i * 67, 10000 + i * 20, 20000, 0, 2500, 1, 0, 900, 1, 1000]);
  await page.route('**/api/ghost?**', route => route.fulfill({ json: { ok: true, runId, username: 'RACER', rank: 1, trackId: 0, ghost: { v: 1, trackId: 0, lapTime: 40, sampleRateHz: 15, maxSpeed: 362, frames } } }));
  await gotoGame(page, { path: '/index.html?tool=ml' });
  await expect(page.locator('#screen-ml-lab')).toBeVisible();
  await page.getByRole('button', { name: '2 / BUILD' }).click();
  await page.getByRole('button', { name: 'LOAD VERIFIED LAPS' }).click();
  await page.getByRole('button', { name: /USE FOR ML: RACER/ }).click();
  await expect(page.locator('#ml-demo-status')).toContainText('1 verified top-10 ghost');
  await expect(page.locator('#ml-leaderboard-status')).toContainText('Replay imported');
  await page.getByRole('button', { name: /back/i }).click();
  await expect(page).toHaveURL(/\/index.html$/);
  await waitForMenu(page);
  expect(await page.evaluate(() => typeof window.KartBlitzMLLab)).toBe('undefined');
});

test('direct track editor entry still asks for the admin password', async ({ page }) => {
  await gotoGame(page, { path: '/index.html?admin=track' });
  await expect(page.locator('#te-pass-modal')).toHaveClass(/open/);
  await expect(page.locator('#welcome-dialog')).toBeHidden();
  await expect(page.locator('#te-pass-input')).toBeVisible();
});
