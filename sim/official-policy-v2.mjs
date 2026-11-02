/** Energy-aware contract. V1 stays byte-for-byte unchanged during its campaign. */
import * as v1 from './official-policy.mjs';
export const OBSERVATION_VERSION=2;
export const ACTION_NAMES=['steer','throttle','brake','ers'];
export const OBSERVATION_NAMES=[...v1.OBSERVATION_NAMES,'lapPhaseSin','lapPhaseCos','raceLength','raceDistanceRemaining','ersActive','ersPower','previousErs','straightHarvestTimer','drsActive'];
export function raceState(kart,track,context={}) {
  const total=context.mode==='shootout'?1:Math.max(1,kart.totalLaps||1);
  const g=v1.geometry(kart,track,{}),origin=track.cum[track.cpLines[0].idx]||0;
  const phase=((g.progress-origin)%track.totalLen+track.totalLen)%track.totalLen/track.totalLen;
  const completed=Math.max(0,kart.lap||0);
  const remaining=kart.finished?0:kart.lapStart===null?total:Math.max(0,total-completed-phase);
  return {total,phase,remaining};
}
export function observe(kart,track,state,context={}) {
  const base=v1.observe(kart,track,state,context),r=raceState(kart,track,context);
  return [...base,Math.sin(r.phase*Math.PI*2),Math.cos(r.phase*Math.PI*2),r.total/10,r.remaining/10,
    +!!kart.ersActive,kart._ersPower||0,+!!state.ers,Math.min(1,(kart._ersStraightTimer||0)/5),+!!kart.drsActive];
}
export function actionToInput(action,kart,track,state,context={}) {
  // DRS is a held intent, not a repeated key press. Physics owns zone/eligibility.
  const input=v1.actionToInput([...action.slice(0,4),1],kart,track,state,context);
  state.ers=input.ers;return input;
}
export function validatePackage(pack) {
  if(pack?.format!=='kartblitz-official-track-v2'||pack.modelGeneration!==2||pack.observationVersion!==2||pack.observationCount!==OBSERVATION_NAMES.length||pack.actionCount!==4)throw Error('Invalid V2 energy contract');
  // Match V1 geometry/finite-weight validation with the actual V2 dimensions.
  if(pack.physicsHash!==v1.PHYSICS_HASH)throw Error('Model physics differ from this game build; retrain or export against the matching build');
  if(!Number.isInteger(pack.trackId)||pack.trackId<0||pack.trackId>7||!pack.variants||!Object.keys(pack.variants).length||typeof pack.trackFingerprint!=='string')throw Error('Invalid V2 track model');
  if(JSON.stringify(pack.observationNames)!==JSON.stringify(OBSERVATION_NAMES)||JSON.stringify(pack.actionNames)!==JSON.stringify(ACTION_NAMES))throw Error('V2 observation/action order differs');
  for(const [difficulty,model] of Object.entries(pack.variants)){
    if(!v1.DIFFICULTIES.includes(difficulty)||!model.policy?.layers?.length)throw Error('Invalid V2 difficulty or policy');
    let width=OBSERVATION_NAMES.length;
    for(const layer of model.policy.layers){
      if(!Array.isArray(layer.bias)||!Array.isArray(layer.kernel)||!layer.bias.length||layer.bias.length!==layer.kernel.length||layer.bias.some(x=>!Number.isFinite(x))||layer.kernel.some(row=>!Array.isArray(row)||row.length!==width||row.some(x=>!Number.isFinite(x))))throw Error('Invalid V2 policy weights');
      width=layer.bias.length;
    }
    if(width!==4)throw Error('Expected four V2 learned controls');
  }
  return true;
}
export function makeController(track,pack,difficulty,context={}) {
  validatePackage(pack);
  if(pack.trackFingerprint!==v1.trackFingerprint(track))throw Error('Track layout differs from the trained track');
  const model=pack.variants[difficulty];if(!model)throw Error('Missing V2 difficulty');
  let kart,elapsed=v1.DECISION_DT,held,lastProgress=null;const state={};
  return {state,set(k){kart=k;k._officialML=true;k._mlDriver=true;k.mlModelName=pack.name;k.mlModelId=model.id;},fn(dt=1/60){
    if(!kart)return {steer:0,throttle:0,brake:0,ers:false,drs:false};
    if(!held||elapsed>=v1.DECISION_DT-1e-8){
      elapsed=0;const c={...context,difficulty,opponents:context.getOpponents?.()||context.opponents||[]};
      const g=v1.geometry(kart,track,state);
      if(lastProgress!==null){let d=g.progress-lastProgress;if(d>track.totalLen/2)d-=track.totalLen;if(d<-track.totalLen/2)d+=track.totalLen;
        state.stuckSeconds=kart.speed<12||d<.5?(state.stuckSeconds||0)+v1.DECISION_DT:Math.max(0,(state.stuckSeconds||0)-.1);
        if(Math.abs(d)>Math.max(100,Math.abs(kart.speed)*v1.DECISION_DT*6)){state.defense=null;state.stuckSeconds=0;state.lastAngle=kart.angle;}}
      lastProgress=g.progress;held=actionToInput(v1.forward(model.policy,observe(kart,track,state,c)),kart,track,state,c);
    }
    elapsed+=dt;return held;
  }};
}
