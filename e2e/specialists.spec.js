import {test,expect,gotoGame} from './fixtures/game.js';

test('V3 chooses the independent specialist for the actual game mode and keeps Legacy rollback',async({page})=>{
  await gotoGame(page);await page.evaluate(()=>window.KartBlitzOfficialReady);
  const ids=await page.evaluate(async()=>{
    const o=window.KartBlitzOfficial,v2=await import('/sim/official-policy-v2.mjs');
    const model=id=>({id,policy:{activation:'tanh',output:'clipped-linear',layers:[{kernel:Array.from({length:4},()=>Array(57).fill(0)),bias:[0,1,-1,-1]}]}});
    const pack={format:'kartblitz-official-track-v3',modelGeneration:3,name:'V3 mode test',trackId:0,physicsHash:o.PHYSICS_HASH,trackFingerprint:o.trackFingerprint(TRACKS[0]),observationVersion:2,observationCount:57,observationNames:v2.OBSERVATION_NAMES,actionCount:4,actionNames:v2.ACTION_NAMES,variants:{extreme:{id:'pair',policies:{shootout:model('solo-head'),race:model('race-head')}}}};
    await o.installPackage(pack);localStorage.setItem('kartblitz_official_driver','trained');window._aiDifficulty='extreme';window._shootoutDifficulty='extreme';
    return ['ai','shootout','trial','versus'].map(mode=>new Race(mode,TRACKS[0]).karts.filter(k=>k.isAI).map(k=>k.mlModelId||null));
  });
  expect(ids[0]).toContain('race-head');expect(ids[1]).toContain('solo-head');expect(ids[2]).not.toContain('race-head');expect(ids[3]).not.toContain('solo-head');
  expect(await page.evaluate(async()=>{(await import('/sim/ai-model-library.mjs')).useCurrentAI();return new Race('ai',TRACKS[0]).karts.some(k=>k._officialML);})).toBe(false);
});

test('V3 dashboard explains readiness, shows each specialist and sends pause controls',async({page})=>{
  let requested='';
  await page.route('**/api/official/specialists',route=>route.fulfill({json:{phase:'pilot',activeCount:1,targetSlots:5,action:'run',approved:{},resources:{gpuUtilPercent:12,gpuUsedMiB:1100,ramPercent:70,onMains:true,diskFreeGiB:100},jobs:[{id:'a'.repeat(32),track:5,difficulty:'extreme',specialist:'shootout',kind:'teacher',status:'running',stage:'clean demonstrations'}],events:[]}}));
  await page.route('**/api/official/specialists/control',route=>{requested=route.request().postDataJSON().action;return route.fulfill({json:{ok:true}});});
  await page.goto('/ui/specialist-training.html?trainerCode=test');await page.locator('#password').fill('KartBlitzPass');await page.locator('#unlock button').click();
  await expect(page.locator('#jobs')).toContainText('Titan Loop');await expect(page.locator('#jobs')).toContainText('shootout');await expect(page.locator('#summary')).toContainText('1 / 5 learners');await page.getByRole('button',{name:'Pause',exact:true}).click();expect(requested).toBe('pause');
  await page.screenshot({path:'test-results/v3-dashboard.png',fullPage:true});
});
