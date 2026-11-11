/** V2 rollouts through the actual Race state machine and Legacy opponents. */
import {observe,actionToInput,OBSERVATION_NAMES,ACTION_NAMES} from './official-policy-v2.mjs';
import {geometry,trackFingerprint,PHYSICS_HASH,PACE} from './official-policy.mjs';
import {buildProfile,validateProfile,SectorTracker,styleScore} from './racing-line.mjs';
import {CornerMonitor} from './corner-monitor.mjs';
import {makeController} from './official-runtime.mjs';
import {withNativePitStrategy} from './official-race-strategy.mjs';
import {makePlan,initialParameters,speedEnvelope,plannedAction} from './pace-planner.mjs';

export const ENVIRONMENT_VERSION=7;
const lengths=[1,2,3,5,8,10],charges=[.25,.5,1],profiles=new Map();
const pose=k=>({id:k.id,x:k.x,y:k.y,a:k.angle,speed:k.speed,ersCharge:k.ersCharge,ersActive:!!k.ersActive,drsActive:!!k.drsActive});
const off=k=>!!k.isOffTrack||!!k._isCompletelyOff;
export class NativeEnvironment {
  constructor(index,config,host){this.index=index;this.config=config;this.host=host;this.seed=(config.seed||42)+index*8191;this.episode=0;this.reset();}
  random(){this.seed=(Math.imul(this.seed,1664525)+1013904223)>>>0;return this.seed/4294967296;}
  bind(){this.host.clock=this.clock;Math.random=()=>this.random();race=this.race;}
  reset(options={}){
    if(options.seed!==undefined)this.seed=options.seed>>>0;
    this.episode++;this.clock=0;this.bind();this.state={};
    this.mode=options.mode||(this.config.mode==='shootout'?'shootout':this.config.mode==='ai'?'ai':this.random()<.3?'shootout':'ai');
    this.scenario=this.mode==='shootout'||!this.config.racecraft?'solo':options.scenario||this.config.scenario||['solo','passing','defending','recovery','mixed'][Math.floor(this.random()*5)];
    this.laps=this.mode==='shootout'?1:Number(options.raceLaps??this.config.raceLaps??lengths[Math.floor(this.random()*lengths.length)]);
    if(!lengths.includes(this.laps))throw Error('Unsupported native race length');
    this.charge=options.energy??charges[Math.floor(this.random()*3)];
    if(!Number.isFinite(this.charge)||this.charge<0||this.charge>1)throw Error('Invalid native starting charge');
    const w=globalThis;localStorage.removeItem('kartblitz_official_track_choices');localStorage.setItem('kartblitz_official_driver','current');
    w._aiDifficulty=this.config.difficulty||'extreme';w._shootoutDifficulty=w._aiDifficulty;w._aiCount=this.scenario==='solo'?1:3;w._skipNextQuali=true;
    w._quickRaceOptions={weather:'dry',tyres:'med',selectedLaps:this.laps,collisionMode:'collision'};
    this.race=new Race(this.mode,TRACKS[this.config.trackId||0]);this.bind();this.track=this.race.track;
    this.kart=this.race.karts[1];this.opponents=this.race.karts.slice(2);
    for(const k of this.race.karts){applyStockPerformanceToKart(k);applyWeatherToKart(k,'dry','med');}
    const spectator=this.race.karts[0];spectator._shootoutStowed=true;spectator.x=-99999;spectator.y=-99999;spectator.update=()=>{};spectator.getInput=()=>({});
    if(this.mode==='shootout')this.race._startShootoutAIRun();
    // Match the native evaluator's seeded passing/defending grid encounters.
    const origin=geometry(this.kart,this.track,{}).progress;
    this.opponents.forEach((o,j)=>{const gap=this.scenario==='passing'||this.scenario==='mixed'&&j===0?100+j*90:-65-j*60;
      const target=((origin+gap)%this.track.totalLen+this.track.totalLen)%this.track.totalLen;let i=1;while(i<this.track.cum.length&&this.track.cum[i]<target)i++;
      const a=this.track.spline[i-1],b=this.track.spline[i%this.track.spline.length],f=(target-this.track.cum[i-1])/Math.max(.001,(this.track.cum[i]??this.track.totalLen)-this.track.cum[i-1]),angle=Math.atan2(b.y-a.y,b.x-a.x),lane=(j%2?-1:1)*20;
      const x=a.x+(b.x-a.x)*f-Math.sin(angle)*lane,y=a.y+(b.y-a.y)*f+Math.cos(angle)*lane;Object.assign(o,{x,y,prevX:x,prevY:y,angle,totalLaps:Infinity,lapStart:null});});
    // Keep the game's real graded/grid launch. It runs before learner control.
    for(let n=0;this.race.phase!=='racing'&&n<3600;n++){this.clock+=1000/60;this.host.clock=this.clock;this.race.update(1/60);}
    if(this.race.phase!=='racing')throw Error('Native launch never reached racing');
    this.started=this.clock;this.kart.ersCharge=this.charge;
    if(options.tyreWear!==undefined)this.kart.tyreWear=options.tyreWear;
    const wear=this.config.initialTyreWearChoices;
    if(this.mode==='ai'&&!options.fixed&&wear?.length)this.kart.tyreWear=wear[Math.floor(this.random()*wear.length)];
    this.context={mode:this.mode,difficulty:w._aiDifficulty,opponents:this.opponents};this.input={steer:0,throttle:0,brake:0,ers:false,drs:false};
    this.legacyDriver=this.kart.getInput;
    if(this.config.policyPackage){const controller=makeController(this.track,this.config.policyPackage,w._aiDifficulty,this.context);controller.set(this.kart);this.state=controller.state;
      const actual=withNativePitStrategy(this.kart,this.track,w._aiDifficulty,this.mode,dt=>controller.fn(dt));this.kart.getInput=dt=>{this.input=actual(dt);return this.input;};}
    else if(this.config.driver==='legacy'){const original=this.legacyDriver;this.kart.getInput=dt=>{const input=original.call(this.kart,dt);this.input=input;return input;};}
    else{this.kart._officialML=true;this.kart._mlDriver=true;this.kart.getInput=withNativePitStrategy(this.kart,this.track,w._aiDifficulty,this.mode,()=>this.input);}
    this.steps=0;this.progress=0;this.rewardedProgress=0;this.potential=0;this.stuck=0;this.rewardTotal=0;this.contacts=0;this.offSteps=0;this.energyDeployed=0;this.drsTransitions=0;this.previousDrs=!!this.kart.drsActive;this.validity=[];this.close=new Set();this.trajectory=[];this.pendingPoints=[];this.recoveryInjected=false;this.recoveryHit=null;this.recoveryTime=null;this.legalHighWater=0;this.lastLegalProgress=0;this.defenseObject=null;this.defenseEncounter=0;this.defensiveFlags=new Set();
    this.lastG=geometry(this.kart,this.track,this.state);this.monitorPlan=null;
    if(!profiles.has(this.track.id))profiles.set(this.track.id,buildProfile(this.track));this.profile=this.config.lineProfile||profiles.get(this.track.id);
    if(options.lateralOffset||options.headingOffset){const a=this.kart.angle;this.kart.x-=Math.sin(a)*(options.lateralOffset||0);this.kart.y+=Math.cos(a)*(options.lateralOffset||0);this.kart.angle+=options.headingOffset||0;this.kart.prevX=this.kart.x;this.kart.prevY=this.kart.y;this.lastG=geometry(this.kart,this.track,this.state);}
    validateProfile(this.profile,this.track,PHYSICS_HASH);this.cornerMonitor=new CornerMonitor(this.profile);
    this.sectors=new SectorTracker(this.profile,{mode:this.mode,difficulty:w._aiDifficulty,raceLaps:this.laps,physicsHash:PHYSICS_HASH,weather:'dry',tyres:'med'});
    this.sectors.feed(this.timingPoint());this.lastObservation=observe(this.kart,this.track,this.state,this.context);this.lastAction=null;this.record();return this.lastObservation;
  }
  get time(){return (this.clock-this.started)/1000;}
  position(){const origin=this.track.cum[this.track.cpLines[0].idx]||0,distance=o=>(o.lap||0)+(((geometry(o,this.track,{}).progress-origin)%this.track.totalLen+this.track.totalLen)%this.track.totalLen)/this.track.totalLen;return 1+this.opponents.filter(o=>!o._shootoutStowed&&distance(o)>distance(this.kart)).length;}
  timingPoint(){const k=this.kart;return {t:this.time,s:this.lastG.progress-this.profile.origin,x:k.x,y:k.y,speed:k.speed,lateral:this.lastG.lateral,steer:this.input.steer,brake:this.input.brake||0,lapIndex:this.kart.lap,ersCharge:k.ersCharge,energyDeployed:this.energyDeployed,drsTransitions:this.drsTransitions,drsActive:!!k.drsActive,contacts:this.contacts,offTrack:off(k),lapStarted:k.lapStart!==null,grip:k.grip,tyreWear:k.tyreWear,tyreTemp:k.tyreTemp,maxSpeed:k.maxSpeed,suppressed:this.opponents.some(o=>Math.hypot(o.x-k.x,o.y-k.y)<350)||!!this.state.defense||this.recoveryHit!==null};}
  record(){const k=this.kart,point={...pose(k),t:this.time,offTrack:off(k),progress:this.progress/this.track.totalLen,lapStarted:k.lapStart!==null,lapIndex:k.lap,lapTimes:[...k.lapTimes],raceLaps:this.laps,racePosition:this.position(),lapTime:k.finished?k.lapTimes.at(-1):k.lapStart===null?null:(this.clock-k.lapStart)/1000,action:{...this.input},rawAction:this.lastAction||null,...(this.config.recordObservations?{observation:this.lastObservation}:{}),reward:this.rewardTotal,contacts:this.contacts,ersPower:k._ersPower||0,drsAvailable:!!k.drsAvailable,drsInZone:!!k.drsInZone,energyDeployed:this.energyDeployed,drsTransitions:this.drsTransitions,tyreWear:k.tyreWear,tyreTemp:k.tyreTemp,opponents:this.opponents.map(pose)};
    this.trajectory.push(point);if(this.config.streamTrajectories){this.pendingPoints.push(point);if(this.trajectory.length>600)this.trajectory.shift();}}
  takePoints(force=false){if(!force&&this.pendingPoints.length<100)return [];const rows=this.pendingPoints;this.pendingPoints=[];return rows;}
  expert(){if(this.config.teacherSource==='legacy'){const a=this.legacyDriver.call(this.kart,1/20);return [a.steer??(+!!a.right-+!!a.left),(a.throttle??+!!a.up)*2-1,(a.brake??+!!a.down)*2-1,a.ers?1:-1];}
    const parameters=this.config.teacherParameters||this.plan?.parameters||initialParameters(this.track,{classic:false,speed:.65,energy:0});
    if(!this.plan||this.plan.parameters.toString()!==parameters.toString())this.plan=makePlan(this.track,parameters);
    const speeds=speedEnvelope(this.plan,this.kart.maxSpeed,this.kart.brakeForce).map(v=>v*(this.config.teacherSpeedScale||1));return plannedAction(this,this.plan,speeds);}
  step(action){
    this.bind();this.lastAction=this.config.policyPackage||this.config.driver==='legacy'?null:action;const oldSteer=this.state.steer||0;if(!this.config.policyPackage&&this.config.driver!=='legacy')this.input=actionToInput(action,this.kart,this.track,this.state,this.context);let rewarded=0,delta=0,offTicks=0,newContact=0,windows=[];
    for(let i=0;i<3&&!this.kart.finished;i++){
      const k=this.kart,before=k.lapTimes.length,validBefore=!k._ghostLapInvalid&&(k._ghostOffTrackAcc||0)<1.5;
      if(this.scenario==='recovery'&&!this.recoveryInjected&&this.time>=4&&this.opponents.length){const o=this.opponents[0];o.x=k.x+Math.cos(k.angle)*18;o.y=k.y+Math.sin(k.angle)*18;o.speed=k.speed*.5;this.recoveryInjected=true;}
      this.clock+=1000/60;this.host.clock=this.clock;this.race.update(1/60);
      if(k.lapTimes.length>before)this.validity.push(validBefore);
      if(k.ersActive)this.energyDeployed+=1/300;
      if(!!k.drsActive!==this.previousDrs){this.drsTransitions++;this.previousDrs=!!k.drsActive;}
      for(const o of this.opponents){const near=Math.hypot(o.x-k.x,o.y-k.y)<34;if(near&&!this.close.has(o.id)){this.contacts++;newContact++;if(this.recoveryHit===null)this.recoveryHit=this.time;}if(near)this.close.add(o.id);else this.close.delete(o.id);}
      const g=geometry(k,this.track,this.state);let d=g.progress-this.lastG.progress;if(d>this.track.totalLen/2)d-=this.track.totalLen;if(d<-this.track.totalLen/2)d+=this.track.totalLen;
      if(Math.abs(d)>Math.max(5,Math.abs(k.speed)/60*2))d=0;
      const defense=this.state.defense;if(defense&&defense!==this.defenseObject){this.defenseObject=defense;this.defenseEncounter++;}
      if(defense?.used&&!this.close.size&&Math.abs(g.lateral-defense.lane)>this.track.trackWidth*.15)this.defensiveFlags.add(this.defenseEncounter);
      this.lastG=g;this.progress+=d;delta+=d;rewarded+=(off(k)||k.speed<0)?Math.min(0,d):d;offTicks+=+off(k);this.offSteps+=+off(k);windows.push(...this.sectors.feed(this.timingPoint()));
      if(this.config.revision===3){if(!this.monitorPlan)this.monitorPlan=makePlan(this.track,this.config.teacherParameters||initialParameters(this.track,{speed:.65}));
        const envelope=speedEnvelope(this.monitorPlan,k.maxSpeed,k.brakeForce),u=((g.progress-this.profile.origin)%this.track.totalLen+this.track.totalLen)%this.track.totalLen;
        this.cornerMonitor.feed(this.timingPoint(),envelope[Math.floor(u/this.track.totalLen*envelope.length)%envelope.length],k.brakeForce);}
      if(this.recoveryHit!==null&&this.recoveryTime===null&&this.time-this.recoveryHit>.5&&k.speed>50&&!off(k))this.recoveryTime=this.time-this.recoveryHit;
    }
    this.steps++;this.stuck=this.kart.speed<12||delta<.5?this.stuck+.05:Math.max(0,this.stuck-.1);this.state.stuckSeconds=this.stuck;
    if(!off(this.kart)&&this.progress>this.legalHighWater+2){this.legalHighWater=this.progress;this.lastLegalProgress=this.time;}
    if(this.kart.inPit||this.kart.pitPhase!==null)this.lastLegalProgress=this.time;
    const completed=this.kart.finished&&this.kart.lapTimes.length===this.laps,validLap=completed&&this.validity.length===this.laps&&this.validity.every(Boolean),finished=!!validLap;
    const noProgress=this.config.revision===3&&!this.kart.inPit&&this.kart.pitPhase==null&&this.time-this.lastLegalProgress>(this.recoveryHit!==null&&this.time-this.recoveryHit<10?10:5);
    const failed=noProgress||this.stuck>6||Math.abs(this.lastG.lateral)>this.track.trackWidth*1.7||(this.kart.finished&&!finished);
    const truncated=this.time>Number(this.config.episodeSeconds||Math.max(180,this.laps*this.track.totalLen/(90*(PACE[this.config.difficulty]||1))));
    this.rewardedProgress+=rewarded;const potential=finished||failed?0:100*Math.max(0,Math.min(1,this.rewardedProgress/(this.track.totalLen*this.laps)));
    const pace=PACE[this.config.difficulty]||1,target=this.kart.maxSpeed*pace,bonus=this.sectors.reward(windows,this.profile.baselines||[],this.config.lineGuidance!==false);
    const rewardComponents={progress:Number(this.config.gamma??.9995)*potential-this.potential,time:-.03/this.laps,finish:finished?100:0,position:finished&&this.mode==='ai'?20*(this.opponents.length+1-this.position())/Math.max(1,this.opponents.length):0,failure:failed||truncated?-100:0,offTrack:-offTicks/3,contact:-6*newContact,smoothness:-Math.abs((this.input.steer??(+!!this.input.right-+!!this.input.left))-oldSteer)*.03,pace:pace<1?-(Math.max(0,this.kart.speed/Math.max(1,target)-1)**2)*5:0,racingLine:bonus.style,miniSector:bonus.timing};
    this.potential=potential;const reward=Object.values(rewardComponents).reduce((a,b)=>a+b,0);this.rewardTotal+=reward;this.record();
    const done=finished||failed||truncated,info={environmentVersion:this.config.revision===3?8:ENVIRONMENT_VERSION,rewardVersion:this.config.revision===3?'v3-taught-corner-1':'v2-native-line-1',failureReason:noProgress?'no legal progress':failed?'departure, invalid lap or stuck':truncated?'timeout':null,profileHash:this.profile.profileHash,environment:this.index,episodeId:this.episode,decisions:this.steps,mode:this.mode,scenario:this.scenario,raceLaps:this.laps,lapTimes:[...this.kart.lapTimes],raceTime:completed?this.kart.lapTimes.reduce((a,b)=>a+b,0):null,racePosition:this.position(),validLaps:[...this.validity],finished,validLap,lapTime:finished?this.kart.lapTimes[0]:null,offTrackRate:this.offSteps/Math.max(1,this.steps*3),offTrackSeconds:this.offSteps/60,contacts:this.contacts,energyDeployed:this.energyDeployed,drsTransitions:this.drsTransitions,recoveryTime:this.recoveryTime,recoveryInjected:this.recoveryInjected,defensiveReversalFlags:this.defensiveFlags.size,defensiveCorrections:this.state.defensiveCorrections||0,progress:this.progress/this.track.totalLen,rewardComponents,...(done?{cornerDiagnostics:this.cornerMonitor.finish(this.sectors.finish().windows),miniSectors:this.sectors.finish(),styleScore:styleScore(this.sectors.finish())}:{})};
    const observation=observe(this.kart,this.track,this.state,this.context);this.lastObservation=observation;
    return {observation,reward,done,terminated:finished||failed,truncated:truncated&&!finished&&!failed,info};
  }
  snapshot(){return {environment:this.index,episode:this.episode,mode:this.mode,time:this.time,car:{...pose(this.kart),offTrack:off(this.kart)},opponents:this.opponents.map(pose),reward:this.rewardTotal,progress:this.progress/this.track.totalLen,path:this.trajectory.slice(-500).map(p=>({t:p.t,x:p.x,y:p.y,a:p.a,speed:p.speed,offTrack:p.offTrack,ersCharge:p.ersCharge,ersActive:p.ersActive,drsActive:p.drsActive}))};}
}
export function metadata(){return {physicsHash:PHYSICS_HASH,environmentVersion:ENVIRONMENT_VERSION,observationVersion:2,observationNames:OBSERVATION_NAMES,actionCount:4,actionNames:ACTION_NAMES,startMode:'native-grid-and-graded-launch',tracks:TRACKS.map(t=>({id:t.id,name:t.name,fingerprint:trackFingerprint(t),length:t.totalLen,width:t.trackWidth,spline:t.spline,cpLines:t.cpLines,cum:t.cum}))};}
