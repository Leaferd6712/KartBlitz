/** Geometry checks shared by the widening tool and its preview. Units are game-world units. */
export const ROAD_GAP = 48, KERB_MARGIN = 12;
export const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const mod = (a,n) => ((a%n)+n)%n;
export function loopLengths(points) {
  const cum=[0];
  for(let i=0;i<points.length;i++) cum.push(cum.at(-1)+distance(points[i],points[(i+1)%points.length]));
  return {cum,length:cum.at(-1)};
}
export function loopAt(points, fraction) {
  const {cum,length}=loopLengths(points),s=mod(fraction,1)*length;
  let lo=0,hi=points.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(cum[m+1]<s)lo=m+1;else hi=m;}
  const a=points[lo],b=points[(lo+1)%points.length],u=(s-cum[lo])/(cum[lo+1]-cum[lo]||1);
  const angle=Math.atan2(b.y-a.y,b.x-a.x);
  return {x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u,angle,index:lo,u};
}
export function resampleLoop(points, spacing) {
  const {length}=loopLengths(points),n=Math.max(16,Math.ceil(length/spacing));
  return Array.from({length:n},(_,i)=>{const p=loopAt(points,i/n);return {x:p.x,y:p.y};});
}
export function curveAt(points, fraction) {
  const n=points.length,u=mod(fraction,1)*n,i=Math.floor(u),t=u-i,t2=t*t,t3=t2*t;
  const [a,b,c,d]=[-1,0,1,2].map(k=>points[mod(i+k,n)]);
  const weights=[-.5*t3+t2-.5*t,1.5*t3-2.5*t2+1,-1.5*t3+2*t2+.5*t,.5*t3-.5*t2];
  const derivatives=[-1.5*t2+2*t-.5,4.5*t2-5*t,-4.5*t2+4*t+.5,1.5*t2-t];
  const pts=[a,b,c,d],x=pts.reduce((v,p,j)=>v+p.x*weights[j],0),y=pts.reduce((v,p,j)=>v+p.y*weights[j],0);
  const dx=pts.reduce((v,p,j)=>v+p.x*derivatives[j],0),dy=pts.reduce((v,p,j)=>v+p.y*derivatives[j],0);
  return {x,y,angle:Math.atan2(dy,dx)};
}
export function sampleCurve(points,steps=12){return Array.from({length:points.length*steps},(_,i)=>{const p=curveAt(points,i/(points.length*steps));return {x:p.x,y:p.y};});}
function projection(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,u=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return {x:a.x+dx*u,y:a.y+dy*u,u};}
export function projectLoop(points,p){
  const {cum,length}=loopLengths(points);let best=null;
  for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length],q=projection(p,a,b),d=distance(p,q);
    if(!best||d<best.distance){const angle=Math.atan2(b.y-a.y,b.x-a.x);best={...q,index:i,distance:d,fraction:(cum[i]+distance(a,q))/length,angle,lateral:-(p.x-q.x)*Math.sin(angle)+(p.y-q.y)*Math.cos(angle)};}}
  return best;
}
export function closestSegments(a,b,c,d){
  const rx=b.x-a.x,ry=b.y-a.y,sx=d.x-c.x,sy=d.y-c.y,den=rx*sy-ry*sx;
  if(Math.abs(den)>1e-10){const qx=c.x-a.x,qy=c.y-a.y,u=(qx*sy-qy*sx)/den,v=(qx*ry-qy*rx)/den;
    if(u>=0&&u<=1&&v>=0&&v<=1)return {distance:0,u,v,a:{x:a.x+rx*u,y:a.y+ry*u},b:{x:a.x+rx*u,y:a.y+ry*u}};}
  const ac=projection(a,c,d),bc=projection(b,c,d),ca=projection(c,a,b),da=projection(d,a,b);
  return [{distance:distance(a,ac),u:0,v:ac.u,a,b:ac},{distance:distance(b,bc),u:1,v:bc.u,a:b,b:bc},
    {distance:distance(c,ca),u:ca.u,v:0,a:ca,b:c},{distance:distance(d,da),u:da.u,v:1,a:da,b:d}].sort((p,q)=>p.distance-q.distance)[0];
}
export function analyseLoop(points,width,{gap=ROAD_GAP,kerb=KERB_MARGIN,details=true,radiusFactor=1}={}){
  const n=points.length,{cum,length}=loopLengths(points),physicalRadius=width/2+kerb+gap/2,radiusRequired=physicalRadius*radiusFactor,clearanceRequired=width+2*kerb+gap;
  const localArc=Math.PI*physicalRadius,pairs=[],bends=[];let minClearance=Infinity,minRadius=Infinity,crossings=0;
  // Segments are indexed in every grid cell their bounding boxes touch.
  const cell=clearanceRequired,buckets=new Map(),seen=new Set();
  for(let i=0;i<n;i++){
    const a=points[i],b=points[(i+1)%n];
    const x0=Math.floor(Math.min(a.x,b.x)/cell),x1=Math.floor(Math.max(a.x,b.x)/cell),y0=Math.floor(Math.min(a.y,b.y)/cell),y1=Math.floor(Math.max(a.y,b.y)/cell);
    const candidates=new Set();
    for(let x=x0-1;x<=x1+1;x++)for(let y=y0-1;y<=y1+1;y++)for(const j of buckets.get(x+','+y)||[])candidates.add(j);
    for(const j of candidates){if(j===i||mod(i-j,n)===1||mod(j-i,n)===1)continue;const key=j*n+i;if(seen.has(key))continue;seen.add(key);
      const near=closestSegments(a,b,points[j],points[(j+1)%n]);
      if(near.distance<1e-7)crossings++;
      const sa=cum[i]+near.u*(cum[i+1]-cum[i]),sb=cum[j]+near.v*(cum[j+1]-cum[j]);
      const arc=Math.min(Math.abs(sa-sb),length-Math.abs(sa-sb));
      if(arc<localArc)continue;
      minClearance=Math.min(minClearance,near.distance);
      if(near.distance<clearanceRequired-.05)pairs.push({i,j,...near,required:clearanceRequired});
    }
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=x+','+y;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(i);}
  }
  // Measure bends over a road-width-sized arc, avoiding numerical kinks in a tessellated curve.
  for(let i=0;i<n;i++){
    let prev=mod(i-1,n),next=(i+1)%n;
    while(prev!==i&&distance(points[prev],points[i])<width*.32)prev=mod(prev-1,n);
    while(next!==i&&distance(points[next],points[i])<width*.32)next=(next+1)%n;
    const a=points[prev],b=points[i],c=points[next],ab=distance(a,b),bc=distance(b,c),ac=distance(a,c);
    const twiceArea=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x));
    const radius=twiceArea>1e-7?ab*bc*ac/(2*twiceArea):Infinity;
    minRadius=Math.min(minRadius,radius);
    if(radius<radiusRequired-.05)bends.push({i,prev,next,radius,required:radiusRequired});
  }
  return {safe:pairs.length===0&&bends.length===0&&crossings===0,minClearance,minRadius,clearanceRequired,radiusRequired,crossings,
    conflicts:pairs.length,tightBends:bends.length,...(details?{pairs,bends}:{})};
}

