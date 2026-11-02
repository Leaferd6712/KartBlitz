/** Native game acceptance in a disposable browser profile; never the player's browser. */
import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import {chromium} from '@playwright/test';
const [file,difficulty,output]=process.argv.slice(2);
const pack=JSON.parse(fs.readFileSync(file,'utf8'));
const browser=await chromium.launch({headless:true,args:['--disable-gpu']});
try{
  const page=await browser.newPage();
  await page.route('https://**/*',r=>r.abort());
  await page.addInitScript(()=>{window.CrazyGames={SDK:{init:async()=>{},game:{loadingStart(){},loadingStop(){},gameplayStart(){},gameplayStop(){},happytime(){},addSettingsChangeListener(){}},data:{get:async()=>null,set:async()=>{}}}};});
  await page.goto('http://127.0.0.1:8766/index.html?tool=official-ml');
  await page.waitForFunction(()=>typeof Race==='function'&&!!window.KartBlitzOfficial);
  const report=await page.evaluate(async({pack,difficulty})=>{
    await window.KartBlitzOfficialReady;
    const official=window.KartBlitzOfficial;
    official.validatePackage(pack);await official.installPackage(pack);
    const rows=[];let clock=0;const original=Object.getOwnPropertyDescriptor(performance,'now');
    Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
    try{for(const trained of [false,true])for(const mode of ['ai','shootout'])for(let i=0;i<6;i++){
      clock=0;localStorage.removeItem('kartblitz_official_track_choices');localStorage.setItem('kartblitz_official_driver',trained?'trained':'current');
      window._aiDifficulty=difficulty;window._shootoutDifficulty=difficulty;window._aiCount=1;window._skipNextQuali=true;
      window._quickRaceOptions={weather:'dry',tyres:'med',selectedLaps:mode==='ai'&&i>=4?3:1};
      const r=new Race(mode,TRACKS[pack.trackId]);race=r;
      const k=r.karts[1];applyStockPerformanceToKart(k);applyWeatherToKart(k,'dry','med');
      r.karts[0]._shootoutStowed=true;r.karts[0].x=-99999;r.karts[0].y=-99999;
      if(mode==='shootout')r._startShootoutAIRun();
      let setEnergy=false,off=0,ticks=0;const lapValidity=[];
      for(let tick=0;tick<60*600&&!k.finished;tick++){
        const previousLaps=k.lapTimes.length,validBefore=!k._ghostLapInvalid&&(k._ghostOffTrackAcc||0)<1.5;clock+=1000/60;r.update(1/60);if(k.lapTimes.length>previousLaps)lapValidity.push(validBefore);
        if(r.phase==='racing'&&!setEnergy){k.ersCharge=[1,.5,.25][i%3];setEnergy=true;}
        off+=+(!!k.isOffTrack||!!k._isCompletelyOff);ticks++;
      }
      rows.push({trained,mode,case:i,laps:k.lapTimes.length,expectedLaps:mode==='ai'&&i>=4?3:1,finished:k.finished,
        lapTime:k.lapTimes[0]??null,lapTimes:k.lapTimes,valid:!k._ghostLapInvalid&&(k._ghostOffTrackAcc||0)<1.5,
        allLapsValid:k.lapTimes.length>0&&lapValidity.length===k.lapTimes.length&&lapValidity.every(Boolean)&&off/Math.max(1,ticks)<.01,
        contacts:k._officialContactCount||0,offTrackRate:off/Math.max(1,ticks)});
    }}finally{if(original)Object.defineProperty(performance,'now',original);else delete performance.now;}
    const median=a=>{a=[...a].sort((a,b)=>a-b);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null;};
    const modes={};for(const mode of ['ai','shootout']){
      const solo=rows.filter(r=>r.mode===mode&&r.expectedLaps===1);
      modes[mode]={candidateMedian:median(solo.filter(r=>r.trained&&r.finished).map(r=>r.lapTime)),legacyMedian:median(solo.filter(r=>!r.trained&&r.finished).map(r=>r.lapTime))};
    }
    return {passed:rows.filter(r=>r.trained).every(r=>r.finished&&r.valid&&r.allLapsValid&&r.laps===r.expectedLaps),
      beatsLegacy:Object.values(modes).every(m=>m.candidateMedian!==null&&m.legacyMedian!==null&&m.candidateMedian<=m.legacyMedian),modes,rows,
      note:'Dry stock medium; native countdown, launch, standing/grid and Shootout lead-in; battery states 100/50/25%; AI includes 3-lap runs. Repeated deterministic cases are not independent probability estimates.'};
  },{pack,difficulty});
  report.traffic=await page.evaluate(async({pack,difficulty})=>{
    const official=window.KartBlitzOfficial,rows=[];let clock=0;
    const original=Object.getOwnPropertyDescriptor(performance,'now');Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
    function pointAt(track,progress,lane){
      const target=((progress%track.totalLen)+track.totalLen)%track.totalLen;let i=1;while(i<track.cum.length&&track.cum[i]<target)i++;
      const a=track.spline[i-1],b=track.spline[i%track.spline.length],f=(target-track.cum[i-1])/Math.max(.001,(track.cum[i]??track.totalLen)-track.cum[i-1]),angle=Math.atan2(b.y-a.y,b.x-a.x);
      return {x:a.x+(b.x-a.x)*f-Math.sin(angle)*lane,y:a.y+(b.y-a.y)*f+Math.cos(angle)*lane,angle};
    }
    try{for(const trained of [false,true])for(const scenario of ['passing','defending','recovery','mixed'])for(let caseId=0;caseId<3;caseId++){
      clock=0;localStorage.setItem('kartblitz_official_driver',trained?'trained':'current');localStorage.removeItem('kartblitz_official_track_choices');
      window._aiDifficulty=difficulty;window._aiCount=3;window._skipNextQuali=true;window._quickRaceOptions={weather:'dry',tyres:'med',selectedLaps:1};
      const r=new Race('ai',TRACKS[pack.trackId]);race=r;const k=r.karts[1],track=r.track,opponents=r.karts.slice(2);
      r.karts[0]._shootoutStowed=true;r.karts[0].x=-99999;r.karts[0].y=-99999;
      for(const kart of r.karts){applyStockPerformanceToKart(kart);applyWeatherToKart(kart,'dry','med');}
      const origin=official.geometry(k,track,{}).progress;
      opponents.forEach((other,j)=>{
        const gap=scenario==='passing'||(scenario==='mixed'&&j===0)?100+j*90:-65-j*60;
        const p=pointAt(track,origin+gap,(j%2?-1:1)*20);Object.assign(other,p,{prevX:p.x,prevY:p.y,totalLaps:Infinity,lapStart:null});
        other._officialML=true;other._state={};other._initialAhead=gap>0;
        const pace=scenario==='defending'?1:scenario==='passing'?.6:.8;
        other.getInput=()=>official.actionToInput(official.teacher(other,track,other._state,pace),other,track,other._state,{mode:'shootout'});
      });
      let defenseLost=false,escaped=false,raceStart=null,hit=false,firstHit=null,recoveryTime=null,contacts=0,passes=0,defendedTime=0;const closePairs=new Set(),passed=new Set(),flagged=new Set(),points=[];let defenseObject=null,encounter=0;
      for(let tick=0;tick<60*600&&!k.finished;tick++){
        clock+=1000/60;
        if(r.phase==='racing'&&raceStart===null)raceStart=clock;
        if(scenario==='recovery'&&raceStart!==null&&clock-raceStart>=4000&&!hit&&opponents.length){const o=opponents[0];o.x=k.x+Math.cos(k.angle)*18;o.y=k.y+Math.sin(k.angle)*18;o.speed=k.speed*.5;hit=true;}
        for(const o of opponents){const near=Math.hypot(o.x-k.x,o.y-k.y)<(typeof KART_R==='number'?KART_R:16)*2+2;
          if(near&&!closePairs.has(o.id)){contacts++;if(firstHit===null)firstHit=clock;}if(near)closePairs.add(o.id);else closePairs.delete(o.id);}
        r.update(1/60);
        const g=official.geometry(k,track,{}),state=k._officialPolicyState,d=state?.defense;
        if(d&&d!==defenseObject){defenseObject=d;encounter++;}
        if(d?.used&&Math.abs(g.lateral-d.lane)>track.trackWidth*.15&&closePairs.size===0)flagged.add(encounter);
        for(const o of opponents){let gap=official.geometry(o,track,{}).progress-g.progress;if(gap>track.totalLen/2)gap-=track.totalLen;if(gap<-track.totalLen/2)gap+=track.totalLen;
          if(o._initialAhead&&gap<-50&&!passed.has(o.id)&&k.speed>50){passed.add(o.id);passes++;}
          if(scenario==='defending'&&gap>50)defenseLost=true;if(scenario==='defending'&&gap<-350&&defendedTime>=1)escaped=true;
          if(scenario==='defending'&&gap<0&&gap>-350&&k.speed>50)defendedTime+=1/60/opponents.length;
        }
        if(firstHit!==null&&recoveryTime===null&&clock-firstHit>500&&k.speed>50&&!k.isOffTrack&&!k._isCompletelyOff)recoveryTime=(clock-firstHit)/1000;
        if(tick%3===0)points.push({t:clock/1000,x:k.x,y:k.y,a:k.angle,speed:k.speed,ersCharge:k.ersCharge,ersActive:!!k.ersActive,drsActive:!!k.drsActive,drsInZone:!!k.drsInZone,contacts,opponents:opponents.map(o=>({id:o.id,x:o.x,y:o.y,a:o.angle,speed:o.speed}))});
      }
      rows.push({trained,scenario,case:caseId,finished:k.finished,valid:!k._ghostLapInvalid&&(k._ghostOffTrackAcc||0)<1.5,lapTime:k.lapTimes[0]??null,nearContactEvents:contacts,passes,defended:!defenseLost&&(defendedTime>=5||escaped),recoveryTime,defensiveReversalFlags:flagged.size,points});
    }}finally{if(original)Object.defineProperty(performance,'now',original);else delete performance.now;}
    const candidate=rows.filter(r=>r.trained),legacy=rows.filter(r=>!r.trained);
    const count=a=>a.reduce((n,r)=>n+r.nearContactEvents,0);
    return {passed:candidate.filter(r=>r.finished&&r.valid).length>=Math.ceil(candidate.length*.9)&&candidate.every(r=>!r.defensiveReversalFlags)&&count(candidate)<=count(legacy),
      candidateContactEvents:count(candidate),legacyContactEvents:count(legacy),rows,
      contactMeasure:'Matched near-contact events sampled before physics; includes the scripted recovery impact. Not blame attribution.'};
  },{pack,difficulty});
  const trajectories=report.traffic.rows.map(({points,...result})=>({result,points}));
  fs.writeFileSync(output+'.trajectories.jsonl.gz',gzipSync(trajectories.map(r=>JSON.stringify(r)).join('\n')+'\n'));
  report.traffic.rows=report.traffic.rows.map(({points,...result})=>result);
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,beatsLegacy:report.beatsLegacy,modes:report.modes,trafficPassed:report.traffic.passed}));
}finally{await browser.close();}
