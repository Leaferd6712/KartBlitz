/** End-to-end native rollout and independent reset checks with a real actor. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {forward} from '../../sim/official-policy.mjs';
const pack=JSON.parse(fs.readFileSync('ml_training/runs/pace-rnd/sunset-review/candidate.kartai.json','utf8'));
const child=spawn(process.execPath,['ml_training/native-worker-v2.mjs'],{stdio:['pipe','pipe','inherit'],windowsHide:true});
const lines=readline.createInterface({input:child.stdout});let waiting=[];
lines.on('line',line=>{const r=JSON.parse(line),next=waiting.shift();if(!next)throw Error('Unexpected worker output');r.ok?next.resolve(r):next.reject(Error(r.error));});
const call=request=>new Promise((resolve,reject)=>{waiting.push({resolve,reject});child.stdin.write(JSON.stringify(request)+'\n');});
const errors=[];child.on('error',e=>{errors.push(e);for(const waiter of waiting)waiter.reject(e);waiting=[];});
try{
  const meta=await call({command:'init',count:2,config:{trackId:0,nativeRace:true,mode:'shootout',difficulty:'extreme',racecraft:false,seed:81271}});
  assert.equal(meta.environmentVersion,7);assert.equal(meta.startMode,'native-grid-and-graded-launch');assert.equal(meta.observationNames.length,57);
  let obs=(await call({command:'reset',options:{fixed:true,mode:'shootout',raceLaps:1,energy:1}})).observations;
  let completed=null;
  for(let n=0;n<900&&!completed;n++){
    const result=await call({command:'step',actions:obs.map(o=>forward(pack.variants.extreme.policy,o))});obs=result.results.map(r=>r.observation);
    completed=result.results.find(r=>r.done)?.info;
  }
  assert(completed?.finished&&completed.validLap,'Known solo seed must complete the real native lap');assert(completed.lapTime>20&&completed.lapTime<30);
  assert(completed.trajectory.length>400);assert(completed.trajectory.every(p=>Number.isFinite(p.ersCharge)&&typeof p.drsActive==='boolean'&&p.action));
  obs=(await call({command:'reset',options:{fixed:true,mode:'ai',raceLaps:3,energy:.5}})).observations;
  assert(obs.every(o=>o[37]!==1)); // All configurations are solo; no phantom car.
  let race=null;
  for(let n=0;n<2800&&!race;n++){
    const result=await call({command:'step',actions:obs.map(o=>forward(pack.variants.extreme.policy,o))});obs=result.results.map(r=>r.observation);race=result.results.find(r=>r.done)?.info;
  }
  assert(race?.finished&&race.validLap,'Known seed must complete a native three-lap solo race');assert.equal(race.lapTimes.length,3);assert(race.raceTime>30);
  const points=race.trajectory;assert(points.every(p=>p.opponents.length===0),'No hidden human in observations or recordings');
  for(let n=1;n<points.length;n++)if(points[n].lapIndex!==points[n-1].lapIndex)assert(Math.abs(points[n].ersCharge-points[n-1].ersCharge)<.03,'Battery must not refill on lap crossings');
  const reset=await call({command:'reset',options:{fixed:true,mode:'shootout',raceLaps:1,energy:.25}});assert(reset.observations.every(o=>o[12]===.25),'Every environment resets its own battery');
  console.log(`Native campaign: clean Shootout ${completed.lapTime.toFixed(3)}s, three-lap ${race.raceTime.toFixed(3)}s, isolated cars, carried battery and full telemetry passed.`);
}finally{try{await call({command:'close'});}finally{child.stdin.end();lines.close();}}
