import { test, expect, gotoGame, dismissOnboarding, waitForMenu } from './fixtures/game.js';

test.describe('Onboarding', () => {
  test('clean first launch shows patch notes before device selection', async ({ page }) => {
    await gotoGame(page);

    await expect(page.locator('#patch-notes-overlay')).toHaveClass(/open/);
    await expect(page.locator('#device-prompt')).toBeHidden();
    await expect(page.getByRole('button', { name: 'GOT IT' })).toBeVisible();
  });

  test('GOT IT then device choice completes onboarding onto the main menu', async ({ page }) => {
    await gotoGame(page);
    await page.getByRole('button', { name: 'GOT IT' }).click();

    await expect(page.locator('#patch-notes-overlay.open')).toHaveCount(0);
    await expect(page.locator('#device-prompt')).toBeVisible();
    await page.getByRole('button', { name: 'KEYBOARD ONLY' }).click();

    await expect(page.locator('#device-prompt')).toBeHidden();
    await waitForMenu(page);
  });

  test('returning player skips patch notes and device prompt', async ({ page }) => {
    await gotoGame(page);
    await dismissOnboarding(page);
    await waitForMenu(page);

    await page.reload();
    await page.waitForFunction(() => window.KartBlitzProgramme && window.KartBlitzRewards);

    await expect(page.locator('#patch-notes-overlay.open')).toHaveCount(0);
    await expect(page.locator('#device-prompt')).toBeHidden();
    await waitForMenu(page);
  });
});
