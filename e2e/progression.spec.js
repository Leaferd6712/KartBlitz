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
  readPlayerSave,
  playerSaveJson,
  returningPlayerStorage,
} from './fixtures/game.js';

test.describe('Progression', () => {
  test('purchase upgrade; valid race pays; invalid exit does not; save reloads', async ({ page }) => {
    await gotoGame(page, {
      storage: returningPlayerStorage({
        kartblitz_player: playerSaveJson({ coins: 500 }),
      }),
    });
    await waitForMenu(page);

    await page.getByRole('button', { name: /GARAGE/ }).click();
    await expect(page.locator('#screen-garage')).toBeVisible();
    await page.getByRole('button', { name: 'UPGRADES' }).click();

    const unlock = page.getByRole('button', { name: /UNLOCK · 160 COINS/ }).first();
    await expect(unlock).toBeEnabled();
    await unlock.click();
    await expect(page.locator('#garage-content')).toContainText('PACKAGE LIVE');

    let save = await readPlayerSave(page);
    expect(save.programme.nodes['pt-intake']).toBe(true);
    expect(save.coins).toBe(340);

    await page.locator('#screen-garage .back-btn').click();
    await waitForMenu(page);

    const coinsAfterPurchase = save.coins;

    await startTimeTrial(page);
    await confirmStartTyres(page);
    const zeroLap = await rndSnapshotValid(page);
    expect(zeroLap.valid).toBe(false);
    await endSession(page);
    await expectResults(page, /TIME TRIAL/);
    await expect(page.locator('#results-wrap')).toContainText('0');
    await expect(page.locator('#coins-earned-display')).toBeEmpty();

    save = await readPlayerSave(page);
    expect(save.coins).toBe(coinsAfterPurchase);
    expect(save.programme.nodes['pt-intake']).toBe(true);

    await page.locator('#screen-results').getByRole('button', { name: /MAIN MENU/ }).click();
    await waitForMenu(page);

    await startTimeTrial(page);
    await confirmStartTyres(page);
    await completeLaps(page, { laps: 1 });
    const validLap = await rndSnapshotValid(page);
    expect(validLap.valid).toBe(true);
    await endSession(page);
    await expectResults(page, /TIME TRIAL/);
    await expect(page.locator('#coins-earned-display')).toContainText(/RACE|lap/i);

    save = await readPlayerSave(page);
    expect(save.coins).toBeGreaterThan(coinsAfterPurchase);
    expect(save.programme.nodes['pt-intake']).toBe(true);
    const coinsAfterValid = save.coins;

    await page.reload();
    await page.waitForFunction(() => window.KartBlitzProgramme && window.KartBlitzSave);
    await waitForMenu(page);

    save = await readPlayerSave(page);
    expect(save.programme.nodes['pt-intake']).toBe(true);
    expect(save.coins).toBe(coinsAfterValid);
  });
});
