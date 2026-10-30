import { readFileSync } from 'node:fs';
import { test, expect, gotoGame, returningPlayerStorage, dismissOnboarding } from './fixtures/game.js';

const bakes = JSON.parse(readFileSync(new URL('../sim/tracks/bakes.json', import.meta.url), 'utf8'));
const track = (Array.isArray(bakes.tracks) ? bakes.tracks : Object.values(bakes.tracks))[0];
const runId = 'recorded-lap-12345678';
function replay({ legacy = false, incomplete = false } = {}) {
  const lapTime = 40;
  const frames = Array.from({ length: 301 }, (_, i) => {
    const point = track.spline[Math.floor(i / 300 * track.spline.length) % track.spline.length];
    const next = track.spline[(Math.floor(i / 300 * track.spline.length) + 1) % track.spline.length];
    return [Math.round(i / 300 * lapTime * 1000), Math.round(point.x * 10), Math.round(point.y * 10),
      Math.round(Math.atan2(next.y - point.y, next.x - point.x) * 1000), 2000, i < 100 ? 1 : i < 200 ? 6 : 0, i === 150 ? 1 : 0, 750, 0, 1000];
  });
  return { ok: true, runId, username: 'RECORDER', rank: 12, trackId: track.id, bestLap: lapTime,
    ghost: { v: 1, recordingVersion: legacy ? undefined : 2, trackId: track.id, lapTime, sampleRateHz: 15, maxSpeed: 362,
      frames: incomplete ? frames.slice(0, 40) : frames,
      ...(!legacy && { trackSnapshot: track, recording: { inputEncoding: 'digital-flags-base64-v1', inputsBase64: 'AQEBAQ==', physicsHz: 60, lapStartStep: 1, lapEndStep: 4, weather: 'dry', tyres: 'med', carConfig: 'stock' } }) } };
}

async function board(page, options = {}) {
  const entries = Array.from({ length: 11 }, (_, i) => ({ username: `LEGACY${i}`, bestLap: 20 + i, trustLevel: i ? 'legacy' : 'verified' }));
  entries.push({ username: 'RECORDER', bestLap: 40, trustLevel: 'verified', hasGhost: true, verifiedRunId: runId, recordingVersion: options.legacy ? 0 : 2 });
  await page.route('**/api/leaderboard?**', route => route.fulfill({ json: { ok: true, scores: entries } }));
  await page.route('**/api/ghost?**', route => options.failed ? route.fulfill({ status: 404, json: { error: 'ghost_not_found' } }) : route.fulfill({ json: replay(options) }));
  await gotoGame(page, { storage: returningPlayerStorage() });
  await dismissOnboarding(page);
  await page.getByRole('button', { name: 'LEADERBOARD', exact: true }).click();
  await expect(page.locator('.lb-row')).toHaveCount(12);
}

test('a recorded time below the top ten opens synchronized playback and line inspection', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await board(page);
  await expect(page.locator('.lb-row').first()).toContainText('LEGACY');
  await expect(page.locator('.lb-row').last()).not.toContainText('LEGACY');
  const watch = page.getByRole('button', { name: /^Watch RECORDER lap/ });
  await watch.click();
  const dialog = page.getByRole('dialog', { name: /RECORDER/ });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#lap-replay-content')).toBeVisible();
  await expect(page.locator('#lap-replay-speed')).toHaveText('160 KM/H');
  await page.locator('#lap-replay-seek').fill('20');
  await expect(page.locator('#lap-replay-time')).toHaveText('0:20.000 / 0:40.000');
  await expect(page.locator('#lap-replay-pedals')).toHaveText('BRAKE');
  await expect(page.locator('#lap-replay-steer')).toHaveText('LEFT');
  await expect(page.locator('#lap-replay-surface')).toHaveText('OFF TRACK');
  await page.locator('#lap-replay-rate').selectOption('4');
  await page.locator('#lap-replay-play').click();
  await expect(page.locator('#lap-replay-play')).toHaveText('PAUSE');
  await expect.poll(async () => Number(await page.locator('#lap-replay-seek').inputValue())).toBeGreaterThan(20.2);
  await page.locator('#lap-replay-play').click();
  const paused = await page.locator('#lap-replay-seek').inputValue();
  await page.locator('#lap-replay-map').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await page.locator('#lap-replay-seek').inputValue())).toBeCloseTo(Number(paused) + 1, 2);
  await page.locator('#lap-replay-line').uncheck();
  await page.locator('#lap-replay-line').check();
  await page.locator('#lap-replay-map').click({ position: { x: 80, y: 80 } });
  await expect(page.locator('#lap-replay-play')).toHaveText('PLAY');
  await page.locator('#lap-replay-seek').fill('40');
  await expect(page.locator('#lap-replay-time')).toHaveText('0:40.000 / 0:40.000');
  await page.locator('#lap-replay-restart').click();
  await expect(page.locator('#lap-replay-seek')).toHaveValue('0');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#lap-replay-download').click();
  const download = await downloadEvent;
  const saved = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(saved.ghost.recording.physicsHz).toBe(60);
  expect(saved.ghost.trackSnapshot.spline).toHaveLength(track.spline.length);
  await page.locator('#lap-replay-seek').fill('20');
  await page.screenshot({ path: 'test-results/lap-replay-desktop.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(watch).toBeFocused();
  expect(await page.evaluate(() => getActiveRace())).toBeNull();
  expect(errors).toEqual([]);
});

test('legacy recordings stay watchable and entries without recordings stay labeled Legacy', async ({ page }) => {
  await board(page, { legacy: true });
  await expect(page.locator('.lb-row')).toHaveCount(12);
  await expect(page.locator('.lb-row').last()).toContainText('LEGACY');
  await expect(page.locator('.lb-row').first()).toContainText('REPLAY UNAVAILABLE');
  await expect(page.locator('.lb-row').first().locator('.lb-watch-time')).toHaveCount(0);
  await page.getByRole('button', { name: /^Watch RECORDER lap/ }).click();
  await expect(page.locator('#lap-replay-content')).toBeVisible();
  await expect(page.locator('#lap-replay-source')).toContainText('Legacy recording');
});

for (const options of [{ failed: true }, { incomplete: true }]) {
  test(`unavailable or incomplete recording gives an honest error ${JSON.stringify(options)}`, async ({ page }) => {
    await board(page, options);
    await page.getByRole('button', { name: /^Watch RECORDER lap/ }).click();
    await expect(page.locator('#lap-replay-title')).toHaveText('Replay unavailable');
    await expect(page.locator('#lap-replay-content')).toBeHidden();
    await page.getByRole('button', { name: 'Close lap replay' }).click();
    await expect(page.locator('#screen-leaderboard')).toBeVisible();
  });
}

test('replay fits a phone and can open an existing ghost race', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await board(page);
  await page.getByRole('button', { name: /^Watch RECORDER lap/ }).click();
  await expect(page.locator('#lap-replay-content')).toBeVisible();
  expect(await page.locator('#lap-replay-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/lap-replay-phone.png' });
  await page.locator('#lap-replay-race').click();
  await expect(page.locator('#lap-replay-dialog')).not.toBeVisible();
  await expect(page.locator('#screen-setup')).toBeVisible();
  expect(await page.evaluate(() => window._leaderboardGhostSelection.runId)).toBe(runId);
});
