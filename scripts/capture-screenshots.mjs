/** Reproducible documentation captures from real play, never fabricated lap results. */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'docs/assets');await mkdir(out,{recursive:true});
const port='4187';
const server=spawn(process.execPath,[path.join(root,'scripts/e2e-static-server.mjs')],{cwd:root,env:{...process.env,E2E_PORT:port},stdio:'ignore',windowsHide:true});
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='warning' && message.text().includes('preview')) console.log(message.text());});
  await page.route('**/api/**',route=>route.abort());
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(()=>window.KartBlitzProgramme && window.KartBlitzActivities && typeof window.getActiveRace==='function');
  await page.getByRole('button',{name:'LET’S GO',exact:true}).click();
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForFunction(()=>document.getElementById('menu-car-stage').dataset.ready==='true',null,{timeout:15000}).catch(()=>{});
  console.log('Preview: '+JSON.stringify(await page.evaluate(()=>({ready:document.getElementById('menu-car-stage').dataset.ready,diagnostics:window.getCarStageDiagnostics?.()}))));
  async function shot(name){await page.screenshot({path:path.join(out,`${name}.png`),timeout:90000});console.log('Captured '+name);}
  await page.evaluate(()=>pauseMenuCarStage());
  await shot('menu');
  await page.locator('#quick-race-btn').click();
  await page.keyboard.down('w');await page.waitForFunction(()=>getActiveRace()?.phase==='racing');
  await page.waitForTimeout(2100);await shot('hero');
  await page.waitForTimeout(600);await page.keyboard.down('a');await page.waitForTimeout(500);await page.keyboard.up('a');
  await page.keyboard.down('x');await page.waitForTimeout(100);await page.keyboard.up('x');
  await shot('gameplay');await page.keyboard.up('w');
  await page.locator('#race-ctrl-exit').click();await page.getByRole('button',{name:'YES, CONTINUE'}).click();
  await page.getByRole('button',{name:'GARAGE',exact:true}).click();await page.waitForSelector('#garage-car-canvas');
  await shot('garage');await page.locator('#screen-garage .back-btn').click();
  await page.setViewportSize({width:844,height:390});await page.evaluate(()=>setDeviceMode(true));
  await page.locator('#quick-race-btn').click();await page.waitForFunction(()=>getActiveRace()?.phase==='racing');await page.waitForTimeout(2000);await shot('touch');
  await page.setContent(await (await import('node:fs/promises')).readFile(path.join(root,'ui/app-icon.svg'),'utf8'));
  await page.setViewportSize({width:256,height:256});await page.addStyleTag({content:'body{margin:0;background:transparent}'});
  await page.screenshot({path:path.join(root,'ui/app-icon.png'),omitBackground:true});
  execFileSync('python',['-c',"from PIL import Image; Image.open(r'"+path.join(root,'ui/app-icon.png')+"').save(r'"+path.join(root,'ui/app-icon.ico')+"',sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])"],{windowsHide:true});
  if(errors.length)throw new Error('Capture encountered runtime errors: '+errors.join('; '));
  // Convert without altering the captured content, keeping README downloads small.
  execFileSync('python',['-c',"from PIL import Image; from pathlib import Path; p=Path(r'"+out+"'); [(Image.open(f).convert('RGB').save(f.with_suffix('.webp'),'WEBP',quality=88), f.unlink()) for f in [p/(name+'.png') for name in ['menu','hero','gameplay','garage','touch']]]"],{windowsHide:true});
  console.log('Captured menu, hero, gameplay, garage and touch from the running game.');
} finally {await browser.close();server.kill();}
