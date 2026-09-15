import {
  test,
  expect,
  gotoGame,
  dismissOnboarding,
  waitForMenu,
  tabUntilLocatorFocused,
} from './fixtures/game.js';

test.describe('Accessibility', () => {
  test('keyboard navigation reaches major menu actions', async ({ page }) => {
    await gotoGame(page);
    await dismissOnboarding(page);
    await waitForMenu(page);

    const timeTrial = page.locator('.menu-actions').getByRole('button', { name: /TIME TRIAL/ });
    const customRace = page.locator('.menu-actions').getByRole('button', { name: /CUSTOM RACE/ });
    const garage = page.locator('.menu-actions').getByRole('button', { name: /GARAGE/ });

    await tabUntilLocatorFocused(page, timeTrial);
    await expect(timeTrial).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#screen-track')).toBeVisible();
    await page.locator('#screen-track').getByRole('button', { name: 'Back' }).click();
    await waitForMenu(page);

    await timeTrial.focus();
    await page.keyboard.press('Tab');
    await expect(customRace).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#screen-mode')).toBeVisible();
    await page.locator('#screen-mode').getByRole('button', { name: 'Back' }).click();
    await waitForMenu(page);

    await customRace.focus();
    await page.keyboard.press('Tab');
    await expect(garage).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#screen-garage')).toBeVisible();
  });
});
