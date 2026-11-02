import {test,expect,gotoGame} from './fixtures/game.js';
import {Environment} from '../ml_training/official-worker-v2.mjs';
import {PHYSICS_HASH,trackFingerprint,forward} from '../sim/official-policy.mjs';
import {OBSERVATION_NAMES,ACTION_NAMES} from '../sim/official-policy-v2.mjs';

test('V1 labels are presentation only; V2 can activate and survive reload without changing other modes',async({page})=>{
  await gotoGame(page,{path:'/ui/ai-models.html'});
  await page.locator('#am-password').fill('KartBlitzPass');await page.locator('#am-unlock button').click();
  await page.evaluate(()=>window.KartBlitzOfficialReady);
  const before=await page.evaluate(async()=>{
    const library=await import('/sim/ai-model-library.mjs'),v2=await import('/sim/official-policy-v2.mjs'),runtime=await import('/sim/official-runtime.mjs');
    const make=(version)=>({format:`kartblitz-official-track-v${version}`,name:'Sunset test',modelGeneration:version,trackId:0,
      physicsHash:runtime.PHYSICS_HASH,trackFingerprint:runtime.trackFingerprint(TRACKS[0]),observationVersion:version,
      observationCount:version===1?48:57,...(version===2?{observationNames:v2.OBSERVATION_NAMES,actionNames:v2.ACTION_NAMES,actionCount:4}:{}),
      variants:{extreme:{id:'energy-'+version,policy:{layers:[{kernel:Array.from({length:version===1?5:4},()=>Array(version===1?48:57).fill(0)),bias:version===1?[0,1,-1,-1,-1]:[0,1,-1,-1]}]}}}});
    const one=await library.saveCandidate(make(1)),two=await library.saveCandidate(make(2));
    return {one:one.id,two:two.id,oneJson:JSON.stringify(one.package)};
  });
  await expect(page.locator('[data-track-model="0"] option').filter({hasText:'V1 · Sunset test'})).toHaveCount(1);
  await expect(page.locator('[data-track-model="0"] option').filter({hasText:'V2 · Sunset test'})).toHaveCount(1);
  await expect(page.locator(`[data-candidate="${before.one}"] h2`)).toHaveText('V1 · Sunset test');
  expect(await page.evaluate(async id=>JSON.stringify((await (await import('/sim/ai-model-library.mjs')).listCandidates()).find(r=>r.id===id).package),before.one)).toBe(before.oneJson);
  await page.locator('[data-track-model="0"]').selectOption(before.two);
  await expect(page.locator('#am-message')).toContainText('selection saved');
  await page.reload();await page.locator('#am-password').fill('KartBlitzPass');await page.locator('#am-unlock button').click();
  await expect(page.locator('[data-track-model="0"]')).toHaveValue(before.two);
  const result=await page.evaluate(async()=>{
    await window.KartBlitzOfficialReady;window._aiDifficulty='extreme';window._shootoutDifficulty='extreme';
    const r=new Race('ai',TRACKS[0]);race=r;const k=r.karts[1];k.drsAvailable=true;
    return {input:k.getInput(.05),v2:window.KartBlitzOfficial.packages.get(0).modelGeneration,
      otherModes:['trial','versus'].map(mode=>new Race(mode,TRACKS[0]).karts.some(k=>k._officialML))};
  });
  expect(result.v2).toBe(2);expect(result.input.drs).toBe(true);expect(result.otherModes).toEqual([false,false]);
  await page.locator('[data-track-model="0"]').selectOption('legacy');await expect(page.locator('#am-message')).toContainText('selection saved');
  expect(await page.evaluate(()=>new Race('ai',TRACKS[0]).karts.some(k=>k._officialML))).toBe(false);
});

