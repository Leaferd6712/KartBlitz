import { PHYSICS_HASH } from './official-contract.mjs';
export { PHYSICS_HASH };
export const DIFFICULTIES = ['ultraeasy','easy','medium','hard','extreme'];
export const PACE = { ultraeasy: .50, easy: .62, medium: .76, hard: .90, extreme: 1 };
export const DECISION_DT = 3 / 60;
export function trackFingerprint(track){
  let hash=2166136261;
  for(const value of [track.trackWidth,...track.spline.flatMap(p=>[p.x,p.y])]){
    const n=Math.round(value*100);hash=Math.imul(hash^(n&65535),16777619);hash=Math.imul(hash^(n>>>16),16777619);
  }
  return (hash>>>0).toString(16);
}
export const OBSERVATION_NAMES = ['speed','lateral','headingSin','headingCos','yawRate','grip','maxSpeed','accel','brakeForce','turnRate','tyreWear','tyreTemp','ersCharge','drsZone','previousSteer','previousThrottle','previousBrake','shootout','pace','defensiveMoveRemaining',
  ...[60,140,280,500,800].flatMap(d => [`look${d}Forward`,`look${d}Side`]), 'leftMargin','rightMargin',
  ...[0,1,2].flatMap(i => [`opponent${i}Forward`,`opponent${i}Side`,`opponent${i}RelativeSpeed`,`opponent${i}Heading`,`opponent${i}Present`]), 'stuckTime'];
