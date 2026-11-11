import {test,expect,gotoGame} from './fixtures/game.js';
import {createHash} from 'node:crypto';

test('approved models activate automatically only in supported modes, preserve backups and respect restore',async({page})=>{
  await gotoGame(page);await page.evaluate(()=>window.KartBlitzOfficialReady);
  await page.evaluate(()=>{window._aiDifficulty='extreme';window._shootoutDifficulty='extreme';});
  const pack=await page.evaluate(()=>{const o=window.KartBlitzOfficial;return {format:'kartblitz-official-track-v2',modelGeneration:2,name:'Approved campaign test',trackId:0,physicsHash:o.PHYSICS_HASH,trackFingerprint:o.trackFingerprint(TRACKS[0]),observationVersion:2,observationCount:57,actionCount:4,observationNames:null,actionNames:['steer','throttle','brake','ers'],variants:{extreme:{id:'approved-one',policy:{layers:[{kernel:Array.from({length:4},()=>Array(57).fill(0)),bias:[0,1,-1,-1]}]}}}};});
  pack.observationNames=await page.evaluate(async()=>(await import('/sim/official-policy-v2.mjs')).OBSERVATION_NAMES);
  let body=JSON.stringify(pack),entry={path:'ai-models/approved/continuous/track-0-'+'a'.repeat(32)+'.kartai.json',sha256:createHash('sha256').update(body).digest('hex')};
  await page.route('**/ai-models/active.json',route=>route.fulfill({json:{format:'kartblitz-active-models-v1',automatic:true,revision:1,tracks:{0:entry}}}));
  await page.route('**/ai-models/approved/continuous/*.kartai.json',route=>route.fulfill({contentType:'application/json',body}));
  await page.evaluate(async()=>{await(await import('/sim/official-runtime.mjs')).syncApprovedModels();});
  const drivers=()=>page.evaluate(()=>['ai','shootout','trial','versus'].map(mode=>new Race(mode,TRACKS[0]).karts.some(k=>k._officialML)));
  expect(await drivers()).toEqual([true,true,false,false]);
  expect(await page.evaluate(()=>new Race('ai',TRACKS[1]).karts.some(k=>k._officialML))).toBe(false);
  pack.variants.extreme.id='approved-two';body=JSON.stringify(pack);entry={...entry,sha256:createHash('sha256').update(body).digest('hex')};
  await page.evaluate(async()=>{await(await import('/sim/official-runtime.mjs')).syncApprovedModels();});
  expect(await page.evaluate(async()=>{const lib=await import('/sim/ai-model-library.mjs');return (await lib.listCandidates()).map(r=>r.package.variants.extreme.id).sort();})).toEqual(['approved-one','approved-two']);
  await page.evaluate(async()=>{(await import('/sim/ai-model-library.mjs')).useCurrentAI();await(await import('/sim/official-runtime.mjs')).syncApprovedModels();});
  expect(await drivers()).toEqual([false,false,false,false]);
  await page.evaluate(async()=>{await(await import('/sim/ai-model-library.mjs')).useAutomaticModels();});
  expect(await drivers()).toEqual([true,true,false,false]);
});
