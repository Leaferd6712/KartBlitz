import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Environment,officialTracks,startLineSpawn,isPenalizedOffTrack} from '../../ml_training/official-worker.mjs';
import {geometry,teacher} from '../official-policy.mjs';

for(const track of officialTracks)for(const mode of ['ai','shootout']){
  const env=new Environment(0,{trackId:track.id,mode,seed:123});
  const start=startLineSpawn(track),sf=track.cpLines[0];
  for(let attempt=0;attempt<4;attempt++){
    const observation=env.reset();assert.equal(observation.length,48);assert(observation.every(Number.isFinite));
    assert.equal(env.kart.x,start.x);assert.equal(env.kart.y,start.y);assert.equal(env.kart.angle,start.a);assert.equal(env.kart.speed,0);
    assert.equal(env.kart.lapStart,null);assert.equal(env.kart.nextCp,1);assert.equal(env.kart.lapTimes.length,0);
    const dx=env.kart.x-(sf.x1+sf.x2)/2,dy=env.kart.y-(sf.y1+sf.y2)/2;
    assert(Math.abs(dx*start.tx+dy*start.ty+30)<1e-6);assert(Math.abs(-dx*start.ty+dy*start.tx)<1e-6);
    assert(env.kart.onTrack(track),`${track.id}/${mode}: start must be on the road`);
  }
  let result;
  for(let i=0;i<200&&env.kart.lapStart===null;i++){result=env.step([0,1,-1,-1,-1]);assert(!result.done,'First crossing must not finish the lap');}
  assert(env.kart.lapStart>0,`${track.id}/${mode}: crossing S/F must start the actual game lap clock`);
  assert.equal(env.kart.lapTimes.length,0);assert.equal(env.kart.nextCp,1);
}
console.log('All eight tracks / both modes reset at rest behind the actual S/F gate; crossing starts, not finishes, the lap.');

for(const mode of ['ai','shootout']){
  const e=new Environment(0,{trackId:0,mode,randomization:false,episodeSeconds:400});let result;
  for(let i=0;i<8000;i++){result=e.step(teacher(e.kart,e.track,{},.42));if(result.done)break;}
  assert(result.info.finished,`${mode}: controlled validation driver must complete a lap`);
  assert(result.info.validLap);assert.equal(e.kart.lap,1);assert.equal(e.kart.lapTimes.length,1);
  assert.equal(result.info.lapTime,e.kart.lapTimes[0]);assert(result.info.lapTime<e.time,'Approach to S/F is excluded from timed lap');
  assert.equal(result.info.rewardComponents.finish,100);assert(result.info.progress>=.98);
}
console.log('Full controlled laps finish using the game checkpoint order and lap clock in both modes.');

function driveOffset(track,mode,extra){
  const env=new Environment(0,{trackId:track.id,mode,randomization:false});const k=env.kart;
  k.speed=300;k.x-=env.start.ty*extra;k.y+=env.start.tx*extra;
  env.state.nearest=null;env.lastG=geometry(k,track,env.state);
  let result;for(let i=0;i<5;i++)result=env.step([0,1,-1,-1,-1]);
  return {env,result};
}
for(const track of officialTracks)for(const mode of ['ai','shootout']){
  const road=driveOffset(track,mode,0);
  for(const extra of [track.trackWidth/2+30,track.trackWidth/2+90]){
    const {env,result}=driveOffset(track,mode,extra);
    assert(isPenalizedOffTrack(env.kart),`${track.id}/${mode}: strict off-track boundary`);
    assert(env.kart.speed<road.env.kart.speed,`${track.id}/${mode}: actual off-track physics must slow the kart`);
    assert(result.info.rewardComponents.offTrack<0);assert(result.info.rewardComponents.progress<=0);
    assert(result.info.offTrackRate>0);assert(!result.info.finished);assert.equal(result.info.rewardComponents.finish,0);
    assert(env.trajectory.at(-1).offTrack);assert(env.trajectory.at(-1).strictOffTrack);
  }
}
console.log('Grass/strict-limit slowdown and negative per-tick RL penalties verified on all tracks / both modes.');

const transient=new Environment(0,{trackId:0,randomization:false});let tick=0;
transient.kart.speed=100;
transient.kart.update=()=>{tick++;transient.kart.x+=1;transient.kart.isOffTrack=tick===1;transient.kart._isCompletelyOff=tick===1;};
const transientResult=transient.step([0,1,-1,-1,-1]);
assert(!transient.kart.isOffTrack);assert(transientResult.info.rewardComponents.offTrack<0);
assert.equal(transientResult.info.offTrackRate,1/3);assert(transientResult.info.rewardComponents.progress<.3);
const incomplete=new Environment(0,{trackId:0,randomization:false});incomplete.progress=incomplete.track.totalLen*1.1;
assert.equal(incomplete.step([0,1,-1,-1,-1]).info.rewardComponents.finish,0);
console.log('Brief off-track excursions are penalized even after returning; distance alone cannot finish a lap.');

const reverse=new Environment(0,{trackId:0,randomization:false});
reverse.kart.speed=-100;
reverse.kart.update=()=>{reverse.kart.x+=reverse.start.tx;reverse.kart.y+=reverse.start.ty;};
const backwards=reverse.step([0,-1,1,-1,-1]);
assert(backwards.info.progress>0,'Recovery test moves forward along the track while the kart reverses');
assert.equal(backwards.info.rewardComponents.progress,0,'Reversing must not earn positive racing-progress reward');
assert(backwards.reward<0);
console.log('Reverse is available for recovery but cannot earn forward racing-progress reward.');

const host={console,Math,Date};host.window=host;
vm.runInNewContext(fs.readFileSync(new URL('../../online-sim.js',import.meta.url),'utf8'),host);
for(const track of officialTracks)for(const mode of ['ai','shootout']){
  const corners=track.spline.map((_,i)=>({i,curvature:host.OnlineSim.localSplineCurvature(track.spline,i)})).filter(p=>p.curvature>.1).sort((a,b)=>b.curvature-a.curvature);
  let verified=false;
  for(const corner of corners.slice(0,20)){
    for(const side of [1,-1]){
      const e=new Environment(0,{trackId:track.id,mode,randomization:false}),n=track.spline.length;
      const p=track.spline[corner.i],before=track.spline[(corner.i-1+n)%n],after=track.spline[(corner.i+1)%n],angle=Math.atan2(after.y-before.y,after.x-before.x);
      const k=e.kart;k.x=p.x-Math.sin(angle)*side*(track.trackWidth/2+30);k.y=p.y+Math.cos(angle)*side*(track.trackWidth/2+30);k.angle=angle;k.speed=300;k._nearestSplineIdx=corner.i;
      e.state.nearest=corner.i;e.lastG=geometry(k,track,e.state);const r=e.step([0,1,-1,-1,-1]);
      if(k._cornerCutLatched&&isPenalizedOffTrack(k)){
        assert(k.speed<150);assert.equal(k.angle,angle);assert(r.info.rewardComponents.offTrack<0);verified=true;break;
      }
    }
    if(verified)break;
  }
  assert(verified,`${track.id}/${mode}: actual corner-cut speed penalty must be exercised`);
}
console.log('Actual corner-cut speed snaps also verified on every track / mode without changing heading.');