const clamp = (v, a=-1, b=1) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : 0));
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
export function geometry(kart, track, state) {
  const spl = track.spline, n = spl.length;
  const anchor = Number.isInteger(state.nearest) ? state.nearest : null;
  let best = anchor ?? 0, distance = Infinity;
  const start = anchor === null ? 0 : -30, end = anchor === null ? n : 90;
  for (let d = start; d < end; d++) {
    const i = anchor === null ? d : (anchor + d + n) % n, p = spl[i];
    const dd = (kart.x-p.x)**2 + (kart.y-p.y)**2;
    if (dd < distance) { distance = dd; best = i; }
  }
  // Grid/pit-stage redeployments can move a car outside the local search window.
  if(anchor!==null&&distance>(track.trackWidth*2)**2){state.nearest=null;return geometry(kart,track,state);}
  state.nearest = best;
  const a = spl[(best-1+n)%n], b = spl[(best+1)%n];
  const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy)||1, tx=dx/len, ty=dy/len;
  const lateral=(kart.x-spl[best].x)*-ty+(kart.y-spl[best].y)*tx;
  return { index:best, tx,ty,lateral, heading:wrap(Math.atan2(ty,tx)-kart.angle),
    progress:(track.cum[best]||0)+(kart.x-spl[best].x)*tx+(kart.y-spl[best].y)*ty };
}
function ahead(track, index, distance) {
  const target=((track.cum[index]+distance)%track.totalLen+track.totalLen)%track.totalLen;
  let lo=0,hi=track.cum.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(track.cum[mid]<target)lo=mid+1;else hi=mid;}
  return track.spline[lo];
}
export function observe(kart, track, state, context={}) {
  const g=geometry(kart,track,state), half=Math.max(1,track.trackWidth*.5);
  const nearby=(context.opponents||[]).filter(k=>k!==kart&&!k.finished&&!k._shootoutStowed)
    .map(k=>({k,d:Math.hypot(k.x-kart.x,k.y-kart.y)})).sort((a,b)=>a.d-b.d).slice(0,3);
  const angle=kart.angle,c=Math.cos(angle),s=Math.sin(angle);
  const obs=[clamp(kart.speed/500,-1,1.5),clamp(g.lateral/half,-3,3),Math.sin(g.heading),Math.cos(g.heading),
    clamp(wrap(angle-(state.lastAngle??angle))/DECISION_DT/3),clamp(kart.grip/1.2,0,2),clamp(kart.maxSpeed/500,0,2),clamp(kart.accel/200,0,3),clamp(kart.brakeForce/800,0,3),clamp(kart.turnRate/3,0,3),
    clamp(kart.tyreWear,0,1),clamp(kart.tyreTemp/120,0,2),clamp(kart.ersCharge,0,1),+(!!kart.drsInZone&&!!kart.drsAvailable),state.steer||0,state.throttle||0,state.brake||0,+(context.mode==='shootout'),PACE[context.difficulty]||1,+(state.defense?.used!==true)];
  for(const d of [60,140,280,500,800]){const p=ahead(track,g.index,d),dx=p.x-kart.x,dy=p.y-kart.y;obs.push(clamp((dx*c+dy*s)/d,-3,3),clamp((-dx*s+dy*c)/d,-3,3));}
  obs.push(clamp(1-g.lateral/half,-2,2),clamp(1+g.lateral/half,-2,2));
  for(let i=0;i<3;i++){const other=nearby[i]?.k;if(!other){obs.push(0,0,0,0,0);continue;}const dx=other.x-kart.x,dy=other.y-kart.y;obs.push(clamp((dx*c+dy*s)/400,-3,3),clamp((-dx*s+dy*c)/track.trackWidth,-3,3),clamp((other.speed-kart.speed)/300),Math.sin(other.angle-angle),1);}
  obs.push(clamp((state.stuckSeconds||0)/5,0,1));state.lastAngle=angle;
  return obs;
}
export function teacher(kart,track,state,pace=1,lane=0) {
  const g=geometry(kart,track,state), look=70+Math.abs(kart.speed)*.4;
  const p=ahead(track,g.index,look), aim=Math.atan2(p.y+g.tx*lane-kart.y,p.x-g.ty*lane-kart.x);
  const turn=wrap(aim-kart.angle), far=ahead(track,g.index,Math.max(180,kart.speed*1.3));
  const bend=Math.abs(wrap(Math.atan2(far.y-kart.y,far.x-kart.x)-kart.angle));
  const target=Math.max(65,kart.maxSpeed*pace*(1-Math.min(.75,bend*.7)));
  return [clamp(turn*2.1),kart.speed<target?1:-.8,kart.speed>target+12?1:-1,Math.abs(turn)<.12&&kart.speed>150?1:-1,Math.abs(turn)<.15?1:-1];
}
/** One defensive lane change per sustained attacking encounter; corners use track-relative position. */
function defend(input,kart,track,state,context) {
  const g=geometry(kart,track,state), half=track.trackWidth*.5;
  const attacker=(context.opponents||[]).find(k=>{if(k===kart||k.finished)return false;const dx=k.x-kart.x,dy=k.y-kart.y;const forward=dx*g.tx+dy*g.ty,side=dx*-g.ty+dy*g.tx;return forward<0&&forward>-350&&Math.abs(side)<track.trackWidth;});
  let d=state.defense;
  if(!attacker){if(d){d.clear=(d.clear||0)+DECISION_DT;if(d.clear>2)state.defense=null;}return input;}
  if(!d){state.defense=d={attacker:attacker.id,start:g.lateral,used:false,clear:0};}
  d.clear=0;
  if(!d.used&&Math.abs(g.lateral-d.start)>half*.3){d.used=true;d.lane=clamp(g.lateral,-half*.72,half*.72);}
  if(d.used&&Math.abs(g.lateral-d.lane)>half*.12){
    // Hold the lane already chosen. This same constraint runs during learning and races.
    const correction=teacher(kart,track,{},1,d.lane);
    input.steer=correction[0];state.defensiveCorrections=(state.defensiveCorrections||0)+1;
  }
  return input;
}
export function actionToInput(action,kart,track,state,context={}) {
  const target=action.map(v=>clamp(v));
  let throttle=(target[1]+1)*.5,brake=(target[2]+1)*.5;
  if(brake>.1)throttle*=Math.max(0,1-brake*1.4);if(brake<.04)brake=0;
  state.steer=(state.steer||0)+(target[0]-(state.steer||0))*.5;
  state.throttle=(state.throttle||0)+(throttle-(state.throttle||0))*.4;
  state.brake=(state.brake||0)+(brake-(state.brake||0))*.5;
  const input={steer:state.steer,throttle:state.throttle,brake:state.brake,
    up:state.throttle>.1,down:state.brake>.1,left:state.steer<-.1,right:state.steer>.1,
    ers:target[3]>0&&kart.ersCharge>.01&&!kart.isOffTrack,drs:target[4]>0&&kart.drsAvailable&&!kart.isOffTrack,pit:false};
  return context.mode==='ai'?defend(input,kart,track,state,context):input;
}
export function validatePackage(pack) {
  if(pack?.format!=='kartblitz-official-track-v1'||!Number.isInteger(pack.trackId)||pack.trackId<0||pack.trackId>7||!pack.variants||!Object.keys(pack.variants).length)throw new Error('Not an Official KartBlitz track model');
  if(pack.physicsHash!==PHYSICS_HASH)throw new Error('Model physics differ from this game build; retrain or export against the matching build');
  if(pack.observationVersion!==1||pack.observationCount!==OBSERVATION_NAMES.length)throw new Error('Official observation contract differs');
  if(typeof pack.trackFingerprint!=='string')throw new Error('Missing trained track geometry');
  for(const [difficulty,model] of Object.entries(pack.variants)){
    if(!DIFFICULTIES.includes(difficulty))throw new Error('Unknown difficulty');
    let inputs=OBSERVATION_NAMES.length;
    if(!model.policy?.layers?.length)throw new Error('Missing learned weights');
    for(const layer of model.policy.layers){if(!Array.isArray(layer.bias)||!Array.isArray(layer.kernel)||layer.bias.length!==layer.kernel.length||layer.bias.some(v=>!Number.isFinite(v))||layer.kernel.some(row=>!Array.isArray(row)||row.length!==inputs||row.some(v=>!Number.isFinite(v))))throw new Error('Invalid policy weights');inputs=layer.bias.length;}
    if(inputs!==5)throw new Error('Expected five learned controls');
  }
  return true;
}
export function forward(policy,observation){let values=observation;for(let i=0;i<policy.layers.length;i++){const l=policy.layers[i];values=l.kernel.map((row,r)=>row.reduce((sum,w,c)=>sum+w*values[c],l.bias[r]));if(i<policy.layers.length-1)values=values.map(Math.tanh);}return values.map(v=>clamp(v));}
export function makeController(track,pack,difficulty,context={}) {
  if(pack.trackFingerprint!==trackFingerprint(track))throw new Error('Track layout differs from the trained track');
  validatePackage(pack);const model=pack.variants[difficulty];if(!model)throw new Error(`No ${difficulty} weights for this track`);
  let kart=null,held=null,elapsed=DECISION_DT,lastProgress=null;const state={};
  return {set(k){kart=k;k._officialML=true;k._mlDriver=true;k.mlModelName=pack.name;k.mlModelId=model.id;},
    fn(dt=1/60){if(!kart)return {steer:0,throttle:0,brake:0};
      if(!held||elapsed>=DECISION_DT-1e-8){elapsed=0;const c={...context,difficulty,opponents:context.getOpponents?.()||context.opponents||[]};
        const g=geometry(kart,track,state);if(lastProgress!==null){let delta=g.progress-lastProgress;if(delta>track.totalLen/2)delta-=track.totalLen;if(delta<-track.totalLen/2)delta+=track.totalLen;
          state.stuckSeconds=kart.speed<12||delta<.5?(state.stuckSeconds||0)+DECISION_DT:Math.max(0,(state.stuckSeconds||0)-.1);
          if(Math.abs(delta)>Math.max(100,Math.abs(kart.speed)*DECISION_DT*6)){state.defense=null;state.stuckSeconds=0;state.lastAngle=kart.angle;}}
        lastProgress=g.progress;held=actionToInput(forward(model.policy,observe(kart,track,state,c)),kart,track,state,c);}elapsed+=dt;return held;}, state};
}

export const packages=new Map();
function database(){return new Promise((resolve,reject)=>{const r=indexedDB.open('kartblitz-official-models',1);r.onupgradeneeded=()=>r.result.createObjectStore('tracks',{keyPath:'trackId'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function loadPackages(){if(typeof indexedDB==='undefined')return;const db=await database();try{const rows=await new Promise((resolve,reject)=>{const r=db.transaction('tracks').objectStore('tracks').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});for(const pack of rows){try{validatePackage(pack);packages.set(pack.trackId,pack);}catch{}}}finally{db.close();}}
export async function installPackage(pack){validatePackage(pack);const db=await database();try{await new Promise((resolve,reject)=>{const tx=db.transaction('tracks','readwrite');tx.objectStore('tracks').put(pack);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});packages.set(pack.trackId,pack);}finally{db.close();}}
