import {
  test,
  expect,
  gotoGame,
  dismissOnboarding,
  waitForMenu,
  startVersusRace,
  skipCountdown,
  completeLaps,
  finishRemainingField,
  expectResults,
} from './fixtures/game.js';

test.describe('Versus', () => {
  test('start, complete laps, and show lap-based rewards', async ({ page }) => {
    await gotoGame(page);
    await dismissOnboarding(page);
    await waitForMenu(page);

    await startVersusRace(page, { laps: 1 });
    await skipCountdown(page);
    await completeLaps(page, { kartIndex: 0, laps: 1 });
    await completeLaps(page, { kartIndex: 1, laps: 1 });
    await finishRemainingField(page);

    await expectResults(page, 'VERSUS RESULTS');
    await expect(page.locator('#results-wrap')).toContainText('LAPS DONE');
    await expect(page.locator('#results-wrap')).toContainText('1/1');
    await expect(page.locator('#coins-earned-display')).toContainText(/laps? × 5/i);
    await expect(page.locator('#coins-earned-display')).toContainText(/Participation/);
  });
});
