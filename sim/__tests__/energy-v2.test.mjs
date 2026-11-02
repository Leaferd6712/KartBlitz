import assert from 'node:assert/strict';
import {Environment,officialTracks,RACE_LENGTHS,START_CHARGES} from '../../ml_training/official-worker-v2.mjs';
import * as v1 from '../official-policy.mjs';
import * as v2 from '../official-policy-v2.mjs';
import {displayName,validatePackage,generation} from '../official-runtime.mjs';
import {acceptance,evaluationCases} from '../energy-evaluation.mjs';

for(const track of officialTracks){
  const env=new Environment(0,{trackId:track.id,mode:'ai',randomization:false});
  const sampled=new Set(),charges=new Set();
  for(let i=0;i<160;i++){const obs=env.reset();assert.equal(obs.length,57);assert(obs.every(Number.isFinite));sampled.add(env.kart.totalLaps);charges.add(env.kart.ersCharge);}
  assert.deepEqual([...sampled].sort((a,b)=>a-b),RACE_LENGTHS);assert.deepEqual([...charges].sort((a,b)=>a-b),START_CHARGES);
  env.reset({mode:'shootout',raceLaps:10,energy:.25});assert.equal(env.kart.totalLaps,1);assert.equal(env.kart.ersCharge,.25);
}
console.log('V2: every track samples all supported race lengths and charges; Shootout stays one lap.');

const env=new Environment(0,{trackId:0,mode:'ai',raceLaps:3,randomization:false});env.reset({energy:.5});
let laps=0,result,crossings=0;
for(let i=0;i<14000;i++){
  const charge=env.kart.ersCharge;
  result=env.step(v1.teacher(env.kart,env.track,{},.42).slice(0,4));
  if(env.kart.lap>laps){assert(Math.abs(env.kart.ersCharge-charge)<.02,'No battery refill at a race lap crossing');crossings++;laps=env.kart.lap;}
  if(result.done)break;
}
assert(result.info.finished,'Actual physics driver finishes all three laps');assert.equal(crossings,3);assert.equal(result.info.lapTimes.length,3);
assert(Math.abs(result.info.raceTime-result.info.lapTimes.reduce((a,b)=>a+b,0))<1e-8);assert(result.info.validLaps.every(Boolean));
assert.equal(env.trajectory.at(-1).raceLaps,3);assert.equal(env.trajectory.at(-1).lapTimes.length,3);
assert.equal(v2.raceState(env.kart,env.track,{mode:'ai'}).remaining,0);
const independent=new Environment(1,{trackId:0,mode:'ai',raceLaps:3,randomization:false});independent.reset({energy:.25});assert.equal(independent.kart.ersCharge,.25);
console.log('V2: real three-lap race clock, valid laps, carried battery and isolated resets verified.');

const drs=new Environment(0,{trackId:0,mode:'shootout',randomization:false});let inZone=true;
drs.kart._inDrsZone=()=>inZone;
for(let i=0;i<40;i++){drs.step([0,1,-1,(i%2?1:-1)]);assert(drs.input.drs);assert(drs.kart.drsActive);}
inZone=false;drs.step([0,1,-1,1]);assert(!drs.kart.drsActive);
inZone=true;drs.kart.drsAvailable=false;drs.step([0,1,-1,1]);assert(!drs.kart.drsActive);
drs.kart.drsAvailable=true;drs.step([0,1,-1,-1]);assert(drs.kart.drsActive);
console.log('V2: noisy learned actions cannot switch DRS; actual zone and availability still gate it.');
const farm=new Environment(0,{trackId:0,mode:'ai',raceLaps:1,randomization:false});
farm.rewardedProgress=farm.track.totalLen*3;farm.rewardPotential=100;
const extra=farm.step([0,1,-1,-1]);assert(extra.info.rewardComponents.progress<=0,'Extra distance beyond the race cannot earn more shaping reward');
const failure=new Environment(0,{trackId:0,mode:'ai',raceLaps:10,randomization:false});failure.stuck=7;
assert.equal(failure.step([0,-1,-1,-1]).info.rewardComponents.failure,-100);

const policy={layers:[{kernel:Array.from({length:4},()=>Array(57).fill(0)),bias:[0,1,-1,-1]}]};
const pack={format:'kartblitz-official-track-v2',modelGeneration:2,name:'Sunset energy',trackId:0,physicsHash:v1.PHYSICS_HASH,
  trackFingerprint:v1.trackFingerprint(officialTracks[0]),observationVersion:2,observationCount:57,observationNames:v2.OBSERVATION_NAMES,actionCount:4,actionNames:v2.ACTION_NAMES,variants:{extreme:{id:'v2',policy}}};
assert(validatePackage(pack));assert.equal(generation(pack),2);assert.equal(displayName(pack),'V2 · Sunset energy');
assert.equal(displayName({name:'Current campaign'}),'V1 · Current campaign');assert.equal(displayName({name:'V1 · Current campaign'}),'V1 · Current campaign');
assert.throws(()=>validatePackage({...pack,observationNames:[...pack.observationNames].reverse()}));
const controller=v2.makeController(officialTracks[0],pack,'extreme',{mode:'ai'});controller.set(independent.kart);assert.equal(controller.fn().drs,true);
assert.throws(()=>v1.validatePackage(pack));
const cases=evaluationCases();assert.equal(cases.length,26);
const rows=['Legacy','V1','V2'].flatMap(arm=>cases.map(c=>({...c,arm,finished:true,valid:true,offTrackRate:0,defensiveReversalFlags:0,raceTime:arm==='V2'?20:21,racePosition:1,contacts:c.scenario==='recovery'?1:0,recoveryTime:1})));
assert(acceptance(rows,true).approved);assert(!acceptance(rows,false).approved);
assert(!acceptance(rows.map(r=>r.arm==='V2'?{...r,raceTime:30}:r),true).approved);
assert(!acceptance(rows.map(r=>r.arm==='V2'?{...r,raceTime:21}:r),true).approved,'Matching V1 without an improvement is not promotion');
assert(!acceptance(rows.map(r=>r.arm==='V2'?{...r,defensiveReversalFlags:1}:r),true).approved);
assert(!acceptance([],false).approved);
console.log('V2 contract, V1 names, controller, matched case coverage and rejection gates passed.');
