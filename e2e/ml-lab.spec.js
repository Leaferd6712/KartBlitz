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

  await page.getByRole('button', { name: /5 · RACE/ }).click();
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

test('ML Lab stays hidden when the setting is disabled', async ({ page }) => {
  await gotoGame(page, { storage: returningPlayerStorage({ kartblitz_ml_lab_enabled: '0' }) });
  await dismissOnboarding(page);
  await waitForMenu(page);
  await expect(page.locator('#ml-lab-menu-btn')).toBeHidden();
});
