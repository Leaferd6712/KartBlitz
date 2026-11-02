import { test, expect, gotoGame, returningPlayerStorage } from './fixtures/game.js';
import vm from 'node:vm';

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

async function exportTrack(page) {
  await page.locator('#te-exportFmt').selectOption('tracks');
  // Selecting the same option also fires change, refreshing the export immediately.
  const text = await page.locator('#te-exportArea').inputValue();
  return JSON.parse(JSON.stringify(vm.runInNewContext('(' + text + ')')));
}

async function openPitEditor(page) {
  await page.addInitScript(() => {
    window.pitHandlePositions = {};
    window.backgroundTrackNodePositions = {};
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function(...args) {
      if (this.canvas.id === 'te-canvas') window.backgroundTrackNodePositions = {};
      return clear.apply(this, args);
    };
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
      if (this.canvas.id === 'te-canvas' && /^PIT (ENTRY|BOX|EXIT)$/.test(text)) {
        window.pitHandlePositions[text] = { x: x - 12, y: y + 12 };
      }
      if (this.canvas.id === 'te-canvas' && /^T\d+$/.test(text)) {
        window.backgroundTrackNodePositions[text] = { x: x - 9, y: y + 9 };
      }
      return original.call(this, text, x, y, ...rest);
    };
  });
  await gotoGame(page, { path: '/index.html?admin=track', storage: returningPlayerStorage() });
  await page.locator('#te-pass-input').fill('e2e-admin');
  await page.locator('#te-pass-ok').click();
  await page.locator('.te-pick-card').first().click();
  await expect.poll(() => page.evaluate(() => Object.keys(window.pitHandlePositions).length)).toBe(3);
}

