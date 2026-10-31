import {test,expect,gotoGame} from './fixtures/game.js';

test('official headless physics match the browser across all tracks and both modes',async({page})=>{
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  const result=await page.evaluate(async()=>{
    const {createOfficialGame}=await import('/sim/official-game.mjs');
    const core=createOfficialGame({OnlineSim:window.OnlineSim});core.setHoldBindings();
    const errors=[],oldRace=race,oldNow=Object.getOwnPropertyDescriptor(performance,'now');let clock=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
    const fields=['x','y','angle','speed','grip','tyreWear','tyreTemp','ersCharge','maxSpeed','accel'];
    try{
      for(let id=0;id<8;id++)for(const mode of ['ai','shootout'])for(const weather of ['dry','wet','heavy']){
        const tr=TRACKS[id],ct=core.tracks[id];
        if(tr.spline.length!==ct.spline.length||tr.spline.some((p,i)=>Math.hypot(p.x-ct.spline[i].x,p.y-ct.spline[i].y)>1e-8))errors.push(`track ${id} geometry`);
        let input={};const p=tr.spline[20],q=tr.spline[21],a=Math.atan2(q.y-p.y,q.x-p.x);
        const real=new Kart(1,p.x,p.y,a,'#fff','#000',()=>input),copy=new core.Kart(1,p.x,p.y,a,'#fff','#000',()=>input);
        const realOther=new Kart(2,p.x+10,p.y,a,'#fff','#000',()=>({})),copyOther=new core.Kart(2,p.x+10,p.y,a,'#fff','#000',()=>({}));
        for(const k of [real,copy]){k.isAI=true;k._officialML=true;k._mlDriver=true;k.totalLaps=Infinity;k.lapStart=0;k.drsAvailable=true;k._nearestSplineIdx=20;}
        applyStockPerformanceToKart(real);applyWeatherToKart(real,weather,'med');core.applyStockPerformanceToKart(copy);core.applyWeatherToKart(copy,weather,'med');
        if(mode==='shootout'){applyShootoutBoost(real);core.applyShootoutBoost(copy);}
        window._raceWeather=weather;race={mode,weather,track:tr,karts:[real,realOther],collisionMode:'collision',_nextFinishOrder:1};
        core.setWorld({...race,track:ct,karts:[copy,copyOther]});
        for(let step=0;step<300;step++){
          const dt=[1/120,1/30,1/60][step%3];clock+=dt*1000;core.setClock(clock);input={steer:Math.sin(step*.08)*.7,throttle:step%100<70?1:0,brake:step%100>=80?.65:0,ers:step%90<30,drs:step%80<30};
          if(step%100===0){realOther.x=real.x+10;realOther.y=real.y;copyOther.x=copy.x+10;copyOther.y=copy.y;}
          real.update(dt,tr,[real,realOther]);copy.update(dt,ct,[copy,copyOther]);
          for(const field of fields)if(!Number.isFinite(real[field])||Math.abs(real[field]-copy[field])>1e-7){errors.push(`${id}/${mode} step ${step} ${field}: ${real[field]} vs ${copy[field]}`);break;}
          if(errors.length>10)break;
        }
      }
    }finally{race=oldRace;if(oldNow)Object.defineProperty(performance,'now',oldNow);else delete performance.now;}
    return errors;
  });expect(result).toEqual([]);
});