/** Bounded elastic separation; node order is retained and the width target is never reduced. */
export function separateRoad(original,width,{iterations=1400,onProgress=()=>{}}={}){
  const points=resampleLoop(original,width*.32),rest=points.map(p=>({...p})),n=points.length;
  for(let pass=0;pass<iterations;pass++){
    const audit=analyseLoop(points,width,{gap:ROAD_GAP+20,radiusFactor:1.65});
    if(pass%100===0)onProgress({pass,conflicts:audit.conflicts,tightBends:audit.tightBends,crossings:audit.crossings});
    if(audit.safe)break;
    const force=points.map(()=>({x:0,y:0,w:0}));
    const push=(i,x,y,w=1)=>{i=mod(i,n);force[i].x+=x*w;force[i].y+=y*w;force[i].w+=w;};
    for(const pair of audit.pairs){let dx=pair.a.x-pair.b.x,dy=pair.a.y-pair.b.y,d=Math.hypot(dx,dy);
      if(d<1e-6){const a=points[pair.i],b=points[(pair.i+1)%n];dx=-(b.y-a.y);dy=b.x-a.x;d=Math.hypot(dx,dy)||1;}
      const amount=Math.min(width*.16,(pair.required-pair.distance)*.6),x=dx/d*amount,y=dy/d*amount;
      push(pair.i,x,y,1-pair.u);push(pair.i+1,x,y,pair.u);push(pair.j,-x,-y,1-pair.v);push(pair.j+1,-x,-y,pair.v);}
    for(const bend of audit.bends){const p=points[bend.i],q=projection(p,points[bend.prev],points[bend.next]);
      const amount=Math.min(.4,(1-bend.radius/bend.required)*.5);push(bend.i,(q.x-p.x)*amount,(q.y-p.y)*amount,1.5);}
    const delta=force.map((f,i)=>{const prev=mod(i-1,n),next=(i+1)%n;
      const sx=(points[prev].x-rest[prev].x+points[next].x-rest[next].x)/2-(points[i].x-rest[i].x);
      const sy=(points[prev].y-rest[prev].y+points[next].y-rest[next].y)/2-(points[i].y-rest[i].y);
      let x=f.x/Math.max(1,f.w)+sx*.035,y=f.y/Math.max(1,f.w)+sy*.035;
      const d=Math.hypot(x,y),limit=width*.045;if(d>limit){x*=limit/d;y*=limit/d;}return {x,y};});
    points.forEach((p,i)=>{p.x+=delta[i].x;p.y+=delta[i].y;});
    if(pass%50===49){const even=Array.from({length:n},(_,i)=>loopAt(points,i/n));points.forEach((p,i)=>{p.x=even[i].x;p.y=even[i].y;});}
  }
  const curve=sampleCurve(points,12),report=analyseLoop(resampleLoop(curve,width*.075),width,{details:false});
  return {points,curve,report,displacement:Math.max(...points.map(p=>projectLoop(original,p).distance))};
}

