import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('desktop boots offline, races, and keeps per-user progress across launches', async()=>{
  const executablePath=process.env.KARTBLITZ_PACKAGED_EXE;
  const args=[...(executablePath?[]:[path.join(root,'desktop')]),'--smoke-test'];
  if(process.env.KARTBLITZ_TEST_USER_DATA) args.push('--user-data-dir='+process.env.KARTBLITZ_TEST_USER_DATA);
  const application=await electron.launch({args,executablePath});
  try {
    const page=await application.firstWindow();
    await page.route('https://**/*',route=>route.abort());
    await page.waitForFunction(()=>typeof window.startQuickRace==='function' && window.KartBlitzProgramme);
    if(await page.locator('#welcome-dialog').isVisible()) await page.getByRole('button',{name:'LET’S GO',exact:true}).click();
    await expect(page.locator('#quick-race-btn')).toBeVisible();
    expect(await page.evaluate(()=>typeof window.require)).toBe('undefined');
    expect(await page.evaluate(()=>window.KartBlitzPlatform.desktop)).toBe(true);
    await page.evaluate(()=>localStorage.setItem('kartblitz_desktop_smoke','persisted'));
    await page.locator('#quick-race-btn').click();
    await page.waitForFunction(()=>window.getActiveRace()?.mode==='ai');
    expect(await page.evaluate(()=>window.getActiveRace().lapCount)).toBe(1);
    const forbidden=await page.evaluate(async()=>{const r=await fetch('kbapp://game/desktop/main.cjs');return r.status;});
    expect(forbidden).toBe(404);
  } finally { await application.close(); }
  const reopened=await electron.launch({args,executablePath});
  try { const page=await reopened.firstWindow(); await page.waitForLoadState('domcontentloaded'); expect(await page.evaluate(()=>localStorage.getItem('kartblitz_desktop_smoke'))).toBe('persisted'); }
  finally { await reopened.close(); }
});
