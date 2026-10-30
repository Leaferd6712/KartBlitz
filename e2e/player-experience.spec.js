import {test,expect,gotoGame,dismissOnboarding,returningPlayerStorage,playerSaveJson,readPlayerSave,confirmStartTyres} from './fixtures/game.js';
test('Quick Race uses a beginner preset without overwriting saved race preferences',async({page})=>{
  await gotoGame(page,{storage:returningPlayerStorage({kartblitz_player:playerSaveJson({selectedLaps:8,weather:'heavy',tyres:'wet'})})});
  await page.locator('#quick-race-btn').click();
  await page.waitForFunction(()=>window.getActiveRace()?.mode==='ai');
  expect(await page.evaluate(()=>{const r=getActiveRace();return {laps:r.lapCount,weather:r.weather,tyres:r.tyres,assist:r.beginnerLaunch};})).toEqual({laps:1,weather:'dry',tyres:'med',assist:true});
  const save=await readPlayerSave(page);expect(save.selectedLaps).toBe(8);expect(save.weather).toBe('heavy');
  const controlsClear=await page.evaluate(()=>{const scale=getA11yPrefs().uiScale;const r=getHudLayout(innerWidth/scale,innerHeight/scale,'ai');return document.getElementById('race-ctrl-pause').getBoundingClientRect().top >= (r.pad+r.timerH)*scale;});expect(controlsClear).toBe(true);
  await page.locator('#race-ctrl-exit').click();await expect(page.locator('#leave-dialog')).toBeVisible();
  await page.getByRole('button',{name:'KEEP RACING'}).click();await expect(page.locator('#pause-overlay')).toBeHidden();
  await page.locator('#race-ctrl-exit').click();await page.getByRole('button',{name:'YES, CONTINUE'}).click();await expect(page.locator('#screen-menu')).toBeVisible();
});

test('garage opens paint with matching navigation and no unavailable video offer',async({page})=>{
  await gotoGame(page,{storage:returningPlayerStorage()});await page.getByRole('button',{name:'GARAGE',exact:true}).click();
  await expect(page.locator('#garage-tabs .active')).toHaveText('PAINTS');await expect(page.locator('#garage-ad-btn')).toBeHidden();
  await expect(page.locator('#garage-content')).toContainText('CHASSIS');
});

test('a missing 3D bundle keeps the menu and local racing playable',async({page})=>{
  await page.route('**/ui/car-preview.bundle.js',route=>route.abort());
  await gotoGame(page,{storage:returningPlayerStorage()});await expect(page.locator('#menu-car-stage')).toHaveClass(/preview-fallback/);
  await page.locator('#quick-race-btn').click();await page.waitForFunction(()=>getActiveRace()?.mode==='ai');
});
test('practice and Time Trial are playable as a guest with no username gate',async({page})=>{
  await page.route('**/api/device-status**',r=>r.fulfill({contentType:'application/json',body:'{"registered":false}'}));
  await gotoGame(page);await dismissOnboarding(page);
  await page.getByRole('button',{name:'Try the driving guide',exact:true}).click();
  await confirmStartTyres(page);
  await expect(page.locator('#lb-auto-register-overlay')).toBeHidden();
  expect(await page.evaluate(()=>getActiveRace().practice)).toBe(true);
  await expect(page.locator('#driving-guide')).toBeVisible();
  await expect(page.locator('#guide-copy')).toContainText('accelerator');
  await page.getByRole('button',{name:'Got it · hide guide'}).click();await expect(page.locator('#driving-guide')).toBeHidden();
});
test('Time Trial hides ineffective tuning and presents mode-correct tyre information',async({page})=>{
  await gotoGame(page);await dismissOnboarding(page);await page.getByRole('button',{name:'TIME TRIAL',exact:true}).click();
  await page.getByRole('button',{name:/Select track/}).first().click();
  await expect(page.locator('#setup-advanced')).toBeHidden();await expect(page.locator('#setup-recommendation')).toContainText('no tyre wear');
  await page.locator('#setup-start-btn').click();await expect(page.locator('#pit-ui-choices')).toContainText('No tyre wear in Time Trial');await expect(page.locator('#pit-ui-choices')).not.toContainText('lap life');
});
test('text scale enlarges action labels and portrait play remains near the top',async({page})=>{
  await page.setViewportSize({width:390,height:844});await gotoGame(page);await dismissOnboarding(page);
  const button=page.locator('#quick-race-btn');const before=await button.evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
  await page.evaluate(()=>setA11yPref('uiScale',1.3));const after=await button.evaluate(el=>parseFloat(getComputedStyle(el).fontSize));expect(after).toBeGreaterThan(before*1.25);
  const box=await button.boundingBox();expect(box.y).toBeLessThan(330);
});
test('landscape touch steering does not overlap pause, exit, or pedals',async({page})=>{
  await page.setViewportSize({width:844,height:390});await gotoGame(page,{storage:returningPlayerStorage({kartblitz_devicemode:'touch'})});
  await page.locator('#quick-race-btn').click();await page.waitForFunction(()=>getActiveRace()?.phase==='racing');
  const collisions=await page.evaluate(()=>{
    const steering=document.querySelector('.touch-steer-right').getBoundingClientRect();
    return ['#race-ctrl-pause','#race-ctrl-exit','.touch-pedal-accel','.touch-pedal-brake'].filter(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.width&&r.height&&r.left<steering.right&&r.right>steering.left&&r.top<steering.bottom&&r.bottom>steering.top;});
  });expect(collisions).toEqual([]);
});