test('pit entry, box and exit drag, undo, edit coordinates and survive apply/export/project reload', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPitEditor(page);
  for (const [button, label, property] of [
    ['te-btnPitEntry', 'PIT ENTRY', 'entryPt'],
    ['te-btnPitBox', 'PIT BOX', 'garagePos'],
    ['te-btnPitExit', 'PIT EXIT', 'exitPos']
  ]) {
    const before = (await exportTrack(page)).pitLane;
    await page.locator('#' + button).click();
    const handle = await page.evaluate(label => window.pitHandlePositions[label], label);
    const canvas = await page.locator('#te-canvas').boundingBox();
    await page.mouse.move(canvas.x + handle.x, canvas.y + handle.y);
    await page.mouse.down();
    await page.mouse.move(canvas.x + handle.x + 18, canvas.y + handle.y - 18, { steps: 5 });
    await page.mouse.up();
    const moved = (await exportTrack(page)).pitLane;
    expect(moved[property]).not.toEqual(before[property]);
    expect(moved.path).toContainEqual(moved[property]);
    if (property === 'entryPt') expect(moved.path[0]).toEqual(moved.entryPt);
    if (property === 'exitPos') expect(moved.path.at(-1)).toEqual(moved.exitPos);
    await page.locator('#te-btnUndo').click();
    expect((await exportTrack(page)).pitLane).toEqual(before);
    await page.locator('#te-btnRedo').click();
    expect((await exportTrack(page)).pitLane).toEqual(moved);
    // Use the same coordinate fields as ordinary nodes.
    await page.locator('#' + button).click();
    await page.locator('#te-inpX').fill(String(moved[property].x + 10));
    await page.locator('#te-btnApplyXY').click();
    expect((await exportTrack(page)).pitLane[property].x).toBe(moved[property].x + 10);
  }
  const edited = await exportTrack(page);
  const project = await page.evaluate(() => JSON.parse(localStorage.getItem('kartblitz_track_editor_project')));
  expect(Math.round(project.meta.pitLane.garagePos.x)).toBe(edited.pitLane.garagePos.x);
  expect(Math.round(project.meta.pitLane.garagePos.y)).toBe(edited.pitLane.garagePos.y);
  await page.locator('#te-btnApplyGame').click();
  const applied = await page.evaluate(() => ({ pitPos: TRACKS[0].pitPos, pitLane: TRACKS[0].pitLane }));
  expect(applied.pitPos).toEqual(edited.pitLane.garagePos);
  for (const field of ['entryPt', 'garagePos', 'exitPos']) expect(applied.pitLane[field]).toEqual(edited.pitLane[field]);
  await page.locator('#te-btnBackPicker').click();
  await page.locator('.te-pick-card').first().click();
  expect((await exportTrack(page)).pitLane).toEqual(edited.pitLane);
  await page.locator('#te-fileProject').setInputFiles({ name: 'pit-test.kbtrack.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(project)) });
  await expect(page.locator('#te-stMsg')).toContainText('Project loaded');
  expect((await exportTrack(page)).pitLane).toEqual(edited.pitLane);
  expect(errors).toEqual([]);
});

test('track nodes remain visible while editing pits and Track restores their editing controls', async ({ page }) => {
  await openPitEditor(page);
  const original = await exportTrack(page);
  await page.locator('#te-btnPitBox').click();
  await expect(page.locator('#te-btnLayerPit')).toHaveClass('active');
  const positions = await page.evaluate(() => window.backgroundTrackNodePositions);
  expect(Object.keys(positions)).toHaveLength(original.waypoints.length);
  expect((await exportTrack(page)).waypoints).toEqual(original.waypoints);
  await page.locator('#te-togNodes').uncheck();
  expect(await page.evaluate(() => Object.keys(window.backgroundTrackNodePositions))).toHaveLength(0);
  await page.locator('#te-togNodes').check();
  await page.locator('#te-btnLayerTrack').click();
  await expect(page.locator('#te-btnLayerTrack')).toHaveClass('active');
  const canvas = await page.locator('#te-canvas').boundingBox();
  await page.mouse.click(canvas.x + positions.T5.x, canvas.y + positions.T5.y);
  await expect(page.locator('#te-selInfo')).toContainText('Track node #5');
  await page.locator('#te-inpX').fill(String(original.waypoints[5].x + 25));
  await page.locator('#te-btnApplyXY').click();
  expect((await exportTrack(page)).waypoints[5].x).toBe(original.waypoints[5].x + 25);
});

test('imported pit spots retain their role when the box is not the middle node', async ({ page }) => {
  await openPitEditor(page);
  const track = await exportTrack(page);
  track.pitLane.garagePos = { ...track.pitLane.path[1] };
  track.pitLane.garageAngle = .45;
  track.pitLane.exitAngle = .25;
  await page.locator('#te-importArea').fill(JSON.stringify(track));
  await page.locator('#te-btnImport').click();
  expect((await exportTrack(page)).pitLane).toEqual(track.pitLane);
  await page.locator('#te-btnPitBox').click();
  await expect(page.locator('#te-selInfo')).toContainText('Pit box node #1');
  const handles = await page.evaluate(() => window.pitHandlePositions);
  const canvas = await page.locator('#te-canvas').boundingBox();
  // Insert a route node before the box: its index changes, its position does not.
  await page.locator('#te-toolbar [data-tool="insert"]').click();
  await page.mouse.click(canvas.x + (handles['PIT ENTRY'].x + handles['PIT BOX'].x) / 2,
    canvas.y + (handles['PIT ENTRY'].y + handles['PIT BOX'].y) / 2);
  expect((await exportTrack(page)).pitLane.garagePos).toEqual(track.pitLane.garagePos);
  await page.locator('#te-btnPitBox').click();
  await expect(page.locator('#te-selInfo')).toContainText('Pit box node #2');
  await page.locator('#te-btnUndo').click();
  expect((await exportTrack(page)).pitLane).toEqual(track.pitLane);
  // Separate imported spots are inserted into the route so cars reach them.
  track.pitLane.entryPt.x -= 80;
  track.pitLane.garagePos.y += 50;
  track.pitLane.exitPos.x += 80;
  await page.locator('#te-importArea').fill(JSON.stringify(track));
  await page.locator('#te-btnImport').click();
  const imported = (await exportTrack(page)).pitLane;
  expect(imported.path[0]).toEqual(track.pitLane.entryPt);
  expect(imported.path.at(-1)).toEqual(track.pitLane.exitPos);
  expect(imported.path).toContainEqual(track.pitLane.garagePos);
  expect(imported.garagePos).toEqual(track.pitLane.garagePos);
});