test('official gate, real trajectory rendering and batch controls',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  await expect(page.locator('#om-lock')).toBeVisible();await expect(page.locator('#om-dashboard')).toBeHidden();
  await page.locator('#om-password').fill('wrong');await page.locator('#om-unlock button').click();await expect(page.locator('#om-lock-error')).toContainText('Incorrect');
  await page.locator('#om-password').fill('KartBlitzPass');await page.locator('#om-unlock button').click();await expect(page.locator('#om-dashboard')).toBeVisible();
  await page.locator('#om-url').fill(new URL(page.url()).origin);
  const track=await page.evaluate(()=>{const t=TRACKS[0];return {id:0,name:t.name,width:t.trackWidth,length:t.totalLen,spline:t.spline,cum:t.cum,cpLines:t.cpLines};});
  const p=track.spline[20],q=track.spline[21],car={id:1,...p,a:Math.atan2(q.y-p.y,q.x-p.x),speed:125};const commands=[];
  await page.route('**/api/official/**',async route=>{
    const path=new URL(route.request().url()).pathname;let body={ready:true,deviceName:'Test GPU',cudaAvailable:true};
    if(path.endsWith('/jobs')&&route.request().method()==='POST')body={id:'testjob'};
    else if(path.endsWith('/control')){commands.push(route.request().postDataJSON());body={ok:true};}
    else if(path.endsWith('/testjob'))body={id:'testjob',status:'running',phase:'learning',track,trackId:0,completedSteps:128,totalSteps:1024,attempts:4,preview:{batch:0,batchCount:2,environments:[{environment:0,episode:1,mode:'ai',time:1,progress:.1,reward:4,car,path:[{...car,t:0},{...car,x:car.x+2,t:1}]}]}};
    else if(path.endsWith('/replays'))body={attempts:Array.from({length:1000},(_,i)=>({attempt:i+1,difficulty:'extreme',contacts:0,points:track.spline.filter((_,j)=>j%40===0).map((p,j)=>({...p,a:car.a,speed:125,t:j*.1}))}))};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.locator('#om-start').click();await expect(page.locator('#om-metrics')).toContainText('128');await expect(page.locator('#om-car-status')).toContainText('Car 0');
  await page.locator('#om-batch').selectOption('1');await page.locator('#om-pause').click();await expect.poll(()=>commands.map(c=>c.action)).toContain('pause');
  await page.locator('#om-view').selectOption('early');await expect(page.locator('#om-view-status')).toContainText('1000 recorded');await expect(page.locator('#om-car option')).toHaveCount(1000);
  expect(errors).toEqual([]);
});

test('off-track speed, strict limits and corner-cut flags match the actual game',async({page})=>{
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  const errors=await page.evaluate(async()=>{
    const {createOfficialGame}=await import('/sim/official-game.mjs'),core=createOfficialGame({OnlineSim:window.OnlineSim});core.setHoldBindings();
    const errors=[],oldRace=race,oldNow=Object.getOwnPropertyDescriptor(performance,'now');let clock=0;
    Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
    try{for(let id=0;id<8;id++)for(const mode of ['ai','shootout']){
      const tr=TRACKS[id],ct=core.tracks[id],sf=tr.cpLines[0],n=tr.spline.length;
      const before=tr.spline[(sf.idx-1+n)%n],after=tr.spline[(sf.idx+1)%n],a=Math.atan2(after.y-before.y,after.x-before.x),tx=Math.cos(a),ty=Math.sin(a);
      const speeds=[];
      for(const offset of [0,tr.trackWidth/2+30,tr.trackWidth/2+90]){
        const x=sf.cx-tx*30-ty*offset,y=sf.cy-ty*30+tx*offset,input={steer:0,throttle:1,brake:0,ers:false,drs:false};
        const real=new Kart(1,x,y,a,'#fff','#000',()=>input),copy=new core.Kart(1,x,y,a,'#fff','#000',()=>input);
        for(const k of [real,copy]){k.isAI=true;k._officialML=true;k.totalLaps=Infinity;k.lapStart=0;k.speed=300;k._nearestSplineIdx=sf.idx;}
        applyStockPerformanceToKart(real);applyWeatherToKart(real,'dry','med');core.applyStockPerformanceToKart(copy);core.applyWeatherToKart(copy,'dry','med');
        if(mode==='shootout'){applyShootoutBoost(real);core.applyShootoutBoost(copy);}
        window._raceWeather='dry';race={mode,weather:'dry',track:tr,karts:[real],collisionMode:'collision'};core.setWorld({...race,track:ct,karts:[copy]});
        for(let tick=0;tick<15;tick++){
          clock+=1000/60;core.setClock(clock);real.update(1/60,tr,[real]);copy.update(1/60,ct,[copy]);
          for(const field of ['speed','x','y','angle'])if(Math.abs(real[field]-copy[field])>1e-7)errors.push(`${id}/${mode}/${offset}: ${field}`);
          for(const field of ['isOffTrack','_isCompletelyOff','_cornerCutLatched'])if(real[field]!==copy[field])errors.push(`${id}/${mode}/${offset}: ${field}`);
        }
        speeds.push(real.speed);if(offset>0&&!real._isCompletelyOff)errors.push(`${id}/${mode}: expected strict track limit`);
      }
      if(speeds[1]>=speeds[0]||speeds[2]>=speeds[0])errors.push(`${id}/${mode}: off-track did not slow the kart`);
    }}finally{race=oldRace;if(oldNow)Object.defineProperty(performance,'now',oldNow);else delete performance.now;}
    return errors;
  });expect(errors).toEqual([]);
});

test('installed policy is used only by the two requested race modes',async({page})=>{
  await gotoGame(page,{path:'/index.html?tool=official-ml'});
  const states=await page.evaluate(async()=>{
    await window.KartBlitzOfficialReady;const official=window.KartBlitzOfficial;
    const model={id:'integration',policy:{layers:[{kernel:Array.from({length:5},()=>Array(48).fill(0)),bias:[0,1,-1,-1,-1]}]}};
    await official.installPackage({format:'kartblitz-official-track-v1',name:'Integration',physicsHash:official.PHYSICS_HASH,trackFingerprint:official.trackFingerprint(TRACKS[0]),trackId:0,observationVersion:1,observationCount:48,variants:{medium:model}});
    localStorage.setItem('kartblitz_official_driver','trained');
    const result=[];for(const mode of ['ai','shootout','trial']){const r=new Race(mode,TRACKS[0]);result.push([mode,r.karts.some(k=>k._officialML)]);}
    window._mlRaceConfig={model:{},modelType:'our'};const lab=new Race('ai',TRACKS[0]);result.push(['lab',lab.karts.some(k=>k._officialML)]);
    const missing=makeRaceAIInput(TRACKS[1],'medium',0,'ai');const k={};missing.set(k);result.push(['fallback',!!k.mlFallbackReason]);return result;
  });expect(states).toEqual([['ai',true],['shootout',true],['trial',false],['lab',false],['fallback',true]]);
});
