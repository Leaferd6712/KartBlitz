import { test, expect, gotoGame, dismissOnboarding, returningPlayerStorage, waitForMenu } from './fixtures/game.js';

test('ML Lab is opt-in and launches a race with the selected model weights', async ({ page }) => {
  await gotoGame(page, { storage: returningPlayerStorage({ kartblitz_ml_lab_enabled: '1' }) });
  await dismissOnboarding(page);
  await waitForMenu(page);

  const labButton = page.getByRole('button', { name: /ML LAB/ });
  await expect(labButton).toBeVisible();
  await labButton.click();
  await expect(page.locator('#screen-ml-lab')).toBeVisible();
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
  expect(state.model).toMatch(/KartBlitz Apex/);
  expect(state.consumed).toBe(true);
  expect(state.opponents).toBe(1);
});

test('ML Lab does not fabricate checkpoint playback without a trained model', async ({ page }) => {
  await gotoGame(page, { storage: returningPlayerStorage({ kartblitz_ml_lab_enabled: '1' }) });
  await dismissOnboarding(page);
  await waitForMenu(page);
  await page.getByRole('button', { name: /ML LAB/ }).click();
  await page.getByRole('button', { name: '4 / WATCH' }).click();
  await expect(page.locator('#ml-replay-label')).toHaveText(/NO CHECKPOINT DATA/);
  await expect(page.getByText('No evaluation report is loaded.')).toBeVisible();
});

test('ML Lab teaches through prediction, reward experiments, and training stages', async ({ page }) => {
  await gotoGame(page, { storage: returningPlayerStorage({ kartblitz_ml_lab_enabled: '1' }) });
  await dismissOnboarding(page);
  await waitForMenu(page);
  await page.getByRole('button', { name: /ML LAB/ }).click();

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
  await expect(page.locator('#ml-phase-explanation')).toContainText('Update carefully with PPO');
  await expect(page.locator('#ml-run-explain')).toContainText('300,000');
  await expect(page.locator('#ml-run-explain')).toContainText('2,700,000');
  await expect(page.locator('#ml-run-explain')).toContainText('12,288 RL experiences');
});

test('ML Lab stays hidden when the setting is disabled', async ({ page }) => {
  await gotoGame(page, { storage: returningPlayerStorage({ kartblitz_ml_lab_enabled: '0' }) });
  await dismissOnboarding(page);
  await waitForMenu(page);
  await expect(page.locator('#ml-lab-menu-btn')).toBeHidden();
});
