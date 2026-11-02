import assert from 'node:assert/strict';
import {Environment,officialTracks} from '../../ml_training/official-worker.mjs';
import {teacher} from '../official-policy.mjs';
for(const track of officialTracks)for(const scenario of ['solo','passing','defending','recovery']){
  const e=new Environment(0,{trackId:track.id,mode:'ai',scenario,racecraft:true,randomization:false,seed:81271});
  e.reset({fixed:true,energy:.5});assert.equal(e.kart.ersCharge,.5);assert.equal(e.kart.speed,0);
  for(const other of e.opponents)assert(other.onTrack(track),`${track.id}/${scenario}: opponent must start on the road`);
  let result;
  for(let i=0;i<150;i++){
    result=e.step(teacher(e.kart,track,{},.42));
    assert(result.observation.every(Number.isFinite));assert(Number.isFinite(result.reward));
    assert(e.passes<=e.opponents.length,'A pair cannot farm repeat overtaking bonuses');
    if(result.done)break;
  }
  assert.equal(e.trajectory[0].t,0);
  assert('drsActive' in e.trajectory.at(-1));assert('ersActive' in e.trajectory.at(-1));assert('opponents' in e.trajectory.at(-1));
  if(scenario==='recovery'&&e.time>=4)assert(e.recoveryInjected,'Recovery intervention must be explicit and reproducible');
}
for(const track of officialTracks){const e=new Environment(0,{trackId:track.id,racecraft:true,mode:'shootout',scenario:'passing'});assert.equal(e.scenario,'solo');assert.equal(e.opponents.length,0);}
console.log('Campaign scenarios: all tracks, road-valid opponents, reproducible recovery, bounded pass rewards, battery/DRS/ERS recordings and solo Shootout.');
