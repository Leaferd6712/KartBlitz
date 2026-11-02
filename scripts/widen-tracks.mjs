/** Reproducible widening from the immutable owner-export backup; never compounds a prior widening. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {replaceTrackSource} from '../sim/track-source.mjs';
import {ROAD_GAP,KERB_MARGIN,separateRoad,analyseLoop,analysePitLane,projectLoop,curveAt,sampleCurve,resampleLoop,loopLengths,loopAt,distance} from '../sim/road-clearance.mjs';

const backupPath='backups/tracks/before-wide-2026-11-02.json';
const backup=JSON.parse(fs.readFileSync(backupPath,'utf8'));
const factor=2.5,round=n=>Math.round(n*1000)/1000,point=p=>({x:round(p.x),y:round(p.y)});
let html=fs.readFileSync('index.html','utf8');
const report={version:1,factor,backupPath,roadGap:ROAD_GAP,kerbMargin:KERB_MARGIN,tracks:[]};
const candidates=[];
for(const baseline of backup.baseline){
  const authored=backup.authored.find(t=>t.id===baseline.id),width=baseline.width*factor;
  console.log('Widening',baseline.name,'to',width);
  const solved=separateRoad(baseline.spline,width,{iterations:1400});
  if(!solved.report.safe)throw Error(baseline.name+': road clearance could not be validated');
  const waypoints=solved.points.map(point),road=sampleCurve(waypoints,12),oldRoad=baseline.spline;
  const mapped=(p,{scaleOffset=true}={})=>{const old=projectLoop(oldRoad,p),center=curveAt(waypoints,old.fraction);
    const offset=Math.max(-width*.4,Math.min(width*.4,old.lateral*(scaleOffset?factor:1)));
    return {...point({x:center.x-Math.sin(center.angle)*offset,y:center.y+Math.cos(center.angle)*offset}),angle:center.angle};};
  const oldLength=loopLengths(oldRoad).length;
  const mapFraction=f=>round(projectLoop(road,curveAt(waypoints,f*baseline.totalLen/oldLength)).fraction);
  const racingLine=(authored.racingLine?.length?authored.racingLine:resampleLoop(oldRoad,baseline.width*1.5)).map(p=>point(mapped(p)));
  const start=mapped(baseline.startPos),startAngle=round(start.angle+(baseline.startAngle-projectLoop(oldRoad,baseline.startPos).angle));
  const oldPit=baseline.pitLane,oldPath=oldPit.rawPath||oldPit.path;
  const entry=projectLoop(oldRoad,oldPit.entryPt||oldPath[0]),exit=projectLoop(oldRoad,oldPit.exitPos||oldPath.at(-1));
  let span=(exit.fraction-entry.fraction+1)%1;
  if(span>.35||span<.005)throw Error(baseline.name+': pit connections need review before widening');
  const box=projectLoop(oldRoad,oldPit.garagePos),oldSide=Math.sign(box.lateral)||1;
  const area=road.reduce((v,p,i)=>{const q=road[(i+1)%road.length];return v+p.x*q.y-q.x*p.y;},0);
  const exteriorSide=-Math.sign(area)||oldSide,pitWidth=oldPit.width||56;
  const roadLength=loopLengths(road).length,startDistance=projectLoop(road,start).fraction*roadLength;
  const mappedEntry=projectLoop(road,curveAt(waypoints,entry.fraction)).fraction*roadLength;
  const mappedExit=projectLoop(road,curveAt(waypoints,exit.fraction)).fraction*roadLength;
  const placements=[{start:mappedEntry,length:(mappedExit-mappedEntry+roadLength)%roadLength,name:'original approaches'},
    ...[0,.5,1,2,-1,-2].map(shift=>({start:startDistance+width*(shift-.4),length:width*3.8,name:'start-straight approaches'}))];
  let lane,pitReport,pitSide,pitPlacement;
  placementLoop: for(const placement of placements)for(const side of [...new Set([oldSide,exteriorSide,-oldSide])]){
    const sampleCount=Math.max(24,Math.ceil(placement.length/45));
    const offset=width/2+pitWidth/2+ROAD_GAP+2*KERB_MARGIN+20;
    const path=Array.from({length:sampleCount+1},(_,i)=>{
      const t=i/sampleCount,s=placement.start+placement.length*t,p=loopAt(road,s/roadLength);
      const before=loopAt(road,(s-width*.1)/roadLength),after=loopAt(road,(s+width*.1)/roadLength);
      p.angle=Math.atan2(after.y-before.y,after.x-before.x);
      const fade=t<.22?(1-Math.cos(t/.22*Math.PI))/2:t>.78?(1-Math.cos((1-t)/.22*Math.PI))/2:1;
      return point({x:p.x-Math.sin(p.angle)*side*offset*fade,y:p.y+Math.cos(p.angle)*side*offset*fade});
    });
    const garageIndex=Math.round(sampleCount*.5),garage=path[garageIndex];
    const angle=(a,b)=>round(Math.atan2(b.y-a.y,b.x-a.x));
    const candidate={path,width:pitWidth,entryPt:path[0],garagePos:garage,garageAngle:angle(path[garageIndex-1],path[garageIndex+1]),exitPos:path.at(-1),exitAngle:angle(path.at(-2),path.at(-1))};
    const audit=analysePitLane(resampleLoop(road,30),width,candidate);
    if(audit.safe){lane=candidate;pitReport=audit;pitSide=side;pitPlacement=placement.name;break placementLoop;}
  }
  if(!lane)throw Error(baseline.name+': could not place a separated pit lane');
  const track={...authored,geometryVersion:2,widthReference:baseline.width,widthScale:factor,
    trackWidth:width,waypoints:waypoints.map(p=>({...p,brake:0})),racingLine,startPos:point(start),startAngle,
    pitPos:lane.garagePos,pitLane:lane,cpFracs:baseline.cpFracs.map(mapFraction),drsFracs:baseline.drsFracs.map(pair=>pair.map(mapFraction))};
  if(authored.sfGateHalfWidth!=null)track.sfGateHalfWidth=round(width/2+20);
  const revision=createHash('sha256').update(JSON.stringify(track)).digest('hex').slice(0,16);
  track.layoutRevision='wide-'+revision;
  const audit=analyseLoop(resampleLoop(sampleCurve(waypoints,12),width*.075),width,{details:false});
  if(!audit.safe)throw Error(baseline.name+': fine road validation failed');
  const nearestChange=Math.max(...resampleLoop(road,60).map(p=>projectLoop(oldRoad,p).distance));
  const previousLength=baseline.totalLen,nextLength=loopLengths(road).length;
  report.tracks.push({id:track.id,name:track.name,beforeWidth:baseline.width,width,factor,previousLength,length:nextLength,
    maxDeviation:nearestChange,pitSideChanged:pitSide!==oldSide,pitPlacement,road:audit,pits:pitReport,layoutRevision:track.layoutRevision,
    before:{spline:resampleLoop(oldRoad,35),pitLane:{path:oldPath,width:pitWidth}},
    after:{spline:resampleLoop(road,35),racingLine:resampleLoop(sampleCurve(racingLine,8),35),pitLane:lane,startPos:track.startPos}});
  candidates.push(track);
}
// Commit locally only after every road and pit lane has passed, so failures cannot leave a partial catalog.
for(const track of candidates)html=replaceTrackSource(html,track);
fs.writeFileSync('index.html',html);
fs.writeFileSync('ui/track-widening.json',JSON.stringify(report)+'\n');
fs.writeFileSync('backups/tracks/widening-report-2026-11-02.json',JSON.stringify(report,null,2)+'\n');
console.log('All eight widened tracks validated. Saved source and before/after preview data.');