test('version dispatcher loads under the GitHub Pages subpath',async({page})=>{
  await page.route('**/KartBlitz/**',async route=>{const url=new URL(route.request().url());url.pathname=url.pathname.replace(/^\/KartBlitz\//,'/');await route.fulfill({response:await route.fetch({url:url.href})});});
  await gotoGame(page,{path:'/KartBlitz/index.html?tool=ai-models'});
  await page.locator('#am-password').fill('KartBlitzPass');await page.locator('#am-unlock button').click();
  await page.evaluate(()=>window.KartBlitzOfficialReady);
  expect(await page.evaluate(()=>typeof window.KartBlitzOfficial.displayName)).toBe('function');
  await expect(page.locator('[data-track-model]')).toHaveCount(8);
});

test('V2 browser decisions, energy and physics match training on every track and mode',async({page})=>{
  const scenarios=[];
  const layer=(inputs,outputs,offset)=>({kernel:Array.from({length:outputs},(_,r)=>Array.from({length:inputs},(_,c)=>Math.sin(r*17+c*7+offset)*.025)),bias:Array(outputs).fill(0)});
  const policy={layers:[layer(57,16,1),layer(16,16,2),layer(16,4,3)]};policy.layers[2].bias=[0,1,-1,-1];
  for(let trackId=0;trackId<8;trackId++)for(const mode of ['ai','shootout']){
    const e=new Environment(0,{trackId,mode,raceLaps:3,randomization:false,seed:42});let obs=e.reset({energy:.5});const points=[];
    for(let step=0;step<300;step++){
      const result=e.step(forward(policy,obs));obs=result.observation;
      points.push({x:e.kart.x,y:e.kart.y,angle:e.kart.angle,speed:e.kart.speed,ersCharge:e.kart.ersCharge,_ersPower:e.kart._ersPower,tyreWear:e.kart.tyreWear});if(result.done)break;
    }
    scenarios.push({trackId,mode,start:e.start,totalLaps:e.kart.totalLaps,points,pack:{format:'kartblitz-official-track-v2',modelGeneration:2,name:'Parity V2',trackId,
      physicsHash:PHYSICS_HASH,trackFingerprint:trackFingerprint(e.track),observationVersion:2,observationCount:57,observationNames:OBSERVATION_NAMES,actionCount:4,actionNames:ACTION_NAMES,variants:{extreme:{policy}}}});
  }
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  const errors=await page.evaluate(async scenarios=>{
    await window.KartBlitzOfficialReady;const errors=[],previousRace=race,oldClock=Object.getOwnPropertyDescriptor(performance,'now'),oldRandom=Math.random;let clock=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
    try{for(const s of scenarios){clock=0;let seed=42;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
      Math.random(); // The training constructor sampled a starting charge before the explicit reset.
      const track=TRACKS[s.trackId],controller=window.KartBlitzOfficial.makeController(track,s.pack,'extreme',{mode:s.mode,opponents:[]});
      const k=new Kart(1,s.start.x,s.start.y,s.start.a,'#fff','#000',()=>controller.fn(1/60));
      Object.assign(k,{isAI:true,_nearestSplineIdx:s.start.index,totalLaps:s.totalLaps,lapStart:null,nextCp:1,drsAvailable:true});
      applyStockPerformanceToKart(k);applyWeatherToKart(k,'dry','med');if(s.mode==='shootout')applyShootoutBoost(k);k.ersCharge=.5;controller.set(k);
      race={mode:s.mode,weather:'dry',track,karts:[k],collisionMode:'collision',_nextFinishOrder:1};window._raceWeather='dry';
      for(let step=0;step<s.points.length;step++){
        for(let tick=0;tick<3;tick++){clock+=1000/60;k.update(1/60,track,[k]);}
        // Agreement across Node's VM and Chromium, within 0.00001 game units.
        for(const [field,expected] of Object.entries(s.points[step]))if(!Number.isFinite(k[field])||Math.abs(k[field]-expected)>1e-5){errors.push(`${s.trackId}/${s.mode}/${step}: ${field} ${k[field]} vs ${expected}`);break;}
        if(errors.length)break;
      }if(errors.length)break;
    }}finally{race=previousRace;Math.random=oldRandom;if(oldClock)Object.defineProperty(performance,'now',oldClock);else delete performance.now;}
    return errors;
  },scenarios);
  expect(errors).toEqual([]);
});
