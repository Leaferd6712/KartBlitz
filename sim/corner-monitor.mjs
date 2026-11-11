import {matchedWindow} from './racing-line.mjs';
/** Diagnostic only: these measurements never reward pressing the brake. */
export class CornerMonitor {
  constructor(profile){this.profile=profile;this.rows=new Map();}
  feed(p,target,brakeForce){
    const L=this.profile.length,s=((p.s%L)+L)%L;
    for(const c of this.profile.corners){
      const approach=c.entry-200,end=c.exit+120;let u=s;while(u<approach)u+=L;
      if(u>end)continue;
      const lap=Math.max(0,p.lapIndex||0),key=lap+'/'+c.id;
      let row=this.rows.get(key);if(!row){row={id:c.id,lap,approachSpeed:p.speed,referenceSpeed:target,brakePoint:null,minimumSpeed:p.speed,offTrackSamples:0,steeringChange:0};this.rows.set(key,row);}
      if(p.brake>.15&&row.brakePoint===null)row.brakePoint=u;
      row.minimumSpeed=Math.min(row.minimumSpeed,p.speed);row.offTrackSamples+=+p.offTrack;
      row.steeringChange+=Math.abs((p.steer||0)-(row.lastSteer??p.steer??0));row.lastSteer=p.steer;
      row.referenceBrakingDistance=Math.max(0,(row.approachSpeed**2-target**2)/(2*Math.max(1,brakeForce*.65)));
    }
  }
  finish(windows){return [...this.rows.values()].map(r=>{const w=windows.find(w=>w.id===r.id&&w.lap===r.lap),c=this.profile.corners.find(c=>c.id===r.id),failures=[];
    if(r.offTrackSamples)failures.push('track departure');
    if(r.approachSpeed>r.referenceSpeed*1.2)failures.push('excessive approach speed');
    const baseline=(this.profile.baselines||[]).filter(b=>w&&matchedWindow(w,b)).sort((a,b)=>a.time-b.time)[0];
    if(baseline&&w.exitSpeed<baseline.exitSpeed*.9&&w.nextEntrySpeed<baseline.nextEntrySpeed*.95)failures.push('poor exit');
    if(r.referenceBrakingDistance>30&&(r.brakePoint===null||r.brakePoint>c.entry))failures.push('late or missing braking');
    return {...r,lastSteer:undefined,windowTime:w?.time??null,exitSpeed:w?.exitSpeed??null,nextEntrySpeed:w?.nextEntrySpeed??null,batteryUsed:w?.batteryUsed??null,partial:w?.partial??true,failures};});}
}
