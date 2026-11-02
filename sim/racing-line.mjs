/** Frozen per-track guidance and forward gate timing; shared by trainer/replays. */
import {trackFingerprint} from './official-policy.mjs';
export const LINE_VERSION=1,REWARD_VERSION='v2-line-1';
const mod=(x,n)=>((x%n)+n)%n,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const wrap=x=>Math.atan2(Math.sin(x),Math.cos(x));
export function hash(value){let h=2166136261;for(const c of JSON.stringify(value)){h=Math.imul(h^c.charCodeAt(0),16777619);}return (h>>>0).toString(16).padStart(8,'0');}
export function centerAt(track,s){
  s=mod(s,track.totalLen);let lo=0,hi=track.cum.length-1;
  while(lo<hi){const mid=(lo+hi+1)>>1;if(track.cum[mid]<=s)lo=mid;else hi=mid-1;}
  const a=track.spline[lo],b=track.spline[(lo+1)%track.spline.length],end=track.cum[lo+1]??track.totalLen;
  const f=(s-track.cum[lo])/Math.max(1e-9,end-track.cum[lo]),angle=Math.atan2(b.y-a.y,b.x-a.x);
  return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,angle};
}
export function referenceAt(profile,s){
  const points=profile.reference,n=points.length,u=mod(s,profile.length)/profile.length*n,i=Math.floor(u),f=u-i;
  const a=points[i%n],b=points[(i+1)%n];return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,offset:a.offset+(b.offset-a.offset)*f};
}
export function buildProfile(track,tuning={}){
  const L=track.totalLen,origin=track.cum[track.cpLines[0].idx]||0,n=Math.max(80,Math.ceil(L/40)),ds=L/n;
  const samples=Array.from({length:n},(_,i)=>centerAt(track,origin+i*ds));
  const curvature=samples.map((_,i)=>{const a=samples[mod(i-2,n)],b=samples[(i+2)%n];return wrap(b.angle-a.angle)/(4*ds);});
  const smooth=curvature.map((_,i)=>[-1,0,1].reduce((v,d)=>v+curvature[mod(i+d,n)],0)/3);
  // Start the circular scan in its straightest region, avoiding a split S/F corner.
  let anchor=0;for(let i=1;i<n;i++)if(Math.abs(smooth[i])<Math.abs(smooth[anchor]))anchor=i;
  const groups=[];let group=null;
  for(let j=0;j<n;j++){
    const index=(anchor+j)%n,k=smooth[index],sign=Math.abs(k)>=.00065?Math.sign(k):0;
    if(sign){if(!group||group.sign!==sign||j-group.end>Math.ceil(120/ds)){group={start:j,end:j,peak:j,peakValue:Math.abs(k),sign};groups.push(group);}else group.end=j;
      if(Math.abs(k)>group.peakValue){group.peak=j;group.peakValue=Math.abs(k);}}
  }
  if(groups.length>1){const first=groups[0],last=groups.at(-1);if(first.sign===last.sign&&first.start+n-last.end<=Math.ceil(120/ds)){
    last.end=first.end+n;if(first.peakValue>last.peakValue){last.peak=first.peak+n;last.peakValue=first.peakValue;}groups.shift();}}
  const regions=groups.filter(g=>(g.end-g.start+1)*ds>=60).map(g=>({start:(anchor+g.start)*ds,end:(anchor+g.end+1)*ds,peak:(anchor+g.peak+.5)*ds,sign:g.sign}));
  let corners=regions.map((r,i)=>{
    const prev=regions[mod(i-1,regions.length)],next=regions[(i+1)%regions.length];
    const gapBefore=mod(r.start-prev.end,L),gapAfter=mod(next.start-r.end,L);
    const entry=mod(r.start-Math.min(120,gapBefore*.35),L),apex=entry+mod(r.peak-entry,L),exit=entry+mod(r.end+Math.min(120,gapAfter*.35)-entry,L);
    return {entry,apex,exit,sign:r.sign};
  }).sort((a,b)=>a.entry-b.entry).map((c,i)=>({...c,id:'C'+(i+1),complex:'C'+(i+1)}));
  // Adjacent/opposite turns are optimised as a unit while retaining corner IDs.
  for(let i=1;i<corners.length;i++)if(corners[i].entry-corners[i-1].exit<180)corners[i].complex=corners[i-1].complex;
  if(corners.length>1&&corners[0].entry+L-corners.at(-1).exit<180){const old=corners.at(-1).complex;for(const c of corners)if(c.complex===old)c.complex=corners[0].complex;}
  const limit=Math.max(0,track.trackWidth*.5-24),knots=[];
  for(const c of corners){const t=tuning[c.id]||{},shift=clamp(t.apexShift??.05,-.15,.2)*(c.exit-c.entry);
    knots.push({s:mod(c.entry,L),offset:-c.sign*limit*(t.entryScale??.65)},
      {s:mod(clamp(c.apex+shift,c.entry+10,c.exit-10),L),offset:c.sign*limit*(t.apexScale??.65)},
      {s:mod(c.exit,L),offset:-c.sign*limit*(t.exitScale??.65)});}
  knots.sort((a,b)=>a.s-b.s);
  const reference=samples.map((p,i)=>{const s=i*ds;let offset=0;
    if(knots.length){let j=knots.findIndex(k=>k.s>s);if(j<0)j=0;const a=knots[mod(j-1,knots.length)],b=knots[j],d=mod(b.s-a.s,L)||L;
      const f=clamp(mod(s-a.s,L)/d,0,1),blend=(1-Math.cos(f*Math.PI))*.5;offset=clamp(a.offset+(b.offset-a.offset)*blend,-limit,limit);}
    return {s,x:p.x-Math.sin(p.angle)*offset,y:p.y+Math.cos(p.angle)*offset,offset};});
  // A small periodic smoothing pass limits sudden lane transitions between linked turns.
  for(let pass=0;pass<4;pass++){const offsets=reference.map((p,i)=>(reference[mod(i-1,n)].offset+2*p.offset+reference[(i+1)%n].offset)/4);
    reference.forEach((p,i)=>{p.offset=clamp(offsets[i],-limit,limit);p.x=samples[i].x-Math.sin(samples[i].angle)*p.offset;p.y=samples[i].y+Math.cos(samples[i].angle)*p.offset;});}
  const gates=[{id:'SF',s:0},...corners.flatMap(c=>['entry','apex','exit'].map(kind=>({id:c.id+'-'+kind,s:mod(c[kind],L)})))].sort((a,b)=>a.s-b.s||a.id.localeCompare(b.id));
  for(const gate of gates){const p=centerAt(track,origin+gate.s);gate.x=p.x;gate.y=p.y;gate.tx=Math.cos(p.angle);gate.ty=Math.sin(p.angle);
    if(gate.id==='SF'){const sf=track.cpLines[0];gate.x=(sf.x1+sf.x2)/2;gate.y=(sf.y1+sf.y2)/2;
      const dx=sf.x2-sf.x1,dy=sf.y2-sf.y1,length=Math.hypot(dx,dy);if(length){let tx=dy/length,ty=-dx/length;if(tx*gate.tx+ty*gate.ty<0){tx=-tx;ty=-ty;}gate.tx=tx;gate.ty=ty;}}}
  const windows=corners.map((c,i)=>{const prev=corners[mod(i-1,corners.length)],next=corners[(i+1)%corners.length];let start=prev.exit,end=next.entry;
    while(start>c.entry+1e-5)start-=L;while(end<c.exit-1e-5)end+=L;
    if(Math.abs(start-c.entry)<1e-5)start=c.entry;if(Math.abs(end-c.exit)<1e-5)end=c.exit;
    return {id:c.id,start,end,via:[c.entry,c.apex,c.exit],complex:c.complex};});
  const profile={version:LINE_VERSION,rewardVersion:REWARD_VERSION,trackId:track.id,trackFingerprint:trackFingerprint(track),length:L,width:track.trackWidth,origin,
    centerline:track.spline,cum:track.cum,reference,corners,gates,windows,tuning};
  profile.timingHash=hash({version:LINE_VERSION,track:profile.trackFingerprint,gates,windows});
  profile.profileHash=hash(profile);return profile;
}
export function validateProfile(profile,track,physicsHash){
  const {profileHash,baselines,calibration,physicsHash:savedPhysics,...definition}=profile;
  if(profile.version!==LINE_VERSION||profile.rewardVersion!==REWARD_VERSION||profile.trackFingerprint!==trackFingerprint(track)||Math.abs(profile.length-track.totalLen)>1e-5||savedPhysics&&savedPhysics!==physicsHash||hash(definition)!==profileHash)throw Error('Racing-line profile differs from track, version or physics');
  if(!Array.isArray(profile.reference)||profile.reference.length<2||profile.reference.some(p=>!['s','x','y','offset'].every(k=>Number.isFinite(p[k]))))throw Error('Invalid reference points');
  return true;
}

