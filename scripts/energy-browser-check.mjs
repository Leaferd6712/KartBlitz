/** Matched V2 / V1 / Legacy checks in the real browser game, disposable storage. */
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {chromium} from '@playwright/test';
import {evaluationCases,acceptance} from '../sim/energy-evaluation.mjs';
const [file,difficulty,output,...options]=process.argv.slice(2);
const pack=JSON.parse(fs.readFileSync(file,'utf8')),baselineIndex=options.indexOf('--v1');
const baseline=baselineIndex<0?null:JSON.parse(fs.readFileSync(options[baselineIndex+1],'utf8'));
const optional=flag=>options.includes(flag)?JSON.parse(fs.readFileSync(options[options.indexOf(flag)+1],'utf8')):null;
const profile=optional('--profile'),unguided=optional('--unguided');
const shootoutOnly=options.includes('--shootout-only');
const baseUrl=options.includes('--base-url')?options[options.indexOf('--base-url')+1]:'http://127.0.0.1:8766';
const cases=evaluationCases(options.includes('--smoke')).filter(c=>!shootoutOnly||c.mode==='shootout');
const browser=await chromium.launch({headless:true,args:['--disable-gpu']});
try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());
  await page.addInitScript(()=>{window.CrazyGames={SDK:{init:async()=>{},game:{loadingStart(){},loadingStop(){},gameplayStart(){},gameplayStop(){},happytime(){},addSettingsChangeListener(){}},data:{get:async()=>null,set:async()=>{}}}};});
  await page.goto(new URL('/index.html?tool=official-ml',baseUrl).href);
  await page.waitForFunction(()=>typeof Race==='function'&&!!window.KartBlitzOfficial);
  await page.evaluate(()=>window.KartBlitzOfficialReady);
  const rows=await page.evaluate(async({pack,baseline,difficulty,cases,profile:providedProfile,unguided})=>{
    const runtime=await import('/sim/official-runtime.mjs');await runtime.attach();
    const line=await import('/sim/racing-line.mjs');const profile=providedProfile||line.buildProfile(TRACKS[pack.trackId]);line.validateProfile(profile,TRACKS[pack.trackId],runtime.PHYSICS_HASH);
    runtime.validatePackage(pack);if(baseline){runtime.validatePackage(baseline);if(baseline.trackId!==pack.trackId)throw Error('Baseline track differs');}
    if(unguided){runtime.validatePackage(unguided);if(unguided.trackId!==pack.trackId)throw Error('Unguided track differs');}
    const arms=[['Legacy',null],...(baseline?[['V1',baseline]]:[]),...(unguided?[['Unguided',unguided]]:[]),['V2',pack]],rows=[];
    const originalNow=Object.getOwnPropertyDescriptor(performance,'now'),originalRandom=Math.random;let clock=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
    function pointAt(track,target,lane){target=((target%track.totalLen)+track.totalLen)%track.totalLen;let i=1;while(i<track.cum.length&&track.cum[i]<target)i++;
      const a=track.spline[i-1],b=track.spline[i%track.spline.length],f=(target-track.cum[i-1])/Math.max(.001,(track.cum[i]??track.totalLen)-track.cum[i-1]),angle=Math.atan2(b.y-a.y,b.x-a.x);
      return {x:a.x+(b.x-a.x)*f-Math.sin(angle)*lane,y:a.y+(b.y-a.y)*f+Math.cos(angle)*lane,angle};}
    try{for(const [arm,policy] of arms)for(const c of cases){
      let seed=c.seed;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};clock=0;
      localStorage.removeItem('kartblitz_official_track_choices');localStorage.setItem('kartblitz_official_driver','current');
      // All opponents use the same Legacy drivers; only the measured car changes.
      window._aiDifficulty=difficulty;window._shootoutDifficulty=difficulty;window._aiCount=c.scenario==='solo'?1:3;window._skipNextQuali=true;
      window._quickRaceOptions={weather:'dry',tyres:'med',selectedLaps:c.raceLaps,collisionMode:'collision'};
      const r=new Race(c.mode,TRACKS[pack.trackId]);race=r;const k=r.karts[1],track=r.track,opponents=r.karts.slice(2);
      for(const kart of r.karts){applyStockPerformanceToKart(kart);applyWeatherToKart(kart,'dry','med');}
      if(policy){const controller=runtime.makeController(track,policy,difficulty,{mode:c.mode,getOpponents:()=>r.karts});controller.set(k);k._officialPolicyState=controller.state;k.getInput=dt=>controller.fn(dt);}
      r.karts[0]._shootoutStowed=true;r.karts[0].x=-99999;r.karts[0].y=-99999;
      if(c.mode==='shootout')r._startShootoutAIRun();
      const actualInput=k.getInput;k.getInput=dt=>{const input=actualInput.call(k,dt);k._energyRecordedInput={...input};return input;};
      const origin=runtime.geometry(k,track,{}).progress;
      opponents.forEach((other,j)=>{const gap=c.scenario==='passing'||(c.scenario==='mixed'&&j===0)?100+j*90:-65-j*60;
        const p=pointAt(track,origin+gap,(j%2?-1:1)*20);Object.assign(other,p,{prevX:p.x,prevY:p.y,totalLaps:Infinity,lapStart:null});});
      let energySet=false,off=0,ticks=0,contacts=0,drsTransitions=0,energyDeployed=0,previousDrs=false,raceStart=null,hit=false,recoveryHit=null,recoveryTime=null;
      const validity=[],points=[],close=new Set();let defenseObject=null,encounter=0;const reversalFlags=new Set();
      const limit=60*Math.max(180,c.raceLaps*track.totalLen/90);
      for(let tick=0;tick<limit&&!k.finished;tick++){
        if(r.phase==='racing'&&raceStart===null)raceStart=clock;
        if(c.scenario==='recovery'&&raceStart!==null&&clock-raceStart>=4000&&!hit&&opponents.length){const o=opponents[0];o.x=k.x+Math.cos(k.angle)*18;o.y=k.y+Math.sin(k.angle)*18;o.speed=k.speed*.5;hit=true;}
        for(const o of opponents){const near=Math.hypot(o.x-k.x,o.y-k.y)<(typeof KART_R==='number'?KART_R:16)*2+2;
          if(near&&!close.has(o.id)){contacts++;if(recoveryHit===null)recoveryHit=clock;}if(near)close.add(o.id);else close.delete(o.id);}
        const before=k.lapTimes.length,validBefore=!k._ghostLapInvalid&&(k._ghostOffTrackAcc||0)<1.5;
        clock+=1000/60;r.update(1/60);
        if(!energySet&&r.phase==='racing'){k.ersCharge=c.energy;energySet=true;}
        if(k.lapTimes.length>before)validity.push(validBefore);
        const d=k._officialPolicyState?.defense;
        if(d&&d!==defenseObject){defenseObject=d;encounter++;}
        if(d?.used&&!close.size&&Math.abs(runtime.geometry(k,track,{}).lateral-d.lane)>track.trackWidth*.15)reversalFlags.add(encounter);
        if(recoveryHit!==null&&recoveryTime===null&&clock-recoveryHit>500&&k.speed>50&&!k.isOffTrack&&!k._isCompletelyOff)recoveryTime=(clock-recoveryHit)/1000;
        if(!!k.drsActive!==previousDrs){drsTransitions++;previousDrs=!!k.drsActive;}
        if(k.ersActive)energyDeployed+=1/300;
        off+=+(!!k.isOffTrack||!!k._isCompletelyOff);ticks++;
        if(tick%3===0)points.push({t:clock/1000,x:k.x,y:k.y,a:k.angle,speed:k.speed,ersCharge:k.ersCharge,energyDeployed,drsTransitions,ersActive:!!k.ersActive,ersPower:k._ersPower||0,
          drsActive:!!k.drsActive,drsAvailable:!!k.drsAvailable,drsInZone:!!k.drsInZone,action:k._energyRecordedInput||{},
          offTrack:!!k.isOffTrack||!!k._isCompletelyOff,lapStarted:k.lapStart!==null,grip:k.grip,tyreWear:k.tyreWear,tyreTemp:k.tyreTemp,maxSpeed:k.maxSpeed,
          suppressed:close.size>0||!!k._officialPolicyState?.defense||recoveryHit!==null&&clock-recoveryHit<10000,
          lapIndex:k.lap,lapTimes:[...k.lapTimes],contacts,opponents:opponents.map(o=>({id:o.id,x:o.x,y:o.y,a:o.angle,speed:o.speed}))});
      }
      const g=runtime.geometry(k,track,{}),originProgress=track.cum[track.cpLines[0].idx]||0;
      const distance=o=>(o.lap||0)+(((runtime.geometry(o,track,{}).progress-originProgress)%track.totalLen+track.totalLen)%track.totalLen)/track.totalLen;
      const miniSectors=line.analyseTrajectory(points,profile,{mode:c.mode,difficulty,raceLaps:c.raceLaps,physicsHash:runtime.PHYSICS_HASH,weather:'dry',tyres:'med'});
      rows.push({...c,arm,trackId:pack.trackId,rewardVersion:line.REWARD_VERSION,profileHash:profile.profileHash,miniSectors,styleScore:line.styleScore(miniSectors),finished:k.finished&&k.lapTimes.length===c.raceLaps,valid:validity.length===c.raceLaps&&validity.every(Boolean),
        lapTimes:[...k.lapTimes],raceTime:k.finished?k.lapTimes.reduce((a,b)=>a+b,0):null,racePosition:1+opponents.filter(o=>distance(o)>distance(k)).length,
        contacts,offTrackRate:off/Math.max(1,ticks),drsTransitions,defensiveReversalFlags:reversalFlags.size,recoveryTime,points});
    }}finally{Math.random=originalRandom;if(originalNow)Object.defineProperty(performance,'now',originalNow);else delete performance.now;}
    return rows;
  },{pack,baseline,difficulty,cases,profile,unguided});
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
  const archive=output.replace(/\.json$/,'')+'-attempts.jsonl.gz';
  fs.writeFileSync(archive,gzipSync(rows.map(row=>JSON.stringify(row)).join('\n')+'\n'));
  const summaryRows=rows.map(({points,...row})=>row),report={...acceptance(summaryRows,!!baseline),cases:summaryRows,archive,
    note:'Actual dry stock game, medium tyres; identical seeds, energy and opponents. Near-contact and defensive flags are conservative proxies; manual activation only.'};
  if(options.includes('--smoke')){report.approved=false;report.reasons.push('Smoke test cannot approve a model');}
  if(shootoutOnly){report.approved=false;report.reasons.push('Shootout-only R&D cannot approve a model; complete racecraft validation is required');}
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,approved:report.approved,reasons:report.reasons}));
}finally{await browser.close();}
