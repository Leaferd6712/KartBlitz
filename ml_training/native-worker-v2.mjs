/** Batched native browser rollouts, no drawing, no external server dependency. */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {chromium} from '@playwright/test';
let browser,page;
async function init(request){
  browser=await chromium.launch({headless:true,args:['--disable-gpu','--js-flags=--max-old-space-size=384']});page=await browser.newPage();
  const root=path.resolve('.'),types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!=='http://kartblitz.local')return route.abort();
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:'Not found'});
    return route.fulfill({status:200,contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  });
  await page.addInitScript(()=>{window.requestAnimationFrame=()=>0;window.KartBlitzNativeTraining=true;window.CrazyGames={SDK:{init:async()=>{},game:{loadingStart(){},loadingStop(){},gameplayStart(){},gameplayStop(){},happytime(){},addSettingsChangeListener(){}},data:{get:async()=>null,set:async()=>{}}}};});
  await page.goto('http://kartblitz.local/index.html?nativeTraining=1');await page.waitForFunction(()=>typeof Race==='function'&&!!window.KartBlitzOfficial);
  return page.evaluate(async request=>{
    const runtime=await import('/sim/official-runtime.mjs');await runtime.attach();
    const native=await import('/sim/native-training-environment.mjs');const host={clock:0};
    Object.defineProperty(performance,'now',{configurable:true,value:()=>host.clock});
    // All learning controls, including DRS, use held intents in both domains.
    BINDINGS.p1.ersMode=BINDINGS.p2.ersMode='hold';BINDINGS.p1.drsMode=BINDINGS.p2.drsMode='hold';
    window.nativeEnvs=Array.from({length:request.count||1},(_,i)=>new native.NativeEnvironment(i,request.config||{},host));
    return {...native.metadata(),environmentVersion:request.config?.revision===3?8:native.ENVIRONMENT_VERSION,profileHash:window.nativeEnvs[0].profile.profileHash,observations:window.nativeEnvs.map(e=>e.reset())};
  },request);
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
try{for await(const line of input){
  try{const r=JSON.parse(line);let result;
    if(r.command==='init')result=await init(r);
    else if(r.command==='close'){console.log(JSON.stringify({ok:true}));break;}
    else result=await page.evaluate(r=>{
      const envs=window.nativeEnvs;
      if(r.command==='reset')return {observations:envs.map(e=>e.reset(r.options||{}))};
      if(r.command==='profile')return {profile:envs[0].profile};
      if(r.command==='configure'){for(const e of envs)Object.assign(e.config,r.config);return {configured:true};}
      if(r.command==='teacher-plan')return {plan:envs[0].plan||null};
      if(r.command==='expert')return {actions:envs.map(e=>e.expert())};
      if(r.command==='snapshot')return {trackId:envs[0].track.id,environments:envs.map(e=>e.snapshot())};
      if(r.command==='partials')return {episodes:envs.filter(e=>e.steps).map(e=>({interrupted:true,environment:e.index,episodeId:e.episode,mode:e.mode,scenario:e.scenario,raceLaps:e.laps,finished:false,validLap:false,lapTime:null,raceTime:null,progress:e.progress/e.track.totalLen,trajectory:e.config.streamTrajectories?undefined:e.trajectory,pointChunk:e.config.streamTrajectories?e.takePoints(true):undefined,contacts:e.contacts,offTrackRate:e.offSteps/Math.max(1,e.steps*3)}))};
      if(r.command==='step')return {results:envs.map((e,i)=>{const row=e.step(r.actions[i]);if(e.config.streamTrajectories)row.pointChunk=e.takePoints(row.done);if(row.done){row.info.terminal_observation=row.observation;row.info['TimeLimit.truncated']=row.truncated;if(!e.config.streamTrajectories)row.info.trajectory=e.trajectory;row.info.episode={r:e.rewardTotal,l:e.steps};row.observation=e.reset();}return row;})};
      throw Error('Unknown native worker request');
    },r);
    console.log(JSON.stringify({ok:true,...result}));
  }catch(error){console.log(JSON.stringify({ok:false,error:error.stack||String(error)}));}
}}finally{await browser?.close();}
