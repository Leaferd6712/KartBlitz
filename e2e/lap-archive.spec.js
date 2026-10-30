import { test, expect, gotoGame, returningPlayerStorage, dismissOnboarding, startTimeTrial, confirmStartTyres } from './fixtures/game.js';

async function boot(page) {
  await gotoGame(page, { storage: returningPlayerStorage() });
  await dismissOnboarding(page);
  await page.waitForFunction(() => window.KartBlitzLapArchive && window.KartBlitzLapReplay);
}
async function completeRecordedLap(page, mode = 'trial', slot = 0) {
  return page.evaluate(({ mode, slot }) => {
    const make = id => ({ id, x: 100, y: 100, angle: 0, speed: 100, lapStart: performance.now() - 40000,
      lapTimes: [], ersCharge: .8, grip: 1, _lapKind: 'outlap', getInput: () => ({ throttle: .7, steer: .2 }) });
    const kart = make(slot), karts = slot ? [make(0), kart] : [kart];
    const race = { mode, phase: 'racing', weather: 'dry', track: TRACKS[0], karts };
    KartBlitzLapArchive.capture(race);
    kart.x += 100;
    kart.lapTimes.push((performance.now() - kart.lapStart) / 1000);
    kart.finished = true;
    KartBlitzLapArchive.capture(race);
  }, { mode, slot });
}

test('every offline player mode uploads completed laps and preserves player two', async ({ page }) => {
  const records = [];
  await page.route('**/api/lap-recordings', async route => {
    const data = route.request().postDataJSON(); records.push(data);
    await route.fulfill({ json: { ok: true, archived: true, id: data.id } });
  });
  await boot(page);
  for (const mode of ['trial','ai','shootout','versus']) await completeRecordedLap(page, mode, mode === 'versus' ? 1 : 0);
  await expect.poll(() => records.length).toBe(4);
  expect(new Set(records.map(item => item.mode))).toEqual(new Set(['trial','ai','shootout','versus']));
  expect(records.find(item => item.mode === 'versus').playerSlot).toBe(1);
  expect(records[0].ghost.recording.controlEvents[0][2]).toBe(.7);
  expect(records[0].ghost.trackSnapshot.spline.length).toBeGreaterThan(100);
});

test('an upload failure survives reload and is retried from IndexedDB', async ({ page }) => {
  let original;
  await page.route('**/api/lap-recordings', async route => { original = route.request().postDataJSON(); await route.abort(); });
  await boot(page);
  await completeRecordedLap(page);
  await expect.poll(() => !!original).toBe(true);
  const id = original.id;
  await page.unroute('**/api/lap-recordings');
  const retried = [];
  await page.route('**/api/lap-recordings', async route => {
    const record = route.request().postDataJSON(); retried.push(record);
    await route.fulfill({ json: { ok: true, archived: true, id: record.id } });
  });
  await page.reload();
  await expect.poll(() => retried.map(item => item.id)).toContain(id);
});

test('the initial Time Trial out-lap has a timer immediately after tyre confirmation', async ({ page }) => {
  await page.route('**/api/lap-recordings', route => route.fulfill({ json: { ok: true, archived: true } }));
  await boot(page);
  await startTimeTrial(page);
  await confirmStartTyres(page);
  expect(await page.evaluate(() => {
    const kart = getActiveRace().karts[0];
    return { timed: Number.isFinite(kart.lapStart), kind: kart._lapKind, nextCp: kart.nextCp };
  })).toEqual({ timed: true, kind: 'outlap', nextCp: 1 });
});

test('an archived file opens without publishing it as a verified leaderboard lap', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'LEADERBOARD', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'OPEN REPLAY FILE' }).click();
  const frames = Array.from({ length: 20 }, (_, i) => [i * 1000, 10000 + i * 10, 20000, 0, 1000, 1, 0, 800, 0, 1000, .2, .7, 0]);
  await (await chooser).setFiles({ name: 'lap.replay.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    format: 'kartblitz-lap-replay-v1', runId: 'archive-file-12345678', source: 'client-recorded', username: 'RACER', mode: 'ai', lapKind: 'outlap', trackId: 0,
    ghost: { v: 1, recordingVersion: 3, trackId: 0, lapTime: 19, sampleRateHz: 1, frames, recording: {} },
  })) });
  await expect(page.locator('#lap-replay-content')).toBeVisible();
  await expect(page.locator('#lap-replay-detail')).toContainText('player recording (not server-verified)');
  await expect(page.locator('#lap-replay-race')).toBeHidden();
  await page.locator('#lap-replay-seek').fill('10');
  await expect(page.locator('#lap-replay-time')).toHaveText('0:10.000 / 0:19.000');
});