export function analysePitLane(road,roadWidth,lane){
  const {cum,length}=loopLengths(road),path=lane.path,required=roadWidth/2+lane.width/2+2*KERB_MARGIN+ROAD_GAP;
  const entry=projectLoop(road,path[0]).fraction*length,exit=projectLoop(road,path.at(-1)).fraction*length;
  const arcDistance=(a,b)=>Math.min(mod(a-b,length),mod(b-a,length));
  let conflicts=0,crossings=0,minBodyClearance=Infinity,minRadius=Infinity;
  for(let i=0;i<path.length-1;i++){
    const t=(i+.5)/(path.length-1),merge=t<.24||t>.76;
    for(let j=0;j<road.length;j++){
      const q=closestSegments(path[i],path[i+1],road[j],road[(j+1)%road.length]);
      const s=cum[j]+q.v*(cum[j+1]-cum[j]);
      const authorizedMerge=merge&&arcDistance(s,t<.5?entry:exit)<roadWidth*2.5;
      if(authorizedMerge)continue;
      minBodyClearance=Math.min(minBodyClearance,q.distance);
      if(q.distance<required-.1)conflicts++;
    }
    for(let j=i+2;j<path.length-1;j++)if(closestSegments(path[i],path[i+1],path[j],path[j+1]).distance<1e-7)crossings++;
  }
  for(let i=1;i<path.length-1;i++){
    const a=path[i-1],b=path[i],c=path[i+1],area=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x));
    if(area>1e-7)minRadius=Math.min(minRadius,distance(a,b)*distance(b,c)*distance(a,c)/(2*area));
  }
  return {safe:conflicts===0&&crossings===0&&minRadius>=lane.width/2+KERB_MARGIN,conflicts,crossings,minBodyClearance,minRadius,clearanceRequired:required};
}
