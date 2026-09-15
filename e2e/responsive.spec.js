import {
  test,
  expect,
  gotoGame,
  dismissOnboarding,
  waitForMenu,
  pickFirstTrack,
  assertNoMajorHorizontalOverflow,
  expectMostlyInViewport,
} from './fixtures/game.js';

const LANDSCAPE = { width: 844, height: 390 };

test.describe('Responsive 844x390', () => {
  test.use({ viewport: LANDSCAPE });

  test('main menu primary CTA is in view without major overflow', async ({ page }) => {
    await gotoGame(page);
    await dismissOnboarding(page);
    await waitForMenu(page);

    await expectMostlyInViewport(page.locator('.menu-actions .btn-cyan').first());
    await assertNoMajorHorizontalOverflow(page);
  });

  test('setup Start Session is in view without major overflow', async ({ page }) => {
    await gotoGame(page);
    await dismissOnboarding(page);
    await waitForMenu(page);

    await page.getByRole('button', { name: /TIME TRIAL/ }).click();
    await pickFirstTrack(page);
    await expect(page.locator('#screen-setup')).toBeVisible();
    await expect(page.locator('#setup-start-btn')).toHaveText(/START SESSION/);

    await expectMostlyInViewport(page.locator('#setup-start-btn'));
    await assertNoMajorHorizontalOverflow(page);
  });
});
