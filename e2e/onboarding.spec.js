import { test, expect, gotoGame, dismissOnboarding, waitForMenu } from './fixtures/game.js';

test.describe('Onboarding', () => {
  test('clean first launch welcomes players with optional control choice', async ({ page }) => {
    await gotoGame(page);

    await expect(page.locator('#welcome-dialog')).toBeVisible();
    await expect(page.locator('#patch-notes-overlay')).toBeHidden();
    await expect(page.locator('#device-prompt')).toBeHidden();
    await expect(page.getByRole('button', { name: 'LET’S GO' })).toBeVisible();
  });

  test('welcome completes directly onto the main menu and persists', async ({ page }) => {
    await gotoGame(page);
    await page.getByRole('button', { name: 'LET’S GO' }).click();

    await expect(page.locator('#patch-notes-overlay.open')).toHaveCount(0);
    await expect(page.locator('#welcome-dialog')).toBeHidden();

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