const key=x=>x.toFixed(5);
const interpolate=(a,b,f,k)=>(a[k]||0)+((b[k]||0)-(a[k]||0))*f;
export class SectorTracker {
  constructor(profile,context={}){this.profile=profile;this.context=context;this.previous=null;this.absolute=null;this.events=new Map();this.epoch=0;this.rows=[];this.splits=[];this.closed=new Set();this.paid=new Set();this.linePaid=0;this.timePaid=0;this.lastSplit=null;
    this.totals={off:0,line:0,suppressed:0,smooth:0,drs:0};this.intervalMin=Infinity;this.intervalJump=0;}
  feed(point){
    const p={...point};p.s=mod(p.s,this.profile.length);
    if(!this.previous){this.absolute=p.s;if(p.lapStarted===false)this.absolute-=this.profile.length;this.previous=p;this.first={...p,absolute:this.absolute};this.last={...p,absolute:this.absolute};return [];}
    const a=this.previous,dt=p.t-a.t,L=this.profile.length;let ds=p.s-a.s;if(ds>L/2)ds-=L;if(ds<-L/2)ds+=L;
    const max=Math.max(40,Math.abs(p.speed||0)*Math.max(dt,0)*3+10),physical=Math.hypot((p.x??a.x??0)-(a.x??0),(p.y??a.y??0)-(a.y??0));
    // Closest-spline projection can wobble at the wrap. Physical gate crossings
    // determine timing; projection only selects the correct lap of each gate.
    const q=centerAt({spline:this.profile.centerline,cum:this.profile.cum,totalLen:L},this.profile.origin+p.s);
    const forward=((p.x??0)-(a.x??0))*Math.cos(q.angle)+((p.y??0)-(a.y??0))*Math.sin(q.angle);
    const valid=dt>0&&dt<=.25&&Math.abs(ds)<=max&&physical<=max*2&&p.speed>=0&&forward>=-1e-5;
    const before=this.absolute;this.absolute+=ds;
    if(!valid||physical<.005){this.epoch++;}
    const previousTotals={...this.totals},ref=referenceAt(this.profile,p.s),tolerance=Math.max(12,this.profile.width*.18);
    this.totals.off+=p.offTrack?Math.max(0,dt):0;this.totals.line+=Math.min(4,((p.lateral-ref.offset)/tolerance)**2)*Math.max(0,dt);
    this.totals.suppressed+=p.suppressed?Math.max(0,dt):0;this.totals.smooth+=Math.abs((p.steer||0)-(a.steer||0));
    this.totals.drs+=p.drsActive?Math.max(0,dt):0;
    this.intervalMin=Math.min(this.intervalMin,p.speed||0);this.intervalJump=Math.max(this.intervalJump,Math.abs((p.steer||0)-(a.steer||0)));
    const completed=[];
    if(valid&&physical>0){
      const crossed=[];for(const gate of this.profile.gates){const sa=(a.x-gate.x)*gate.tx+(a.y-gate.y)*gate.ty,sb=(p.x-gate.x)*gate.tx+(p.y-gate.y)*gate.ty;
        if(sa<=0&&sb>0){const f=clamp(-sa/(sb-sa),0,1),x=a.x+(p.x-a.x)*f,y=a.y+(p.y-a.y)*f;
          const lateral=-(x-gate.x)*gate.ty+(y-gate.y)*gate.tx,lap=Math.round((this.absolute-gate.s)/L),absolute=gate.s+lap*L;
          if(Math.abs(lateral)<=this.profile.width*.65&&Math.abs(absolute-this.absolute)<max+this.profile.width)crossed.push({...gate,absolute,f});}}
      crossed.sort((a,b)=>a.f-b.f||a.id.localeCompare(b.id));
      for(const gate of crossed){const f=gate.f,totals={};for(const k of Object.keys(this.totals))totals[k]=previousTotals[k]+(this.totals[k]-previousTotals[k])*f;
        const event={...gate,t:interpolate(a,p,f,'t'),speed:interpolate(a,p,f,'speed'),charge:interpolate(a,p,f,'ersCharge'),
          energy:interpolate(a,p,f,'energyDeployed'),drs:interpolate(a,p,f,'drsTransitions'),contacts:p.contacts||0,offset:interpolate(a,p,f,'lateral'),
          epoch:this.epoch,totals,minSpeed:this.intervalMin,maxSteerJump:this.intervalJump,grip:p.grip,tyreWear:p.tyreWear,tyreTemp:p.tyreTemp,maxSpeed:p.maxSpeed};
        if(this.events.has(key(gate.absolute)+'/'+gate.id)){this.epoch++;continue;} // A repeated/reverse traversal cannot replace a prior crossing.
        this.events.set(key(gate.absolute)+'/'+gate.id,event);
        if(this.lastSplit&&gate.absolute>this.lastSplit.absolute+1e-7){const lap=Math.floor((this.lastSplit.absolute+1e-7)/L);
          this.splits.push({lap,from:this.lastSplit.id,to:gate.id,start:this.lastSplit.t,end:event.t,time:event.t-this.lastSplit.t,valid:event.epoch===this.lastSplit.epoch});}
        if(!this.lastSplit||gate.absolute>this.lastSplit.absolute+1e-7)this.lastSplit=event;
        this.intervalMin=p.speed||0;this.intervalJump=0;
      }
      if(crossed.length)for(let lap=0;lap<(this.context.raceLaps||1);lap++)for(const window of this.profile.windows){const id=lap+'/'+window.id,c=this.profile.corners.find(c=>c.id===window.id),next=this.profile.corners[(this.profile.corners.indexOf(c)+1)%this.profile.corners.length];
        if(!this.closed.has(id)&&this.eventAt(window.end+lap*L,next.id+'-entry')){const row=this.window(window,lap,false);this.rows.push(row);this.closed.add(id);completed.push(row);}}
    }
    this.previous=p;this.last={...p,absolute:this.absolute,totals:{...this.totals},epoch:this.epoch};return completed;
  }
  eventAt(s,id){return this.events.get(key(s)+'/'+id);}
  window(w,lap,partial){
    const c=this.profile.corners.find(c=>c.id===w.id),previous=this.profile.corners[mod(this.profile.corners.indexOf(c)-1,this.profile.corners.length)],next=this.profile.corners[(this.profile.corners.indexOf(c)+1)%this.profile.corners.length];
    const start=this.eventAt(w.start+lap*this.profile.length,previous.id+'-exit'),end=this.eventAt(w.end+lap*this.profile.length,next.id+'-entry');
    const via=w.via.map((s,i)=>this.eventAt(s+lap*this.profile.length,c.id+'-'+['entry','apex','exit'][i]));
    const inTimedRace=w.start+lap*this.profile.length>=-1e-5&&w.end+lap*this.profile.length<=(this.context.raceLaps||1)*this.profile.length+1e-5;
    const a=start||this.first,b=end||this.last,complete=inTimedRace&&!!start&&!!end&&via.every(Boolean)&&start.t<=via[0].t&&via[0].t<via[1].t&&via[1].t<via[2].t&&via[2].t<=end.t;
    const events=[...this.events.values()].filter(e=>e.t>a.t&&e.t<=b.t),valid=complete&&a.epoch===b.epoch&&events.every(e=>e.epoch===a.epoch)&&b.t>a.t;
    const delta=k=>(b.totals?.[k]||0)-(a.totals?.[k]||0),dt=Math.max(1e-9,b.t-a.t);
    const contacts=Math.max(0,(b.contacts||0)-(a.contacts||0)),offSeconds=Math.max(0,delta('off'));
    const cornerEvents=via.every(Boolean)?events.filter(e=>e.t>via[0].t&&e.t<=via[2].t):[];
    return {id:w.id,lap,complex:w.complex,profileHash:this.profile.profileHash,timingHash:this.profile.timingHash,start:a.t,end:b.t,time:b.t-a.t,partial:partial||!complete,partialReason:!inTimedRace?'lap-boundary':!complete?'missing-gate':null,
      bounds:{start:w.start+lap*this.profile.length,end:w.end+lap*this.profile.length},valid:valid&&!partial&&contacts===0&&offSeconds===0,
      entrySpeed:via[0]?.speed??null,apexSpeed:via[1]?.speed??null,exitSpeed:via[2]?.speed??null,nextEntrySpeed:end?.speed??null,
      minimumSpeed:Math.min(a.speed||0,b.speed||0,...events.map(e=>e.minSpeed)),batteryStart:a.charge??a.ersCharge,batteryEnd:b.charge??b.ersCharge,
      minimumCornerSpeed:via.every(Boolean)?Math.min(via[0].speed,via[2].speed,...cornerEvents.map(e=>e.minSpeed)):null,
      batteryUsed:(a.charge??a.ersCharge)-(b.charge??b.ersCharge),energyDeployed:(b.energy??b.energyDeployed??0)-(a.energy??a.energyDeployed??0),
      drsTransitions:(b.drs??b.drsTransitions??0)-(a.drs??a.drsTransitions??0),drsSeconds:delta('drs'),contacts,offSeconds,
      meanLineError:delta('line')/dt,guideGateErrors:via.map((e,i)=>e?Math.abs(e.offset-referenceAt(this.profile,w.via[i]).offset)/Math.max(12,this.profile.width*.18):null),
      suppressed:delta('suppressed')>1e-6,maxSteerJump:Math.max(0,...events.map(e=>e.maxSteerJump)),
      conditions:{...this.context,entrySpeed:a.speed,entryCharge:a.charge??a.ersCharge,grip:a.grip,tyreWear:a.tyreWear,tyreTemp:a.tyreTemp,maxSpeed:a.maxSpeed}};
  }
  finish(){if(!this.last)return {version:LINE_VERSION,profileHash:this.profile.profileHash,windows:[],splits:[]};const rows=[...this.rows];for(let lap=0;lap<(this.context.raceLaps||1);lap++)for(const w of this.profile.windows){const id=lap+'/'+w.id;
    if(!this.closed.has(id)&&w.via[0]+lap*this.profile.length<=this.last.absolute&&w.via[2]+lap*this.profile.length>=this.first.absolute)rows.push(this.window(w,lap,true));}
    return {version:LINE_VERSION,profileHash:this.profile.profileHash,timingHash:this.profile.timingHash,timingHz:this.context.timingHz||60,estimated:!!this.context.estimated,windows:rows,splits:[...this.splits]};}
  reward(rows,baselines=[],enabled=true){
    let style=0,timing=0;if(!enabled)return {style,timing};const count=Math.max(1,this.profile.corners.length*(this.context.raceLaps||1));
    for(const row of rows){const id=row.lap+'/'+row.id;if(this.paid.has(id))continue;this.paid.add(id);
      if(!row.valid||row.partial||!Number.isFinite(row.time)||row.time<=0||row.suppressed||row.maxSteerJump>.35)continue;
      if(row.guideGateErrors.every(e=>Number.isFinite(e)&&e<=1))style+=Math.max(0,1-row.meanLineError)*2/count;
      const matches=baselines.filter(b=>b.profileHash===this.profile.profileHash&&matchedWindow(row,b));
      if(matches.length){const baseline=Math.min(...matches.map(b=>b.time));if(row.time<baseline)timing+=Math.min(1,(baseline-row.time)/baseline)*3/count;}
    }
    style=Math.min(style,Math.max(0,2-this.linePaid));timing=Math.min(timing,Math.max(0,3-this.timePaid));this.linePaid+=style;this.timePaid+=timing;return {style,timing};
  }
}
export function matchedWindow(a,b){
  if(!a.valid||!b.valid||a.partial||b.partial||(a.timingHash&&b.timingHash?a.timingHash!==b.timingHash:a.profileHash!==b.profileHash)||a.id!==b.id||a.lap!==b.lap)return false;
  const x=a.conditions||{},y=b.conditions||{};
  for(const k of ['mode','difficulty','raceLaps','physicsHash','weather','tyres'])if(x[k]!==y[k])return false;
  for(const [k,tolerance] of [['entrySpeed',15],['entryCharge',.05],['grip',.03],['tyreWear',.03],['tyreTemp',5],['maxSpeed',5]])if(!Number.isFinite(x[k])||!Number.isFinite(y[k])||Math.abs(x[k]-y[k])>tolerance)return false;
  for(const [k,tolerance] of [['batteryEnd',.05],['energyDeployed',.05],['drsSeconds',.15]])if(!Number.isFinite(a[k])||!Number.isFinite(b[k])||Math.abs(a[k]-b[k])>tolerance)return false;
  return true;
}
export function analyseTrajectory(points,profile,context={}){
  const dt=points.length>1?points[1].t-points[0].t:0;
  const tracker=new SectorTracker(profile,{...context,estimated:true,timingHz:dt>0?Math.round(1/dt):0}),track={spline:profile.centerline,cum:profile.cum,totalLen:profile.length};let nearest=0;
  for(const p of points){let best=Infinity,index=0;for(let i=0;i<track.spline.length;i++){const q=track.spline[i],d=(p.x-q.x)**2+(p.y-q.y)**2;if(d<best){best=d;index=i;}}nearest=index;
    const a=track.spline[mod(nearest-1,track.spline.length)],b=track.spline[(nearest+1)%track.spline.length],angle=Math.atan2(b.y-a.y,b.x-a.x),q=track.spline[nearest];
    tracker.feed({...p,s:mod(track.cum[nearest]+(p.x-q.x)*Math.cos(angle)+(p.y-q.y)*Math.sin(angle)-profile.origin,profile.length),
      lateral:-(p.x-q.x)*Math.sin(angle)+(p.y-q.y)*Math.cos(angle),steer:p.action?.steer||0});
  }return tracker.finish();
}
export function styleScore(sectors){const rows=sectors.windows.filter(w=>w.valid&&!w.suppressed&&w.maxSteerJump<=.35&&w.guideGateErrors.every(e=>Number.isFinite(e)&&e<=1));
  return rows.reduce((s,w)=>s+Math.max(0,1-w.meanLineError),0)/Math.max(1,sectors.windows.length);}
