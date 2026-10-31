import {test,expect,gotoGame} from './fixtures/game.js';
async function open(page){await gotoGame(page,{path:'/ui/ai-models.html'});await expect(page.locator('#am-lock')).toBeVisible();await page.locator('#am-password').fill('KartBlitzPass');await page.locator('#am-unlock button').click();await expect(page.locator('#am-active')).toContainText('ACTIVE · Current AI');await page.locator('#am-archive').evaluate(el=>el.open=true);}
async function add(page,name,id,trackId=0){return page.evaluate(async({name,id,trackId})=>{
  const official=window.KartBlitzOfficial,library=await import('/sim/ai-model-library.mjs');await window.KartBlitzOfficialReady;
  const pack={format:'kartblitz-official-track-v1',name,trackId,physicsHash:official.PHYSICS_HASH,trackFingerprint:official.trackFingerprint(TRACKS[trackId]),observationVersion:1,observationCount:48,variants:{medium:{id,policy:{layers:[{kernel:Array.from({length:5},()=>Array(48).fill(0)),bias:[0,1,-1,-1,-1]}]},evaluation:{finishRate:.5,medianLapTime:90},training:{steps:100000}}}};
  return (await library.saveCandidate(pack,{kind:'test'})).id;
},{name,id,trackId});}

test('AI Models retains Current AI, manually activates candidates and preserves rollback versions',async({page},testInfo)=>{
  await open(page);await expect(page.locator('#am-source')).toContainText('function makeAIInput');
  const first=await add(page,'Candidate One','first');await expect(page.locator('[data-candidate]')).toHaveCount(1);
  expect(await page.evaluate(()=>localStorage.getItem('kartblitz_official_driver'))).toBeNull();
  expect(await page.evaluate(()=>window.KartBlitzOfficial.packages.size)).toBe(0);
  await page.locator(`[data-candidate="${first}"]`).getByRole('button',{name:'Use this model'}).click();
  await expect(page.locator('#am-active')).toContainText('TRAINED AI SELECTED');await expect(page.locator(`[data-candidate="${first}"] .am-tag`)).toHaveText('ACTIVE FOR THIS TRACK');
  const uses=await page.evaluate(()=>['ai','shootout','trial','versus'].map(mode=>[mode,new Race(mode,TRACKS[0]).karts.some(k=>k._officialML)]));
  expect(uses).toEqual([['ai',true],['shootout',true],['trial',false],['versus',false]]);
  const second=await add(page,'Candidate Two','second');await page.locator(`[data-candidate="${second}"]`).getByRole('button',{name:'Use this model'}).click();await expect(page.locator(`[data-candidate="${second}"] .am-tag`)).toHaveText('ACTIVE FOR THIS TRACK');
  await expect(page.locator('[data-candidate]')).toHaveCount(2);
  await page.evaluate(()=>{document.getElementById('ai-models').scrollTop=0;});await page.screenshot({path:testInfo.outputPath('ai-models.png')});
  await page.locator('#am-use-current').click();await expect(page.locator('#am-active')).toContainText('ACTIVE · Current AI');
  expect(await page.evaluate(()=>new Race('ai',TRACKS[0]).karts.some(k=>k._officialML))).toBe(false);
  await page.reload();await page.locator('#am-password').fill('KartBlitzPass');await page.locator('#am-unlock button').click();await expect(page.locator('[data-candidate]')).toHaveCount(2);
  await page.locator('#am-archive').evaluate(el=>el.open=true);
  await page.locator(`[data-candidate="${first}"]`).getByRole('button',{name:'Use this model'}).click();await expect(page.locator(`[data-candidate="${first}"] .am-tag`)).toHaveText('ACTIVE FOR THIS TRACK');
});

