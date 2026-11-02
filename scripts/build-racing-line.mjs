/** Actual-physics coordinate search; never starts PPO or edits the V1 campaign. */
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {Environment,officialTracks,referenceAction} from '../ml_training/official-worker-v2.mjs';
import {buildProfile,hash} from '../sim/racing-line.mjs';
import {PHYSICS_HASH} from '../sim/official-policy.mjs';
export function rollout(profile,{mode='ai',raceLaps=3,energy=.5,difficulty='extreme',seed=4242,pace=.5,episodeSeconds}={}){
  const env=new Environment(0,{trackId:profile.trackId,mode,raceLaps,seed,randomization:false,lineGuidance:false,lineProfile:profile,difficulty,scenario:'solo',episodeSeconds});
  env.reset({fixed:true,mode,raceLaps,energy});let result;
  for(let i=0;i<150000;i++){result=env.step(referenceAction(env,pace));if(result.done)break;}
  return {trackId:profile.trackId,mode,difficulty,raceLaps,startingCharge:energy,seed,profileHash:profile.profileHash,result:{...result.info},points:env.trajectory};
}
export function refine(track,{smoke=false,onTrial=()=>{}}={}){
  const center=Object.fromEntries(buildProfile(track).corners.map(c=>[c.id,{entryScale:0,apexScale:0,exitScale:0,apexShift:0}]));
  let tuning={},best=buildProfile(track),attempts=[];
  const safe=r=>r.result.finished&&r.result.validLap&&r.result.offTrackRate===0;
  const run=profile=>{let chosen;
    for(const pace of smoke?[.5,.35,.25]:[.95,.8,.65,.5,.42,.35,.25]){const record=rollout(profile,{pace});record.pace=pace;
      attempts.push({profileHash:profile.profileHash,pace,finished:record.result.finished,raceTime:record.result.raceTime,offTrackRate:record.result.offTrackRate,
        windows:record.result.miniSectors.windows.map(({id,lap,time,valid})=>({id,lap,time,valid}))});onTrial(record);
      if(!chosen||safe(record)&&(!safe(chosen)||record.result.raceTime<chosen.result.raceTime))chosen=record;
      if(safe(record))break;
    }return chosen;};
  // Keep the centerline as a measured control, not as the desired corner style.
  const benchmark=run(buildProfile(track,center));let winner=run(best);
  if(!safe(winner)){
    tuning=Object.fromEntries(best.corners.map(c=>[c.id,{entryScale:.3,apexScale:.3,exitScale:.3,apexShift:.05}]));
    best=buildProfile(track,tuning);winner=run(best);
  }
  const variants=[{entryScale:.65,apexScale:.65,exitScale:.65,apexShift:.05},{entryScale:.75,apexScale:.45,exitScale:.7,apexShift:.12},
    {entryScale:.5,apexScale:.6,exitScale:.45,apexShift:-.08},{entryScale:.3,apexScale:.35,exitScale:.3,apexShift:.1}];
  const complexes=[...new Set(best.corners.map(c=>c.complex))];
  for(const complex of smoke?complexes.slice(0,1):complexes){for(const variant of smoke?variants.slice(0,1):variants){
    const candidateTuning=structuredClone(tuning);for(const c of best.corners)if(c.complex===complex)candidateTuning[c.id]=variant;
    const candidate=buildProfile(track,candidateTuning),record=run(candidate);
    // Full race time captures consequences outside an individual corner window.
    if(safe(record)&&(!safe(winner)||record.result.raceTime<winner.result.raceTime-.05||Math.abs(record.result.raceTime-winner.result.raceTime)<=.05&&variant.entryScale>(tuning[best.corners.find(c=>c.complex===complex).id]?.entryScale||0))){best=candidate;tuning=candidateTuning;winner=record;}
  }}
  return {profile:best,calibration:{physicsHash:PHYSICS_HASH,pace:winner.pace,ers:'off',seed:4242,shapeFamily:'outside-apex-outside',complete:safe(winner),trials:attempts,selectedTime:winner.result.raceTime,centerlineControlTime:benchmark.result.raceTime}};
}
async function main(){
  const args=process.argv.slice(2),value=(flag,fallback)=>args.includes(flag)?args[args.indexOf(flag)+1]:fallback;
  const trackId=Number(value('--track',0)),output=value('--output',null),difficulty=value('--difficulty','extreme'),smoke=args.includes('--smoke');
  if(!Number.isInteger(trackId)||!officialTracks[trackId]||!output)throw Error('Use --track 0..7 --output profile.json [--difficulty extreme] [--smoke]');
  if(fs.existsSync(output))throw Error('Reference profiles are frozen. Choose a new output path instead of overwriting a previous run.');
  fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});const archive=output.replace(/\.json$/,'')+'-calibration.jsonl.gz';fs.writeFileSync(archive,'');
  const {profile,calibration}=refine(officialTracks[trackId],{smoke,onTrial:record=>fs.appendFileSync(archive,gzipSync(JSON.stringify(record)+'\n'))});
  profile.physicsHash=PHYSICS_HASH;profile.baselines=[];
  const cases=smoke?[{mode:'shootout',raceLaps:1,energy:.5},{mode:'ai',raceLaps:3,energy:.5}]:[
    ...[.25,.5,1].map(energy=>({mode:'shootout',raceLaps:1,energy})),...[1,2,3,5,8,10].flatMap(raceLaps=>[.25,.5,1].map(energy=>({mode:'ai',raceLaps,energy})))];
  for(const c of cases){const record=rollout(profile,{...c,difficulty,pace:calibration.pace});profile.baselines.push(...record.result.miniSectors.windows.filter(w=>w.valid));fs.appendFileSync(archive,gzipSync(JSON.stringify(record)+'\n'));}
  profile.calibration={...calibration,smoke,archive,baselineHash:hash(profile.baselines),baselineCases:cases.length};
  fs.writeFileSync(output,JSON.stringify(profile));console.log(JSON.stringify({output,corners:profile.corners.length,complete:calibration.complete,baselines:profile.baselines.length}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
