/** JSON-lines simulator worker. Runs the actual offline game Kart without drawing it. */
import readline from 'node:readline';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import { createOfficialGame, PHYSICS_HASH } from '../sim/official-game.mjs';
import { observe, geometry, actionToInput, teacher, PACE, OBSERVATION_NAMES,trackFingerprint } from '../sim/official-policy.mjs';
const sandbox={console,Math,Date,ArrayBuffer,Uint8Array,DataView,Float32Array,Int32Array,Buffer,btoa};
sandbox.window=sandbox;sandbox.globalThis=sandbox;sandbox.OnlineCodec={encodeState(){return new ArrayBuffer(0);}};
vm.runInNewContext(fs.readFileSync(new URL('../online-sim.js',import.meta.url),'utf8'),sandbox);
const core=createOfficialGame({OnlineSim:sandbox.OnlineSim});core.setHoldBindings();
let envs=[],config={};
const rng=seed=>()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
function pose(k){return {id:k.id,x:k.x,y:k.y,a:k.angle,speed:k.speed,offTrack:k.isOffTrack,ersCharge:k.ersCharge,ersActive:!!k.ersActive,drsActive:!!k.drsActive,drsAvailable:!!k.drsAvailable,drsInZone:!!k.drsInZone};}
export const ENVIRONMENT_VERSION=3;
export function startLineSpawn(track){
  const sf=track.cpLines[0],n=track.spline.length;
  const before=track.spline[(sf.idx-1+n)%n],after=track.spline[(sf.idx+1)%n];
  const length=Math.hypot(after.x-before.x,after.y-before.y)||1,tx=(after.x-before.x)/length,ty=(after.y-before.y)/length;
  // Keep the kart centre one car length behind the gate, never exactly on a
  // line-crossing boundary. The first forward crossing starts the lap clock.
  const x=(sf.x1+sf.x2)/2-tx*30,y=(sf.y1+sf.y2)/2-ty*30;
  const index=geometry({x,y,angle:Math.atan2(ty,tx)},track,{}).index;
  return {x,y,a:Math.atan2(ty,tx),index,tx,ty,distanceBehind:30};
}
export function opponentSpawn(tr,start,back,lane){
  const target=((tr.cum[tr.cpLines[0].idx]-30-back)%tr.totalLen+tr.totalLen)%tr.totalLen;
  let i=1;while(i<tr.cum.length&&tr.cum[i]<target)i++;
  const a=tr.spline[i-1],b=tr.spline[i%tr.spline.length],lo=tr.cum[i-1],hi=i<tr.cum.length?tr.cum[i]:tr.totalLen;
  const f=(target-lo)/Math.max(.001,hi-lo),angle=Math.atan2(b.y-a.y,b.x-a.x);
  return {x:a.x+(b.x-a.x)*f-Math.sin(angle)*lane,y:a.y+(b.y-a.y)*f+Math.cos(angle)*lane,a:angle};
}
export function isPenalizedOffTrack(kart){return !!(kart.isOffTrack||kart._isCompletelyOff);}
export class Environment {
  constructor(index,configuration={}){this.config=configuration;this.index=index;this.random=rng((this.config.seed||1)+index*997);this.episode=0;this.reset();}
  reset(options={}){
    this.episode++;this.mode=options.mode||(this.config.mode==='mixed'?(this.random()<.5?'ai':'shootout'):(this.config.mode||'ai'));
    if(this.config.racecraft&&this.config.mode==='mixed'&&!options.mode)this.mode=this.random()<.25?'shootout':'ai';
    this.scenario=this.mode==='shootout'?'solo':this.config.scenario||(!this.config.racecraft?'solo':['solo','passing','passing','defending','recovery'][Math.floor(this.random()*5)]);
    this.defenseLost=false;this.recoveryHit=null;this.recoveryTime=null;this.recoveryInjected=false;this.defenseSequence=0;this.lastDefense=null;this.passes=0;this.defended=0;this.encounterTime=0;this.passEvents=new Set();
    this.track=core.tracks[this.config.trackId||0];this.state={};this.time=0;this.steps=0;this.rewardTotal=0;this.progress=0;this.stuck=0;this.offSteps=0;this.contacts=0;this.trajectory=[];this.lastContact=false;this.lastReward={};this.lastAction=null;
    core.setClock(0);
    const tr=this.track,start=startLineSpawn(tr),{index}=start;
    this.start=start;
    const k=new core.Kart(1,start.x,start.y,start.a,'#6ee7f7','#286275',()=>this.input);
    k.isAI=true;k._officialML=true;k._mlDriver=true;k._nearestSplineIdx=index;k.totalLaps=1;k.lapStart=null;k.nextCp=1;k.drsAvailable=true;
    core.applyStockPerformanceToKart(k);core.applyWeatherToKart(k,'dry','med');
    if(this.mode==='shootout')core.applyShootoutBoost(k);
    // Observable dynamics vary during learning; fixed evaluation uses exact stock mode settings.
    if(!options.fixed&&this.config.randomization!==false){const power=.9+this.random()*.25;k.maxSpeed*=power;k.baseMaxSpeed=k.maxSpeed;k.accel*=power;k._baseAccel=k.accel;k.turnRate*=.92+this.random()*.16;k.baseTurnRate=k.turnRate;k.grip*=.92+this.random()*.16;k._baseGrip=k.grip;}
    k.speed=0;if(options.energy!==undefined)k.ersCharge=Math.max(0,Math.min(1,options.energy));this.kart=k;this.input={steer:0,throttle:0,brake:0,ers:false,drs:false};
    this.opponents=[];
    const traffic=this.config.racecraft?(this.scenario==='solo'?0:1+Math.floor(this.random()*3)):this.config.traffic;
    if(this.mode==='ai'&&traffic){for(let j=0;j<traffic;j++){
      let back=(Math.floor(j/2)+1)*(tr.gridLayout?.rowGap||55),lane=(j%2?-1:1)*(tr.gridLayout?.laneGap||30);
      if(this.config.racecraft){if(this.scenario==='passing')back=-(100+j*90);if(this.scenario==='defending')back=65+j*65;if(this.scenario==='recovery'){back=45+j*60;lane=(j%2?-1:1)*15;}}
      const spawn=opponentSpawn(tr,start,back,lane);
      const other=new core.Kart(j+2,spawn.x,spawn.y,spawn.a,'#ff9955','#663311',()=>other._input);
      other.isAI=true;other._officialML=true;other.totalLaps=Infinity;other.lapStart=null;other._nearestSplineIdx=geometry(other,tr,{}).index;other.drsAvailable=true;
      core.applyStockPerformanceToKart(other);core.applyWeatherToKart(other,'dry','med');other._state={};other._pace=this.scenario==='defending'?1:this.scenario==='passing'?.5+this.random()*.3:.5+this.random()*.45;other._initialAhead=this.scenario==='passing';other._input=this.input;this.opponents.push(other);
    }}
    this.world={mode:this.mode,weather:'dry',track:tr,karts:[k,...this.opponents],collisionMode:'collision',_nextFinishOrder:1};
    this.context={mode:this.mode,difficulty:this.config.difficulty||'extreme',opponents:this.opponents};
    this.lastG=geometry(k,tr,this.state);this.firstPosition={x:k.x,y:k.y};
    this.record();return observe(k,tr,this.state,this.context);
  }
  record(){const k=this.kart;if(this.state.defense&&this.state.defense!==this.lastDefense){this.defenseSequence++;this.lastDefense=this.state.defense;}this.trajectory.push({opponents:this.opponents?.map(pose)||[],t:this.time,x:k.x,y:k.y,a:k.angle,speed:k.speed,offTrack:isPenalizedOffTrack(k),strictOffTrack:!!k._isCompletelyOff,cornerCut:!!k._cornerCutLatched,
    lateral:this.lastG?.lateral??0,defenseEncounter:this.state.defense?this.defenseSequence:0,defenseUsed:!!this.state.defense?.used,defenseLane:this.state.defense?.lane??null,position:this.lastG?.index??0,progress:this.progress/this.track.totalLen,checkpoint:k.lapStart===null?0:k.nextCp%this.track.cpLines.length,lapStarted:k.lapStart!==null,contacts:this.contacts,
    reward:this.rewardTotal,rewardComponents:this.lastReward||{},action:{...this.input},rawAction:this.lastAction||null,tyreWear:k.tyreWear,tyreTemp:k.tyreTemp,ersCharge:k.ersCharge,ersActive:!!k.ersActive,ersPower:k._ersPower||0,drsActive:!!k.drsActive,drsAvailable:!!k.drsAvailable,drsInZone:!!k.drsInZone,lapTime:k.finished?k.lapTimes.at(-1):k.lapStart===null?null:(this.time*1000-k.lapStart)/1000});}
  step(action){
    this.lastAction=action;
    const old={x:this.kart.x,y:this.kart.y,steer:this.state.steer||0};this.input=actionToInput(action,this.kart,this.track,this.state,this.context);
    let delta=0,rewardedDelta=0,offTicks=0,newContact=false,contactCount=this.kart._officialContactCount||0;
    for(let sub=0;sub<3;sub++){
      this.time+=1/60;core.setClock(this.time*1000);core.setWorld(this.world);core.setRandom(this.random);
      if(this.config.racecraft&&this.scenario==='recovery'&&!this.recoveryInjected&&this.time>=4&&this.opponents.length){const o=this.opponents[0];o.x=this.kart.x+Math.cos(this.kart.angle)*18;o.y=this.kart.y+Math.sin(this.kart.angle)*18;o.speed=this.kart.speed*.5;this.recoveryInjected=true;}
      const px=this.kart.x,py=this.kart.y;this.kart.update(1/60,this.track,this.world.karts);
      for(const other of this.opponents){other._input=actionToInput(teacher(other,this.track,other._state,other._pace),other,this.track,other._state,{mode:'shootout'});other.update(1/60,this.track,this.world.karts);}
      const g=geometry(this.kart,this.track,this.state);let d=g.progress-this.lastG.progress;
      if(d>this.track.totalLen*.5)d-=this.track.totalLen;if(d<-this.track.totalLen*.5)d+=this.track.totalLen;
      const bound=Math.max(5,Math.abs(this.kart.speed)/60*2);d=Math.max(-bound,Math.min(bound,d));
      if(Math.hypot(this.kart.x-px,this.kart.y-py)>bound*2)d=0; // Resets cannot create rewarded progress.
      // Reverse remains available for recovery, but driving backwards around
      // the circuit cannot earn the forward racing-progress objective.
      const off=isPenalizedOffTrack(this.kart);delta+=d;rewardedDelta+=(off||this.kart.speed<0)?Math.min(0,d):d;offTicks+=+off;
      this.lastG=g;this.progress+=d;this.offSteps+=+off;
      newContact ||= (this.kart._officialContactCount||0)>contactCount;
    }
    if(newContact&&this.recoveryHit===null)this.recoveryHit=this.time;
    if(this.recoveryHit!==null&&this.recoveryTime===null&&this.time-this.recoveryHit>.5&&this.kart.speed>50&&delta>.5&&!isPenalizedOffTrack(this.kart))this.recoveryTime=this.time-this.recoveryHit;
    this.steps++;if(this.kart.speed<12||delta<.5)this.stuck+=.05;else this.stuck=Math.max(0,this.stuck-.1);this.state.stuckSeconds=this.stuck;
    if(newContact&&!this.lastContact)this.contacts++;this.lastContact=newContact;
    const pace=PACE[this.config.difficulty]||1,target=this.kart.maxSpeed*pace;
    let raceReward=0;
    if(this.config.racecraft&&this.mode==='ai'){
      for(const other of this.opponents){const og=geometry(other,this.track,other._raceGeometry||(other._raceGeometry={}));let gap=og.progress-this.lastG.progress;if(gap>this.track.totalLen/2)gap-=this.track.totalLen;if(gap<-this.track.totalLen/2)gap+=this.track.totalLen;
        if(other._initialAhead&&gap<-50&&!this.passEvents.has(other.id)&&this.kart.speed>50){this.passEvents.add(other.id);this.passes++;raceReward+=3;}
        if(this.scenario==='defending'&&gap>50)this.defenseLost=true;
        if(this.scenario==='defending'&&gap<-350&&this.encounterTime>=1&&!this.defended&&!this.defenseLost&&this.kart.speed>50){this.defended=1;raceReward+=2;}
        if(this.scenario==='defending'&&gap<0&&gap>-350&&this.kart.speed>50)this.encounterTime+=.05/this.opponents.length;
      }
      if(!this.defended&&!this.defenseLost&&this.encounterTime>=5){this.defended=1;raceReward+=2;}
    }
    const components={racecraft:raceReward,progress:rewardedDelta/10,time:-.03,offTrack:-offTicks/3,contact:newContact?-(this.config.racecraft?6:1):0,
      smoothness:-Math.abs(this.input.steer-old.steer)*.03,pace:pace<1?-(Math.max(0,this.kart.speed/Math.max(1,target)-1)**2)*5:0,finish:0};
    const completed=this.kart.finished&&this.kart.lapTimes.length>0;
    const validLap=completed&&!this.kart._ghostLapInvalid&&(this.kart._ghostOffTrackAcc||0)<1.5;
    const finished=validLap&&this.progress>=this.track.totalLen*.98;
    const failed=this.stuck>6||Math.abs(this.lastG.lateral)>this.track.trackWidth*1.7||(completed&&!finished);
    const truncated=this.time>Number(this.config.episodeSeconds||Math.max(180,this.track.totalLen/(90*(PACE[this.config.difficulty]||1))));
    if(finished)components.finish=100;
    const reward=Object.values(components).reduce((a,b)=>a+b,0);this.rewardTotal+=reward;
    this.lastReward=components;this.record();
    const obs=observe(this.kart,this.track,this.state,this.context),done=finished||failed||truncated;
    const info={recoveryTime:this.recoveryTime,recoveryInjected:this.recoveryInjected,environment:this.index,scenario:this.scenario,passes:this.passes,defended:this.defenseLost?0:this.defended,defensiveCorrections:this.state.defensiveCorrections||0,finished,validLap,lapTime:finished?this.kart.lapTimes[0]:null,completedLapTime:completed?this.kart.lapTimes[0]:null,offTrackRate:this.offSteps/(this.steps*3),offTrackSeconds:this.offSteps/60,contacts:this.contacts,mode:this.mode,rewardComponents:components,progress:this.progress/this.track.totalLen,episodeId:this.episode};
    return {observation:obs,reward,terminated:finished||failed,truncated:truncated&&!finished&&!failed,info,done};
  }
  snapshot(){return {environment:this.index,episode:this.episode,mode:this.mode,time:this.time,start:this.start,lapStarted:this.kart.lapStart!==null,car:{...pose(this.kart),offTrack:isPenalizedOffTrack(this.kart)},opponents:this.opponents.map(pose),reward:this.rewardTotal,progress:this.progress/this.track.totalLen,path:this.trajectory.slice(-500).map(p=>({t:p.t,x:p.x,y:p.y,a:p.a,speed:p.speed,offTrack:p.offTrack}))};}
}
export const officialTracks=core.tracks;
export async function runWorker(){
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){try{const request=JSON.parse(line);let result;
  if(request.command==='init'){config=request.config||{};envs=Array.from({length:Math.max(1,Math.min(128,request.count||1))},(_,i)=>new Environment(i,config));result={observations:envs.map(e=>e.reset()),physicsHash:PHYSICS_HASH,environmentVersion:config.racecraft?4:ENVIRONMENT_VERSION,startMode:'start-finish-standing',observationNames:OBSERVATION_NAMES,tracks:core.tracks.map(t=>({id:t.id,name:t.name,fingerprint:trackFingerprint(t),start:startLineSpawn(t),length:t.totalLen,width:t.trackWidth,spline:t.spline,cpLines:t.cpLines,cum:t.cum}))};}
  else if(request.command==='step'){result={results:envs.map((e,i)=>{const r=e.step(request.actions[i]);if(r.done){r.info.terminal_observation=r.observation;r.info['TimeLimit.truncated']=r.truncated;r.info.trajectory=e.trajectory;r.info.episode={r:e.rewardTotal,l:e.steps};r.observation=e.reset();}return r;})};}
  else if(request.command==='partials')result={episodes:envs.filter(e=>e.time>0).map(e=>({interrupted:true,environment:e.index,mode:e.mode,scenario:e.scenario,finished:false,validLap:false,lapTime:null,progress:e.progress/e.track.totalLen,contacts:e.contacts,offTrackRate:e.offSteps/Math.max(1,e.steps*3),trajectory:e.trajectory}))};
  else if(request.command==='snapshot')result={environments:envs.map(e=>e.snapshot())};
  else if(request.command==='reset')result={observations:envs.map(e=>e.reset(request.options||{}))};
  else if(request.command==='teacher')result={actions:envs.map(e=>teacher(e.kart,e.track,{},PACE[config.difficulty]||1))};
  else if(request.command==='demonstrations'){
    const pairs=[];const track=core.tracks[config.trackId||0];
    for(const payload of request.replays||[]){
      const ghost=payload.ghost,record=ghost?.recording,snapshot=ghost?.trackSnapshot;
      if(Number(ghost?.trackId)!==track.id)continue;
      if(!record?.initialState||!snapshot?.spline||snapshot.spline.length!==track.spline.length||snapshot.spline.some((p,i)=>Math.hypot(p.x-track.spline[i].x,p.y-track.spline[i].y)>.2))throw new Error('Demonstration geometry/state does not match the actual game. Use a full owner-archive recording for this track.');
      const state={};let nextTime=0,stateIndex=0,trafficIndex=0;
      const checkpoints=record.stateCheckpoints||[],traffic=record.traffic||[];
      for(const f of ghost.frames){if(f[0]<nextTime||f.length<13)continue;nextTime=f[0]+50;
        while(stateIndex+1<checkpoints.length&&checkpoints[stateIndex+1][0]<=f[0])stateIndex++;
        while(trafficIndex+1<traffic.length&&traffic[trafficIndex+1][0]<=f[0])trafficIndex++;
        const k={...record.initialState,...(checkpoints[stateIndex]?.[1]||{}),x:f[1]/10,y:f[2]/10,angle:f[3]/1000,speed:f[4]/10,isOffTrack:!!f[6],ersCharge:f[7]/1000,drsInZone:!!f[8],grip:f[9]/1000};
        if(k.isOffTrack)continue;
        const opponents=(traffic[trafficIndex]?.[1]||[]).map(p=>({id:p[0],x:p[1],y:p[2],angle:p[3],speed:p[4]}));
        const observation=observe(k,track,state,{mode:payload.mode==='shootout'?'shootout':'ai',difficulty:config.difficulty||'extreme',opponents});
        pairs.push({trackId:track.id,observation,action:[f[10],f[11]*2-1,f[12]*2-1,f[5]&16?1:-1,f[5]&32?1:-1]});
        state.steer=f[10];state.throttle=f[11];state.brake=f[12];
      }
    }result={pairs};
  }
  else if(request.command==='close'){process.stdout.write(JSON.stringify({ok:true})+'\n');rl.close();process.stdin.destroy();break;}
  else throw new Error('Unknown simulator command');
  process.stdout.write(JSON.stringify({ok:true,...result})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.stack||error.message})+'\n');}}

}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await runWorker();
