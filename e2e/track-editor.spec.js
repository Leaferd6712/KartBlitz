import { test, expect, gotoGame, returningPlayerStorage } from './fixtures/game.js';

test('track editor buttons edit the AI line, undo, apply and export', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await gotoGame(page, { path: '/index.html?admin=track', storage: returningPlayerStorage() });
  await page.locator('#te-pass-input').fill('e2e-admin');
  await page.locator('#te-pass-ok').click();
  await expect(page.locator('#screen-te-picker')).toHaveJSProperty('inert', false);
  await page.locator('.te-pick-card').first().click();
  await expect(page.locator('#screen-te-editor')).toBeVisible();
  await expect(page.locator('#screen-te-editor')).toHaveJSProperty('inert', false);
  await page.locator('#te-btnLayerAI').click();
  await expect(page.locator('#te-btnLayerAI')).toHaveClass('active');
  await page.locator('#te-btnCopyRL').click();
  await expect(page.locator('#te-rlInfo')).toContainText('nodes');
  await page.locator('#te-toolbar [data-tool="add"]').click();
  await page.locator('#te-canvas').click({ position: { x: 200, y: 200 } });
  await expect(page.locator('#te-selInfo')).toContainText('AI line node');
  await page.locator('#te-inpX').fill('2200');
  await page.locator('#te-inpY').fill('4100');
  await page.locator('#te-btnApplyXY').click();
  await page.locator('#te-btnApplyGame').click();
  await expect(page.locator('#te-stMsg')).toContainText('Applied to game');
  const applied = await page.evaluate(() => TRACKS[0].authoredRacingLine.at(-1));
  expect(applied).toEqual({ x: 2200, y: 4100 });
  await page.locator('#te-btnClearRL').click();
  await expect(page.locator('#te-rlInfo')).toContainText('No AI racing line');
  await page.locator('#te-btnUndo').click();
  await expect(page.locator('#te-rlInfo')).toContainText('nodes');
  await page.locator('#te-btnRedo').click();
  await expect(page.locator('#te-rlInfo')).toContainText('No AI racing line');
  await page.locator('#te-btnUndo').click();
  const download = page.waitForEvent('download');
  await page.locator('#te-btnDownload').click();
  expect((await download).suggestedFilename()).toMatch(/\.js$/);
  await page.locator('#te-btnBackPicker').click();
  await expect(page.locator('#screen-te-picker')).toBeVisible();
  await expect(page.locator('#screen-te-editor')).toHaveJSProperty('inert', true);
  await page.locator('.te-pick-card').first().click();
  await page.locator('#te-btnCloseEditor').click();
  await expect(page.locator('#screen-menu')).toBeVisible();
  expect(errors).toEqual([]);
});

test('track editor unlock remains interactive when reopened after cancelling', async ({ page }) => {
  await gotoGame(page, { path: '/index.html?admin=track', storage: returningPlayerStorage() });
  await page.locator('#te-pass-cancel').click();
  await expect(page.locator('#te-pass-modal')).toHaveJSProperty('inert', true);
  await page.evaluate(() => window.KartBlitzTrackEditor.requestOpen());
  await expect(page.locator('#te-pass-modal')).toHaveJSProperty('inert', false);
  await page.locator('#te-pass-input').fill('e2e-admin');
  await page.locator('#te-pass-input').press('Enter');
  await expect(page.locator('#screen-te-picker')).toBeVisible();
  await page.locator('.te-pick-add').click();
  await expect(page.locator('#screen-te-editor')).toBeVisible();
  await page.locator('#te-toolbar [data-tool="add"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#te-toolbar [data-tool="add"]')).toHaveClass('active');
  await page.locator('#te-btnCloseEditor').click();
  await expect(page.locator('#screen-te-editor')).toHaveJSProperty('inert', true);
});

async function openPublishingEditor(page) {
  await gotoGame(page, { path: '/index.html?admin=track', storage: returningPlayerStorage() });
  await page.locator('#te-pass-input').fill('e2e-admin');
  await page.locator('#te-pass-ok').click();
  await page.locator('.te-pick-card').first().click();
  // The production build injects the GitHub blob SHA; the source test server does not.
  await page.evaluate(() => {
    const meta = document.createElement('meta');
    meta.name = 'kartblitz-source-sha'; meta.content = 'a'.repeat(40); document.head.append(meta);
  });
}

test('publishing warns first, cancelling sends nothing, confirming queues one global save', async ({ page }) => {
  const saves = [];
  await page.route('**/api/admin/tracks/publish', async route => {
    saves.push(route.request());
    await route.fulfill({ status: 202, json: { ok: true, status: 'deployment_queued', commit: 'b'.repeat(40) } });
  });
  await openPublishingEditor(page);
  await expect(page.locator('.te-save-warning')).toContainText('Saving affects everyone');
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('FOR EVERYONE');
    expect(dialog.message()).toContain('AI training');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Save to Actual Game', exact: true }).click();
  expect(saves).toHaveLength(0);
  await page.locator('#te-btnCopyRL').click();
  await page.locator('#te-metaName').fill('PUBLISHED SUNSET');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Save to Actual Game', exact: true }).click();
  await expect(page.locator('#te-publishStatus')).toContainText('Deployment is queued; this is not live yet');
  expect(saves).toHaveLength(1);
  expect(saves[0].headers()['x-admin-password']).toBe('e2e-admin');
  expect(saves[0].postDataJSON()).toMatchObject({ confirmed: true, sourceSha: 'a'.repeat(40), track: { id: 0, name: 'PUBLISHED SUNSET' } });
  expect(saves[0].postDataJSON().track.racingLine.length).toBeGreaterThan(3);
  await expect(page.locator('#te-btnPublishGame')).toBeDisabled();
  await expect(page.locator('#te-publishStatus a').last()).toHaveAttribute('href', 'https://github.com/Leaferd6712/KartBlitz/actions');
});

for (const failure of [
  { status: 503, error: 'Publishing is not configured. Add the TRACK_PUBLISH_GITHUB_TOKEN Worker secret.' },
  { status: 409, error: 'The published source has changed. Wait for deployment and reload.' }
]) test(`publishing failure ${failure.status} preserves the draft and allows retry`, async ({ page }) => {
  await page.route('**/api/admin/tracks/publish', route => route.fulfill({ status: failure.status, json: { error: failure.error } }));
  await openPublishingEditor(page);
  const originalName = await page.evaluate(() => TRACKS[0].name);
  await page.locator('#te-metaName').fill('DRAFT TO KEEP');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#te-btnPublishGame').click();
  await expect(page.locator('#te-publishStatus')).toContainText(failure.error);
  await expect(page.locator('#te-btnPublishGame')).toBeEnabled();
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('kartblitz_track_editor_project')));
  expect(draft.meta.name).toBe('DRAFT TO KEEP');
  expect(await page.evaluate(() => TRACKS[0].name)).toBe(originalName);
});
