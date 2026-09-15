import {
  test,
  expect,
  gotoGame,
  dismissOnboarding,
  waitForMenu,
  startAiRace,
  skipCountdown,
  completeLaps,
  finishRemainingField,
  expectResults,
} from './fixtures/game.js';

test.describe('AI Race', () => {
  test('start, finish, result mode, and finishing-position reward', async ({ page }) => {
    await gotoGame(page);
    await dismissOnboarding(page);
    await waitForMenu(page);

    await startAiRace(page, { laps: 1, opponents: 1 });
    await skipCountdown(page);
    await completeLaps(page, { kartIndex: 0, laps: 1 });
    await finishRemainingField(page);

    await expectResults(page, 'AI RACE RESULTS');
    await expect(page.locator('#results-wrap')).toContainText(/YOUR POSITION/);
    await expect(page.locator('#results-wrap')).toContainText(/P1/);
    await expect(page.locator('#coins-earned-display')).toContainText(/Place P1/);
    await expect(page.locator('#coins-earned-display')).toContainText(/Finish bonus/);
  });
});
