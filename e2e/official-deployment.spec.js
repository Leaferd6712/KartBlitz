import {readFileSync} from 'node:fs';
import {test,expect,gotoGame} from './fixtures/game.js';
import {Environment} from '../ml_training/official-worker.mjs';
import {forward,PHYSICS_HASH,trackFingerprint} from '../sim/official-policy.mjs';

test('the deployed policy controller follows the same decisions and physics as training',async({page})=>{
  // A real exported package can exercise this same check after a local run.
  const supplied=process.env.OFFICIAL_VALIDATION_PACKAGE?JSON.parse(readFileSync(process.env.OFFICIAL_VALIDATION_PACKAGE,'utf8')):null;
  const layer=(inputs,outputs,offset)=>({kernel:Array.from({length:outputs},(_,r)=>Array.from({length:inputs},(_,c)=>Math.sin(r*17+c*7+offset)*.025)),bias:Array(outputs).fill(0)});
  const policy={layers:[layer(48,16,1),layer(16,16,2),layer(16,5,3)]};policy.layers[2].bias=[0,1,-1,-1,-1];
  const scenarios=[];
  for(const id of supplied?[supplied.trackId]:[0,1,2,3,4,5,6,7])for(const mode of ['ai','shootout']){
    const e=new Environment(0,{trackId:id,mode,randomization:false,seed:42});let obs=e.reset({fixed:true});
    const pack=supplied||{format:'kartblitz-official-track-v1',trackId:id,physicsHash:PHYSICS_HASH,trackFingerprint:trackFingerprint(e.track),observationVersion:1,observationCount:48,variants:{extreme:{policy}}};
    const points=[];
    for(let i=0;i<(supplied?4000:400);i++){
      const result=e.step(forward(pack.variants.extreme.policy,obs));obs=result.observation;
      points.push({x:e.kart.x,y:e.kart.y,angle:e.kart.angle,speed:e.kart.speed,tyreWear:e.kart.tyreWear,ersCharge:e.kart.ersCharge});
      if(result.done)break;
    }
    scenarios.push({id,mode,start:e.start,pack,points,finished:e.kart.finished,lapTime:e.kart.lapTimes[0]??null});
  }
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  const errors=await page.evaluate(scenarios=>{
    const errors=[],previousRace=race,oldClock=Object.getOwnPropertyDescriptor(performance,'now'),oldRandom=Math.random;let clock=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
    try{for(const {id,mode,start,pack,points,finished,lapTime} of scenarios){
      let seed=42;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};clock=0;
      const track=TRACKS[id],controller=window.KartBlitzOfficial.makeController(track,pack,'extreme',{mode,opponents:[]});
      const k=new Kart(1,start.x,start.y,start.a,'#fff','#000',()=>controller.fn(1/60));
      k.isAI=true;k._nearestSplineIdx=start.index;k.totalLaps=1;k.lapStart=null;k.nextCp=1;k.drsAvailable=true;
      applyStockPerformanceToKart(k);applyWeatherToKart(k,'dry','med');if(mode==='shootout')applyShootoutBoost(k);controller.set(k);
      race={mode,weather:'dry',track,karts:[k],collisionMode:'collision',_nextFinishOrder:1};window._raceWeather='dry';
      for(let step=0;step<points.length;step++){
        for(let tick=0;tick<3;tick++){clock+=1000/60;k.update(1/60,track,[k]);}
        const expected=points[step];
        for(const field of Object.keys(expected))if(!Number.isFinite(k[field])||Math.abs(k[field]-expected[field])>1e-6){errors.push(`${id}/${mode} decision ${step} ${field}: ${k[field]} versus ${expected[field]}`);break;}
        if(errors.length)break;
      }
      if(k.finished!==finished)errors.push(`${id}/${mode}: browser finish result differs from training`);
      if(lapTime!==null&&Math.abs(k.lapTimes[0]-lapTime)>1e-6)errors.push(`${id}/${mode}: browser lap clock differs from training`);
      if(errors.length)break;
    }}finally{race=previousRace;Math.random=oldRandom;if(oldClock)Object.defineProperty(performance,'now',oldClock);else delete performance.now;}
    return errors;
  },scenarios);
  expect(errors).toEqual([]);
});

test('a supplied learned policy completes the native AI grid and Shootout lead-in',async({page})=>{
  test.skip(!process.env.OFFICIAL_VALIDATION_PACKAGE,'Supply an actual trained candidate for the driving acceptance check');
  const pack=JSON.parse(readFileSync(process.env.OFFICIAL_VALIDATION_PACKAGE,'utf8'));
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  const result=await page.evaluate(async pack=>{
    await window.KartBlitzOfficialReady;await window.KartBlitzOfficial.installPackage(pack);
    localStorage.setItem('kartblitz_official_driver','trained');
    window._aiDifficulty='extreme';window._shootoutDifficulty='extreme';window._aiCount=1;
    window._quickRaceOptions={weather:'dry',tyres:'med',selectedLaps:1};
    const oldRace=race,oldClock=Object.getOwnPropertyDescriptor(performance,'now'),rows=[];let clock=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
    try{for(const mode of ['ai','shootout']){
      window._skipNextQuali=true;clock=0;const r=new Race(mode,TRACKS[pack.trackId]);race=r;
      const k=r.karts[1];r.karts[0]._shootoutStowed=true;r.karts[0].x=-99999;r.karts[0].y=-99999;
      if(mode==='shootout')r._startShootoutAIRun();
      // Keep the native countdown/launch sequence, including its launch speed.
      for(let i=0;i<60*120&&!k.finished;i++){clock+=1000/60;r.update(1/60);}
      rows.push({mode,trained:!!k._officialML,finished:k.finished,lapTime:k.lapTimes[0]??null,valid:!k._ghostLapInvalid&&(k._ghostOffTrackAcc||0)<1.5});
    }}finally{race=oldRace;if(oldClock)Object.defineProperty(performance,'now',oldClock);else delete performance.now;}
    return rows;
  },pack);
  console.log('Native learned-policy acceptance:',JSON.stringify(result));
  for(const row of result){expect(row.trained).toBe(true);expect(row.finished,JSON.stringify(row)).toBe(true);expect(row.valid,JSON.stringify(row)).toBe(true);expect(row.lapTime).toBeGreaterThan(0);}
});
