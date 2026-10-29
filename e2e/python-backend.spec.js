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
} from './fixtures/game.js';

const backendUrl = 'http://127.0.0.1:8001';

test('Python persistence is idle during gameplay and submits once after results', async ({ page }) => {
  const requests = [];
  page.on('request', (request) => {
    if (request.url().startsWith(backendUrl)) {
      requests.push({ url: request.url(), method: request.method(), body: request.postDataJSON() });
    }
  });

  await gotoGame(page, { path: `/?backend=${encodeURIComponent(backendUrl)}` });
  await dismissOnboarding(page);
  await waitForMenu(page);
  await startTimeTrial(page);
  await confirmStartTyres(page, /MED/);
  await completeLaps(page, { laps: 1 });

  expect(requests).toHaveLength(0);

  await endSession(page);
  await expectResults(page, /TIME TRIAL/);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].url).toBe(`${backendUrl}/api/v1/results`);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].body).toMatchObject({
    playerName: 'E2EBOT',
    mode: 'trial',
    trackId: 0,
    bestLapSeconds: 99,
    laps: 1,
  });
});

test('Python result failure never blocks the results UI', async ({ page }) => {
  await page.route(`${backendUrl}/api/v1/results`, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: { code: 'backend_unavailable' } }),
  }));
  await gotoGame(page, { path: `/?backend=${encodeURIComponent(backendUrl)}` });
  await dismissOnboarding(page);
  await waitForMenu(page);
  await startTimeTrial(page);
  await confirmStartTyres(page, /MED/);
  await completeLaps(page, { laps: 1 });

  await endSession(page);

  await expectResults(page, /TIME TRIAL/);
  await expect(page.locator('#results-wrap')).toContainText(/LAPS COMPLETED/);
});

