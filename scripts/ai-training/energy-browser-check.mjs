/** Matched V2 / V1 / Legacy checks in the real browser game, disposable storage. */
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {evaluationCases,acceptance,isolationCases} from '../../sim/energy-evaluation.mjs';
import {buildOfficialCore} from '../build-official-core.mjs';
buildOfficialCore({checkOnly:true});
const [file,difficulty,output,...options]=process.argv.slice(2);
const candidateBytes=fs.readFileSync(file),pack=JSON.parse(candidateBytes),baselineIndex=options.indexOf('--v1');
const initialGameHash=createHash('sha256').update(fs.readFileSync('index.html')).digest('hex');
const evaluationSourceHash=createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex');
const baseline=baselineIndex<0?null:JSON.parse(fs.readFileSync(options[baselineIndex+1],'utf8'));
if(baseline&&baseline.format!=='kartblitz-official-track-v1')throw Error('--v1 requires an actual V1 package; use --research-baseline for a converted or experimental seed');
const optional=flag=>options.includes(flag)?JSON.parse(fs.readFileSync(options[options.indexOf(flag)+1],'utf8')):null;
const profile=optional('--profile'),unguided=optional('--unguided');
const researchBaseline=optional('--research-baseline');
const shootoutOnly=options.includes('--shootout-only');
const ablateDefense=options.includes('--ablate-defense');
const appliedSteerFeedback=options.includes('--applied-steer-feedback');
const requestedSeeds=options.includes('--evaluation-seeds')?options[options.indexOf('--evaluation-seeds')+1].split(',').map(Number):null;
if(requestedSeeds&&(requestedSeeds.length!==2||requestedSeeds.some(s=>!Number.isInteger(s)||s<1)))throw Error('Use --evaluation-seeds positiveSeed1,positiveSeed2');
const baseUrl=options.includes('--base-url')?options[options.indexOf('--base-url')+1]:'http://127.0.0.1:8766';
const cases=(options.includes('--isolation-smoke')?isolationCases():evaluationCases(options.includes('--smoke'))).filter(c=>!shootoutOnly||c.mode==='shootout').map(c=>requestedSeeds?{...c,seed:requestedSeeds[c.seed===91517?1:0]}:c);
const browser=await chromium.launch({headless:true,args:['--disable-gpu']});
try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());
  if(options.includes('--offline-assets')){
    // Native game code in Chromium, with local files fulfilled directly. No
    // trainer service or localhost listener is needed for an isolated check.
    const root=path.resolve('.'),types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
    await page.route(new URL(baseUrl).origin+'/**',async route=>{
      const url=new URL(route.request().url());let file;
      try{file=path.resolve(root,'.'+decodeURIComponent(url.pathname));}catch{return route.fulfill({status:400,body:'Invalid asset path'});}
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:'Asset not found'});
      return route.fulfill({status:200,contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
    });
  }
  await page.addInitScript(()=>{window.CrazyGames={SDK:{init:async()=>{},game:{loadingStart(){},loadingStop(){},gameplayStart(){},gameplayStop(){},happytime(){},addSettingsChangeListener(){}},data:{get:async()=>null,set:async()=>{}}}};});
  await page.goto(new URL('/index.html?tool=official-ml',baseUrl).href);
  await page.waitForFunction(()=>typeof Race==='function'&&!!window.KartBlitzOfficial);
  await page.evaluate(()=>window.KartBlitzOfficialReady);
  const rows=await page.evaluate(async({pack,baseline,difficulty,cases,profile:providedProfile,unguided,researchBaseline,ablateDefense,appliedSteerFeedback})=>{
    const runtime=await import('/sim/official-runtime.mjs');await runtime.attach();
    const line=await import('/sim/racing-line.mjs');const profile=providedProfile||line.buildProfile(TRACKS[pack.trackId]);line.validateProfile(profile,TRACKS[pack.trackId],runtime.PHYSICS_HASH);
    runtime.validatePackage(pack);if(baseline){runtime.validatePackage(baseline);if(baseline.trackId!==pack.trackId)throw Error('Baseline track differs');}
    if(unguided){runtime.validatePackage(unguided);if(unguided.trackId!==pack.trackId)throw Error('Unguided track differs');}
    if(researchBaseline){runtime.validatePackage(researchBaseline);if(researchBaseline.trackId!==pack.trackId)throw Error('Research baseline track differs');}
    const arms=[['Legacy',null],...(baseline?[['V1',baseline]]:[]),...(researchBaseline?[['Research seed',researchBaseline]]:[]),...(unguided?[['Unguided',unguided]]:[]),['V2',pack]],rows=[];
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
      if(policy){const controller=runtime.makeController(track,policy,difficulty,{mode:c.mode,getOpponents:()=>[k,...opponents]});controller.set(k);k._officialPolicyState=controller.state;k.getInput=dt=>controller.fn(dt);}
      // Retain index 0 for the native Race state machine, but never run its
      // off-track recovery: it can otherwise respawn onto a supposedly solo lap.
      // It must remain unfinished in AI mode, which would DNF others 30s after
      // a human finish. Only its physics are disabled; measured cars are native.
      const spectator=r.karts[0];spectator._shootoutStowed=true;spectator.x=-99999;spectator.y=-99999;
      spectator.update=()=>{};spectator.getInput=()=>({steer:0,throttle:0,brake:0});
      if(c.mode==='shootout')r._startShootoutAIRun();
      let steeringFeedbackMismatchTicks=0;
      const actualInput=k.getInput;k.getInput=dt=>{const input=actualInput.call(k,dt);k._energyRecordedInput={...input};
        const state=k._officialPolicyState;
        if(state&&Math.abs((state.steer||0)-input.steer)>1e-7)steeringFeedbackMismatchTicks++;
        if(appliedSteerFeedback&&arm==='V2'&&state)state.steer=input.steer;
        return input;};
      const origin=runtime.geometry(k,track,{}).progress;
      opponents.forEach((other,j)=>{const gap=c.scenario==='passing'||(c.scenario==='mixed'&&j===0)?100+j*90:-65-j*60;
        const p=pointAt(track,origin+gap,(j%2?-1:1)*20);Object.assign(other,p,{prevX:p.x,prevY:p.y,totalLaps:Infinity,lapStart:null});});
      let energySet=false,off=0,ticks=0,contacts=0,drsTransitions=0,energyDeployed=0,previousDrs=false,raceStart=null,hit=false,recoveryHit=null,recoveryTime=null,spectatorIntrusionTicks=0,initialDrivingState=null;
      const validity=[],points=[],close=new Set();let defenseObject=null,encounter=0;const reversalFlags=new Set();
      const limit=60*Math.max(180,c.raceLaps*track.totalLen/90);
      for(let tick=0;tick<limit&&!k.finished;tick++){
        // Diagnostic only: reset the defensive state before each decision to
        // isolate the existing override's effect. This is never a deployable fix.
        if(ablateDefense&&k._officialPolicyState)k._officialPolicyState.defense=null;
        if(r.phase==='racing'&&raceStart===null){raceStart=clock;initialDrivingState={t:clock/1000,x:k.x,y:k.y,angle:k.angle,speed:k.speed,
          ersCharge:k.ersCharge,tyreWear:k.tyreWear,tyreTemp:k.tyreTemp,grip:k.grip,maxSpeed:k.maxSpeed,accel:k.accel,brakeForce:k.brakeForce,turnRate:k.turnRate,
          lap:k.lap,lapStart:k.lapStart,nextCp:k.nextCp,nearestSplineIndex:k._nearestSplineIdx,drsAvailable:!!k.drsAvailable,
          opponents:opponents.map(o=>({id:o.id,x:o.x,y:o.y,angle:o.angle,speed:o.speed}))};}
        if(c.scenario==='recovery'&&raceStart!==null&&clock-raceStart>=4000&&!hit&&opponents.length){const o=opponents[0];o.x=k.x+Math.cos(k.angle)*18;o.y=k.y+Math.sin(k.angle)*18;o.speed=k.speed*.5;hit=true;}
        for(const o of opponents){const near=Math.hypot(o.x-k.x,o.y-k.y)<(typeof KART_R==='number'?KART_R:16)*2+2;
          if(near&&!close.has(o.id)){contacts++;if(recoveryHit===null)recoveryHit=clock;}if(near)close.add(o.id);else close.delete(o.id);}
        const before=k.lapTimes.length,validBefore=!k._ghostLapInvalid&&(k._ghostOffTrackAcc||0)<1.5;
        clock+=1000/60;r.update(1/60);
        if((c.mode==='ai'||!spectator._shootoutStowed&&!spectator.finished)&&Math.hypot(spectator.x-k.x,spectator.y-k.y)<track.trackWidth*2)spectatorIntrusionTicks++;
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
          defenseEncounter:encounter,defenseUsed:!!d?.used,defenseLane:d?.lane??null,defenseLateral:runtime.geometry(k,track,{}).lateral,defenseCorrections:k._officialPolicyState?.defensiveCorrections||0,
          lapIndex:k.lap,lapTimes:[...k.lapTimes],contacts,opponents:opponents.map(o=>({id:o.id,x:o.x,y:o.y,a:o.angle,speed:o.speed}))});
      }
      const g=runtime.geometry(k,track,{}),originProgress=track.cum[track.cpLines[0].idx]||0;
      const distance=o=>(o.lap||0)+(((runtime.geometry(o,track,{}).progress-originProgress)%track.totalLen+track.totalLen)%track.totalLen)/track.totalLen;
      const miniSectors=line.analyseTrajectory(points,profile,{mode:c.mode,difficulty,raceLaps:c.raceLaps,physicsHash:runtime.PHYSICS_HASH,weather:'dry',tyres:'med'});
      rows.push({...c,arm,trackId:pack.trackId,rewardVersion:line.REWARD_VERSION,profileHash:profile.profileHash,miniSectors,styleScore:line.styleScore(miniSectors),finished:k.finished&&k.lapTimes.length===c.raceLaps,valid:validity.length===c.raceLaps&&validity.every(Boolean),
        lapTimes:[...k.lapTimes],raceTime:k.finished?k.lapTimes.reduce((a,b)=>a+b,0):null,racePosition:1+opponents.filter(o=>distance(o)>distance(k)).length,
        contacts,offTrackRate:off/Math.max(1,ticks),drsTransitions,defensiveReversalFlags:reversalFlags.size,recoveryTime,points,
        measuredOpponentCount:opponents.length,spectatorIntrusionTicks,initialDrivingState,steeringFeedbackMismatchTicks,evaluationVersion:2});
    }}finally{Math.random=originalRandom;if(originalNow)Object.defineProperty(performance,'now',originalNow);else delete performance.now;}
    return rows;
  },{pack,baseline,difficulty,cases,profile,unguided,researchBaseline,ablateDefense,appliedSteerFeedback});
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
  const archive=output.replace(/\.json$/,'')+'-attempts.jsonl.gz';
  fs.writeFileSync(archive,gzipSync(rows.map(row=>JSON.stringify(row)).join('\n')+'\n'));
  const summaryRows=rows.map(({points,...row})=>row),report={...acceptance(summaryRows,!!baseline),cases:summaryRows,archive,
    candidateFile:path.resolve(file),candidateSha256:createHash('sha256').update(candidateBytes).digest('hex'),
    candidatePolicySha256:createHash('sha256').update(JSON.stringify(pack.variants[difficulty].policy)).digest('hex'),
    physicsHash:pack.physicsHash,trackFingerprint:pack.trackFingerprint,testedDifficulty:difficulty,testedAt:Date.now(),evaluationVersion:2,
    gameSourceSha256:initialGameHash,evaluationSourceSha256:evaluationSourceHash,defenseMetric:'lane-deviation-review-proxy-v1',
    note:'Actual dry stock game, medium tyres; identical seeds, energy and opponents. Near-contact and defensive flags are conservative proxies; manual activation only.'};
  if(options.includes('--smoke')||options.includes('--isolation-smoke')){report.approved=false;report.reasons.push('Smoke test cannot approve a model');}
  if(shootoutOnly){report.approved=false;report.reasons.push('Shootout-only R&D cannot approve a model; complete racecraft validation is required');}
  if(researchBaseline){report.approved=false;report.reasons.push('Research baseline comparison is diagnostic; it cannot substitute for a compatible V1 promotion baseline');}
  if(ablateDefense){report.approved=false;report.reasons.push('Defence ablation disables a racing constraint and cannot approve a model');}
  if(appliedSteerFeedback){report.approved=false;report.reasons.push('Applied-steering feedback experiment changes controller semantics and cannot approve a model');}
  if(summaryRows.some(r=>r.spectatorIntrusionTicks||r.scenario==='solo'&&r.measuredOpponentCount!==0)){report.approved=false;report.reasons.push('Spectator/traffic isolation failed; evaluation is invalid');}
  if(initialGameHash!==createHash('sha256').update(fs.readFileSync('index.html')).digest('hex')){report.approved=false;report.reasons.push('Game source changed during validation; rerun against a frozen build');}
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,approved:report.approved,reasons:report.reasons}));
}finally{await browser.close();}