test('finished trainer packages automatically arrive as candidates without activating',async({page})=>{
  await gotoGame(page,{path:'/index.html?tool=official-ml'});await page.locator('#om-password').fill('KartBlitzPass');await page.locator('#om-unlock button').click();await page.locator('#om-url').fill(new URL(page.url()).origin);
  const pack=await page.evaluate(()=>{const o=window.KartBlitzOfficial;return {format:'kartblitz-official-track-v1',name:'Completed Training',trackId:0,physicsHash:o.PHYSICS_HASH,trackFingerprint:o.trackFingerprint(TRACKS[0]),observationVersion:1,observationCount:48,variants:{medium:{id:'finished',policy:{layers:[{kernel:Array.from({length:5},()=>Array(48).fill(0)),bias:[0,1,-1,-1,-1]}]}}}};});
  const jobId='b'.repeat(32);
  await page.route('**/api/official/**',async route=>{const path=new URL(route.request().url()).pathname;let body={};
    if(path.endsWith('/model'))body=pack;
    else if(path.endsWith('/jobs'))body={id:jobId};
    else if(path.endsWith('/'+jobId))body={id:jobId,status:'complete',packages:[{trackId:0,name:pack.name,variants:['medium']}]};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.locator('#om-start').click();await expect(page.locator('#om-message')).toContainText('inactive candidates');
  const state=await page.evaluate(async()=>{const lib=await import('/sim/ai-model-library.mjs');return {names:(await lib.listCandidates()).map(r=>r.package.name),choice:localStorage.getItem(lib.DRIVER_KEY),installed:window.KartBlitzOfficial.packages.size};});
  expect(state).toEqual({names:['Completed Training'],choice:null,installed:0});
  await page.goto('/ui/ai-models.html');await page.locator('#am-password').fill('KartBlitzPass');await page.locator('#am-unlock button').click();await expect(page.locator('#am-candidates')).toContainText('Completed Training');await expect(page.locator('#am-active')).toContainText('ACTIVE · Current AI');
});

test('incompatible candidates can be kept but cannot be activated',async({page})=>{
  await open(page);const id=await add(page,'Source Candidate','source');
  const old=await page.evaluate(async id=>{const lib=await import('/sim/ai-model-library.mjs'),rows=await lib.listCandidates(),pack=structuredClone(rows.find(r=>r.id===id).package);pack.physicsHash='older-physics';pack.name='Old version';return (await lib.saveCandidate(pack)).id;},id);
  const card=page.locator(`[data-candidate="${old}"]`);await expect(card.getByRole('button',{name:'Use this model'})).toBeDisabled();await expect(card).toContainText('Model physics differ');
  await expect(page.locator('#am-active')).toContainText('ACTIVE · Current AI');
});

test('track cards show measured completion and retain independent Legacy/RL choices',async({page})=>{
  await open(page);await expect(page.locator('[data-track-model]')).toHaveCount(8);
  const first=await add(page,'Sunset solo','solo',0),second=await add(page,'Meadow solo','meadow',1);
  await page.locator('#am-difficulty').selectOption('medium');
  await expect(page.locator('[data-track="0"]')).toContainText('50% lap completion');
  await expect(page.locator('[data-track="0"]')).toContainText('sample count unavailable');
  await page.locator('[data-track-model="0"]').selectOption(first);await expect(page.locator('#am-message')).toContainText('SUNSET SPEEDWAY selection saved');
  await expect(page.locator('[data-track-model="0"]')).toHaveValue(first);
  const drivers=()=>page.evaluate(()=>[0,1].map(id=>new Race('ai',TRACKS[id]).karts.some(k=>k._officialML)));
  expect(await drivers()).toEqual([true,false]);
  await page.locator('[data-track-model="1"]').selectOption(second);await expect(page.locator('#am-message')).toContainText('MEADOW PARK selection saved');
  await expect(page.locator('[data-track-model="1"]')).toHaveValue(second);
  await page.locator('[data-track-model="0"]').selectOption('legacy');await expect(page.locator('#am-message')).toContainText('SUNSET SPEEDWAY selection saved');
  await expect(page.locator('[data-track-model="0"]')).toHaveValue('legacy');expect(await drivers()).toEqual([false,true]);
  await page.reload();await page.locator('#am-password').fill('KartBlitzPass');await page.locator('#am-unlock button').click();
  await expect(page.locator('[data-track-model]')).toHaveCount(8);await expect(page.locator('[data-track-model="1"]')).toHaveValue(second);
  await expect(page.locator('[data-track-model="0"]')).toHaveValue('legacy');
  await page.locator('#am-use-current').click();expect(await drivers()).toEqual([false,false]);
});
