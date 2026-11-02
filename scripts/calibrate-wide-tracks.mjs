import fs from 'node:fs';
import {Environment,officialTracks} from '../ml_training/official-worker.mjs';
import {teacher} from '../sim/official-policy.mjs';
import {extractTracks} from './export-track-bakes.mjs';
import {replaceTrackSource} from '../sim/track-source.mjs';
let html=fs.readFileSync('index.html','utf8');
const authored=extractTracks(html),report=JSON.parse(fs.readFileSync('ui/track-widening.json','utf8'));
for(const track of officialTracks){
  const times={};
  for(const mode of ['ai','shootout']){
    const env=new Environment(0,{trackId:track.id,mode,randomization:false,episodeSeconds:900});let result;
    for(let i=0;i<30000;i++){result=env.step(teacher(env.kart,env.track,{},.9));if(result.done)break;}
    if(!result.info.finished||!result.info.validLap||result.info.offTrackSeconds!==0)throw Error(track.name+': reference lap failed');
    times[mode]=result.info.lapTime;
  }
  const row=report.tracks.find(t=>t.id===track.id),targetLap=Math.round(times.ai*1.05*10)/10;
  row.previousTarget=authored[track.id].targetLap;row.targetLap=targetLap;row.reference={...times,pace:.9,weather:'dry',tyres:'med',car:'stock'};
  html=replaceTrackSource(html,{...authored[track.id],targetLap});
  console.log(track.name,'clean laps',times,'target',targetLap);
}
fs.writeFileSync('index.html',html);
fs.writeFileSync('ui/track-widening.json',JSON.stringify(report)+'\n');
fs.writeFileSync('backups/tracks/widening-report-2026-11-02.json',JSON.stringify(report,null,2)+'\n');
