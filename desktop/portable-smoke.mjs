/** Exercise the self-extracting launcher as well as the unpacked Electron app. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const version=JSON.parse(await (await import('node:fs/promises')).readFile('desktop/package.json','utf8')).version;
const executable=path.join(root,`dist/windows/KartBlitz-${version}-windows-x64-portable.exe`);
const userData=path.join(root,'dist',`portable-smoke-${Date.now()}`);await mkdir(userData,{recursive:true});
const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const processHandle=spawn(executable,['--smoke-test',`--user-data-dir=${userData}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{windowsHide:true,stdio:'ignore'});
let launchError;processHandle.on('error',error=>launchError=error);let browser;
try {
  const deadline=Date.now()+45000;let ready=false;
  while(Date.now()<deadline) {
    if(launchError)throw launchError;
    try {const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(ready,'The portable launcher must extract and start Electron');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];await context.route('https://**/*',route=>route.abort());
  const page=context.pages()[0];page.setDefaultTimeout(20000);page.on('pageerror',error=>console.error('Portable renderer:',error.message));
  await page.waitForFunction(()=>window.KartBlitzProgramme && typeof startQuickRace==='function');
  assert.equal(await page.evaluate(()=>location.protocol),'kbapp:');
  if(await page.locator('#welcome-dialog').isVisible())await page.getByRole('button',{name:'LET’S GO',exact:true}).click();
  await page.locator('#quick-race-btn').click();await page.waitForFunction(()=>getActiveRace()?.mode==='ai',null,{timeout:20000});
  assert.equal(await page.evaluate(()=>getActiveRace().lapCount),1);
  console.log('Portable launcher passed: extracted, booted and entered a one-lap offline race.');
} catch(error) { console.error(error);process.exitCode=1; }
finally {
  if(browser){
    await Promise.race([Promise.allSettled(browser.contexts().flatMap(context=>context.pages().map(page=>page.close()))),new Promise(resolve=>setTimeout(resolve,2000))]);
    await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);
  }
  processHandle.kill();
}
