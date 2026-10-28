import {
  test,
  expect,
  gotoGame,
  waitForMenu,
  returningPlayerStorage,
  assertNoMajorHorizontalOverflow,
  expectMostlyInViewport,
} from './fixtures/game.js';

const RETURNING_PLAYER = returningPlayerStorage();

async function expectHiddenScreensStayHidden(page, visibleId) {
  const visibleScreens = await page.locator('.screen').evaluateAll((screens) => screens
    .filter((screen) => getComputedStyle(screen).display !== 'none')
    .map((screen) => screen.id));
  expect(visibleScreens).toEqual([visibleId]);
}

test('theme loads and required lobby navigation remains intact', async ({ page }) => {
  await gotoGame(page, { storage: RETURNING_PLAYER });
  await waitForMenu(page);

  await expect(page.locator('body')).toHaveClass(/\bkb-ui\b/);
  await expect(page.locator('link[href="ui/base.css"]')).toHaveCount(1);
  await expect(page.locator('link[href="ui/kartblitz.css"]')).toHaveCount(1);
  await expect(page.locator('.menu-actions .btn-cyan')).toHaveText(/TIME TRIAL/);
  await expect(page.locator('.menu-actions .menu-secondary-action')).toHaveCount(5);
  await expectHiddenScreensStayHidden(page, 'screen-menu');

  await page.getByRole('button', { name: /CUSTOM RACE/ }).click();
  await expectHiddenScreensStayHidden(page, 'screen-mode');
  await page.getByRole('button', { name: /Online Lobby/ }).click();
  await expectHiddenScreensStayHidden(page, 'screen-online');

  for (const id of ['online-status', 'online-room-status', 'online-join-status']) {
    const status = page.locator(`#${id}`);
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveAttribute('aria-atomic', 'true');
  }
  await expect(page.locator('#online-track-select')).toHaveAttribute('aria-label', 'Circuit');
  await expect(page.locator('#online-laps-select')).toHaveAttribute('aria-label', 'Laps');
  await expect(page.locator('#online-weather-select')).toHaveAttribute('aria-label', 'Weather');
  await expect(page.locator('#online-collision-select')).toHaveAttribute('aria-label', 'Collisions');

  await page.locator('#screen-online').getByRole('button', { name: 'Back' }).click();
  await expectHiddenScreensStayHidden(page, 'screen-mode');
  await page.locator('#screen-mode').getByRole('button', { name: 'Back' }).click();
  await expectHiddenScreensStayHidden(page, 'screen-menu');
});

for (const viewport of [
  { name: 'desktop 1440x900', width: 1440, height: 900 },
  { name: 'portrait 390x844', width: 390, height: 844 },
  { name: 'landscape 844x390', width: 844, height: 390 },
]) {
  test(`${viewport.name} keeps the primary controls reachable without major overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await gotoGame(page, { storage: RETURNING_PLAYER });
    await waitForMenu(page);

    await expectMostlyInViewport(page.locator('.menu-actions .btn-cyan'));
    await expect(page.locator('.menu-panel-sub')).toBeVisible();
    await expect(page.locator('.menu-utility-card')).toBeVisible();
    await assertNoMajorHorizontalOverflow(page);
    await expectHiddenScreensStayHidden(page, 'screen-menu');
  });
}

test('reduced-motion preferences and the in-game setting suppress motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoGame(page, { storage: RETURNING_PLAYER });
  await waitForMenu(page);

  const mediaDuration = await page.locator('.menu-actions .btn-cyan').evaluate((button) =>
    getComputedStyle(button).transitionDuration);
  expect(parseFloat(mediaDuration)).toBeLessThanOrEqual(0.001);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('html').evaluate((html) => { html.dataset.reducedMotion = '1'; });
  const settingDuration = await page.locator('.menu-actions .btn-cyan').evaluate((button) =>
    getComputedStyle(button).transitionDuration);
  expect(parseFloat(settingDuration)).toBeLessThanOrEqual(0.001);
});

test('preview marker appears only when explicitly requested', async ({ page }) => {
  await gotoGame(page, { storage: RETURNING_PLAYER, path: '/?uiPreview=1' });
  await expect(page.locator('#kb-ui-preview-marker')).toHaveText('UI PREVIEW · testing-ui-extra');

  await page.goto('/');
  await page.waitForFunction(() => window.KartBlitzProgramme && typeof window.getActiveRace === 'function');
  await expect(page.locator('#kb-ui-preview-marker')).toHaveCount(0);
});
