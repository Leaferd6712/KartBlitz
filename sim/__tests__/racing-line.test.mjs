import assert from 'node:assert/strict';
import {officialTracks,Environment,referenceAction} from '../../ml_training/official-worker-v2.mjs';
import {buildProfile,validateProfile,SectorTracker,matchedWindow,styleScore} from '../racing-line.mjs';
import {PHYSICS_HASH,geometry} from '../official-policy.mjs';
import {refine} from '../../scripts/build-racing-line.mjs';
for(const track of officialTracks){
  const p=buildProfile(track),q=buildProfile(track,Object.fromEntries(p.corners.map(c=>[c.id,{entryScale:.4,apexScale:.5,exitScale:.7,apexShift:.1}])));
  assert(p.corners.length>0);assert(validateProfile(p,track,PHYSICS_HASH));assert.equal(p.timingHash,q.timingHash);assert.notEqual(p.profileHash,q.profileHash);
  assert(p.windows.every(w=>w.start<=w.via[0]+1e-5&&w.via[2]<=w.end+1e-5&&w.end>w.start));
  const e=new Environment(0,{trackId:track.id,mode:'ai',randomization:false});
  for(const point of p.reference){Object.assign(e.kart,{x:point.x,y:point.y});e.kart._nearestSplineIdx=geometry(e.kart,track,{}).index;assert(e.kart.onTrack(track),'Reference remains on the real road');}
}
console.log('All tracks: deterministic legal reference, linked corners, fixed gates across line refinements.');

const L=4000,corners=[{id:'A',entry:50,apex:100,exit:200},{id:'B',entry:300,apex:400,exit:500},{id:'C',entry:600,apex:700,exit:800}];
const profile={profileHash:'test',timingHash:'gates',length:L,width:100,origin:0,centerline:[{x:0,y:0},{x:1000,y:0},{x:1000,y:1000},{x:0,y:1000}],cum:[0,1000,2000,3000],
  reference:[{s:0,x:0,y:0,offset:0},{s:1000,x:1000,y:0,offset:0},{s:2000,x:1000,y:1000,offset:0},{s:3000,x:0,y:1000,offset:0}],corners,
  gates:corners.flatMap(c=>['entry','apex','exit'].map(kind=>({id:c.id+'-'+kind,s:c[kind],x:c[kind],y:0,tx:1,ty:0}))),windows:[{id:'B',start:200,end:600,via:[300,400,500],complex:'B'}]};
const context={mode:'ai',difficulty:'extreme',raceLaps:1,physicsHash:PHYSICS_HASH,weather:'dry',tyres:'med'};
const point=(x,t=x/20,extra={})=>({x,y:0,s:x,t,speed:20,lateral:0,steer:0,ersCharge:.5,energyDeployed:0,drsTransitions:0,contacts:0,offTrack:false,lapStarted:true,grip:.8,tyreWear:0,tyreTemp:90,maxSpeed:500,...extra});
const tracker=new SectorTracker(profile,context);for(let x=101;x<=701;x+=3)tracker.feed(point(x));
const row=tracker.finish().windows[0];assert(row.valid);assert(Math.abs(row.time-20)<1e-9);assert.equal(row.entrySpeed,20);assert.equal(row.exitSpeed,20);assert.equal(row.nextEntrySpeed,20);
assert.equal(row.minimumCornerSpeed,20);assert.equal(tracker.finish().windows.length,1,'Reading partials must not mutate timing');
const frozen={...row,time:24};const paid=tracker.reward([row],[frozen]);assert(paid.style>0&&paid.timing>0);
assert.deepEqual(tracker.reward([row],[frozen]),{style:0,timing:0},'No repeated sector payments');
assert(matchedWindow(row,{...row,profileHash:'different line, same gates'}));
assert(!matchedWindow(row,{...row,conditions:{...row.conditions,entryCharge:.9}}));
assert(!matchedWindow(row,{...row,energyDeployed:.2}),'Extra boost cannot masquerade as a line improvement');
assert(!matchedWindow(row,{...row,batteryEnd:.2}));assert(!matchedWindow(row,{...row,drsSeconds:.3}));
const slowApexFastExit={...row,id:'better exit',time:20,minimumCornerSpeed:60},fastApexSlowExit={...slowApexFastExit,time:24,minimumCornerSpeed:90};
assert.equal(new SectorTracker(profile,context).reward([fastApexSlowExit],[slowApexFastExit]).timing,0,'A fast apex cannot mask a slower complete window');
assert(new SectorTracker(profile,context).reward([slowApexFastExit],[fastApexSlowExit]).timing>0);
const cap=new SectorTracker(profile,context),many=Array.from({length:100},(_,i)=>({...row,id:String(i)}));const capped=cap.reward(many,many.map(r=>({...r,time:40})));assert(capped.style+capped.timing<=5);
for(const change of [{suppressed:true},{valid:false},{partial:true},{maxSteerJump:.5}])assert.deepEqual(new SectorTracker(profile,context).reward([{...row,...change}],[frozen]),{style:0,timing:0});
for(const kind of ['reverse','teleport','stop','offTrack']){
  const bad=new SectorTracker(profile,context);let t=0;
  for(let x=101;x<=701;x+=3){bad.feed(point(x,t));t+=.15;
    if(x===401){if(kind==='reverse'){bad.feed(point(x-3,t,{speed:-20}));t+=.15;}if(kind==='stop'){bad.feed(point(x,t,{speed:0}));t+=.15;}if(kind==='teleport'){bad.feed(point(550,t));t+=.15;}if(kind==='offTrack'){bad.feed(point(x+1,t,{offTrack:true}));t+=.15;}}}
  assert(!bad.finish().windows.some(r=>r.valid),kind+' cannot earn a valid window');
}
const partial=new SectorTracker(profile,context);for(let x=350;x<=701;x+=3)partial.feed(point(x));assert(partial.finish().windows[0].partial);assert(!partial.finish().windows[0].valid);
console.log('Interpolated full-window timing, exit-speed tradeoff, matched states, 5% cap and reverse/stop/skip/partial protection.');

const real=new Environment(0,{trackId:0,mode:'ai',raceLaps:3,randomization:false});let result;
for(let i=0;i<16000;i++){result=real.step(referenceAction(real,.42));if(result.done)break;}
assert(result.info.finished);const timing=result.info.miniSectors;assert(timing.windows.some(w=>w.valid&&w.end>real.kart.lapTimes[0]));assert(timing.windows.some(w=>w.partial));
for(let lap=0;lap<3;lap++){const splits=timing.splits.filter(s=>s.lap===lap);assert(splits.every(s=>s.valid));assert(Math.abs(splits.reduce((n,s)=>n+s.time,0)-real.kart.lapTimes[lap])<=1/60+1e-5);}
assert(real.sectors.linePaid+real.sectors.timePaid<=5);assert(styleScore(timing)>0);assert(timing.windows.every(w=>w.meanLineError>=0));
console.log('Actual physics: lap-wrap windows remain valid and adjacent splits sum to each game lap within one tick.');
const linked=refine(officialTracks[7],{smoke:true});assert(linked.calibration.complete,'Tight linked turns use a conservative legal classic-line seed');
assert.equal(linked.calibration.shapeFamily,'outside-apex-outside');assert(linked.calibration.trials.length>=2);
