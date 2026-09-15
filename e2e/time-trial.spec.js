import {
  test,
  expect,
  gotoGame,
  dismissOnboarding,
  waitForMenu,
  startTimeTrial,
  confirmStartTyres,
  completeLaps,
  endSession,
  expectResults,
  rndSnapshotValid,
} from './fixtures/game.js';

test.describe('Time Trial', () => {
  test.beforeEach(async ({ page }) => {
    await gotoGame(page);
    await dismissOnboarding(page);
    await waitForMenu(page);
  });

  test('choose track, setup, tyres, complete a lap, results, then restart', async ({ page }) => {
    await startTimeTrial(page);
    await confirmStartTyres(page, /MED/);

    const laps = await completeLaps(page, { laps: 1 });
    expect(laps.after).toBeGreaterThanOrEqual(1);
    const rnd = await rndSnapshotValid(page);
    expect(rnd.valid).toBe(true);

    await endSession(page);
    await expectResults(page, /TIME TRIAL/);
    await expect(page.locator('#results-wrap')).toContainText(/LAPS COMPLETED/);
    await expect(page.locator('#results-wrap')).toContainText('1');
    await expect(page.locator('#coins-earned-display')).toContainText(/RACE|lap/i);

    await page.locator('#screen-results').getByRole('button', { name: /RACE AGAIN/ }).click();
    await expect(page.locator('#gameCanvas')).toBeVisible();
    await expect(page.locator('#pit-ui-overlay')).toBeHidden();
    await page.waitForFunction(() => {
      const race = window.getActiveRace();
      return !!(race && race.mode === 'trial' && race.phase === 'racing');
    });
  });

  test('exit with zero laps shows results and no race pay', async ({ page }) => {
    await startTimeTrial(page);
    await confirmStartTyres(page, /SOFT/);

    const rnd = await rndSnapshotValid(page);
    expect(rnd.valid).toBe(false);
    expect(rnd.snap.completedLaps || 0).toBe(0);

    await endSession(page);
    await expectResults(page, /TIME TRIAL/);
    await expect(page.locator('#results-wrap')).toContainText(/LAPS COMPLETED/);
    await expect(page.locator('#results-wrap')).toContainText('0');
    await expect(page.locator('#coins-earned-display')).toBeEmpty();
  });
});
