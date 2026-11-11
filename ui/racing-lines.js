import {buildProfile,validateProfile,analyseTrajectory,matchedWindow} from '../sim/racing-line.mjs';
import {PHYSICS_HASH} from '../sim/official-policy.mjs';
import {Gunzip} from '../sim/archive-gzip.mjs';
const root=document.createElement('main');root.id='ai-models';document.body.append(root);window.showScreen?.('ai-models');
root.style.background='#211a2d';
root.innerHTML=`<section id="rl-lock" class="am-card"><h1>Racing lines & corner timing</h1><form id="rl-unlock"><label>Password<input id="rl-password" type="password" required></label><button>Unlock</button></form><p id="rl-error"></p></section><div id="rl-body" hidden></div>`;
const $=id=>document.getElementById('rl-'+id);let profile,track,records=[],playing=false,time=0,lastFrame=0,clipEnd=Infinity,cache=new WeakMap();
const message=text=>$('status').textContent=text;
const safe=fn=>async()=>{try{await fn();}catch(error){message(error.message);}};
$('unlock').onsubmit=e=>{e.preventDefault();if(!window.unlockOfficialML($('password').value)){$('error').textContent='Incorrect password';return;}$('lock').hidden=true;$('body').hidden=false;open();};
function open(){
  $('body').innerHTML=`<h1>Racing lines & corner timing</h1><p><a href="ui/ai-models.html">AI Models</a> · <a href="index.html?tool=official-ml">Training</a></p>
  <section class="am-card"><h2>1. Choose the track and recordings</h2><div class="am-row"><label>Track<select id="rl-track"></select></label><label>Frozen reference-profile.json<input id="rl-profile" type="file" accept=".json"></label><label>Attempt recordings or native calibration archive<input id="rl-files" type="file" accept=".json,.jsonl,.gz" multiple></label></div>
  <p>Load the run’s reference-profile.json, then attempts.jsonl.gz or a native/calibration archive. All processing stays on this laptop. Existing pose-only recordings get estimated timing; V2’s stored timing uses 60 Hz physics.</p><p id="rl-status" role="status">Choose recordings to inspect a driven line. The initial reference is geometry-only, not a verified fastest line.</p></section>
  <section class="am-card"><h2>2. Compare full corner windows</h2><p>Each corner window starts at the previous corner’s exit and ends at the next corner’s entry. Windows overlap. The separate splits below add up across a complete lap. Speeds use game units/s; battery change uses percentage points (negative means recharge). Matched deltas require comparable incoming speed, battery, tyres and car performance.</p>
  <div class="am-row"><label>Selected attempt<select id="rl-attempt"></select></label><label>Comparison attempt<select id="rl-compare"><option value="">Frozen reference timing</option></select></label><button id="rl-play">Play recorded run</button><button id="rl-reset">Restart</button></div>
  <input id="rl-seek" type="range" min="0" max="1" value="0" step=".001" aria-label="Replay time"><p id="rl-clock"></p>
  <div class="rl-views"><figure><canvas id="rl-map" width="900" height="550" aria-label="Reference line, recorded paths and timing gates"></canvas><figcaption>Gold: reference · cyan: selected · pink: comparison · grey: timing gates</figcaption></figure><figure><canvas id="rl-camera" width="900" height="550" aria-label="Normal game camera with battery and DRS"></canvas><figcaption>Existing game camera · recorded battery / ERS / DRS</figcaption></figure></div>
  <div class="rl-table"><table><thead><tr><th>Corner / lap</th><th>Window time</th><th>Matched delta</th><th>Entry speed</th><th>Minimum speed</th><th>Exit speed</th><th>Next entry speed</th><th>Battery change</th><th>Status</th><th>Brake point / reference distance</th><th>Diagnostic</th></tr></thead><tbody id="rl-windows"></tbody></table></div></section>
  <details class="am-card"><summary>Non-overlapping lap splits</summary><p id="rl-resolution"></p><div class="rl-table"><table><thead><tr><th>Lap</th><th>From → to</th><th>Time</th><th>Status</th></tr></thead><tbody id="rl-splits"></tbody></table></div></details>`;
  const style=document.createElement('style');style.textContent=`#ai-models .rl-views{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}#ai-models figure{margin:8px 0;min-width:0}#ai-models canvas{width:100%;background:#181322;border-radius:8px}#ai-models .rl-table{overflow:auto}#ai-models table{width:100%;border-collapse:collapse}#ai-models th,#ai-models td{text-align:left;padding:8px;border-bottom:1px solid #674776;white-space:nowrap}#rl-seek{width:100%;margin-top:16px}@media(max-width:850px){#ai-models .rl-views{grid-template-columns:1fr}}`;root.append(style);
  style.textContent+=`#ai-models .am-card{background:#30253f;border-color:#674776}#ai-models input,#ai-models select,#ai-models button{background:#211a2d;border-color:#674776;color:#fff5e8}#ai-models h1,#ai-models h2{color:#ffb45c}#ai-models p{color:#d2bfd9}#ai-models a{color:#00f5ff}#ai-models #rl-play{background:#ff6b35;color:#211a2d}`;
  for(let id=0;id<8;id++)$('track').add(new Option(window.KartBlitzReplayScene.getTrack(id).name,String(id)));
  $('track').onchange=safe(()=>{setTrack(Number($('track').value));records=[];populate();render();});
  $('profile').onchange=safe(async()=>{const value=JSON.parse(await $('profile').files[0].text());const t=window.KartBlitzReplayScene.getTrack(value.trackId);validateProfile(value,t,PHYSICS_HASH);$('track').value=String(value.trackId);track=t;profile=value;cache=new WeakMap();render();message('Loaded frozen profile '+profile.profileHash+'. Timing gates stay fixed across every line.');});
  $('files').onchange=safe(async()=>{for(const file of $('files').files)await importRecords(file);populate();render();message(records.length?`Loaded ${records.length} attempts. ${records.length>=1000?'Showing the first 1,000 matching attempts; source archives are unchanged. ':''}Choose two attempts, or compare against frozen reference timing.`:'No trajectory records found. Choose attempts.jsonl.gz rather than attempt-index.jsonl.');});
  $('attempt').onchange=safe(()=>{time=selected()?.points[0]?.t||0;playing=false;clipEnd=Infinity;render();});$('compare').onchange=safe(render);
  $('play').onclick=()=>{playing=!playing;clipEnd=Infinity;$('play').textContent=playing?'Pause replay':'Play recorded run';};$('reset').onclick=()=>{time=selected()?.points[0]?.t||0;clipEnd=Infinity;draw();};
  $('seek').oninput=()=>{time=Number($('seek').value);draw();};setTrack(0);populate();render();requestAnimationFrame(frame);
}
function setTrack(id){track=window.KartBlitzReplayScene.getTrack(id);profile=buildProfile(track);cache=new WeakMap();}
function selected(){return records[Number($('attempt').value)];}
function comparison(){return $('compare').value===''?null:records[Number($('compare').value)];}
async function importRecords(file){
  const add=row=>{const meta=row.result?{...row.result,...Object.fromEntries(['trackId','profileHash','mode','raceLaps','difficulty'].filter(k=>row[k]!==undefined).map(k=>[k,row[k]]))}:row,points=row.points||row.trajectory;
    if(!points?.length)return;if(meta.trackId!==undefined&&Number(meta.trackId)!==profile.trackId)return;
    if(records.length>=1000)return;records.push({meta,points,name:`${row.arm||meta.mode||'Run'} · ${meta.attempt??meta.case??records.length+1} · ${file.name}`});};
  if(file.name.endsWith('.json')){const value=JSON.parse(await file.text());if(Array.isArray(value))value.forEach(add);else add(value);return;}
  let stream=file.stream();if(file.name.endsWith('.gz')){
    // Training writes one gzip member per attempt; native DecompressionStream
    // rejects concatenated members in Chromium. fflate streams them correctly.
    let unzip;stream=stream.pipeThrough(new TransformStream({start(controller){unzip=new Gunzip((data)=>controller.enqueue(data));},transform(chunk){unzip.push(chunk,false);},flush(){unzip.push(new Uint8Array(),true);}}));
  }
  const reader=stream.pipeThrough(new TextDecoderStream()).getReader();let pending='';
  try{while(true){const {value,done}=await reader.read();if(done)break;pending+=value;let cut;while((cut=pending.indexOf('\n'))>=0){const line=pending.slice(0,cut);pending=pending.slice(cut+1);if(line.trim())add(JSON.parse(line));}if(records.length>=1000){await reader.cancel();break;}}if(pending.trim()&&records.length<1000)add(JSON.parse(pending));}finally{reader.releaseLock();}
}
function populate(){const a=$('attempt'),b=$('compare');a.replaceChildren();b.replaceChildren(new Option('Frozen reference timing',''));records.forEach((r,i)=>{a.add(new Option(r.name,String(i)));b.add(new Option(r.name,String(i)));});time=selected()?.points[0]?.t||0;}
function analysis(record){
  if(!record)return null;const meta=record.meta;
  if(meta.profileHash&&meta.profileHash!==profile.profileHash&&meta.miniSectors?.timingHash!==profile.timingHash)throw Error('Load the matching reference-profile.json for this recording: '+meta.profileHash);
  if(cache.has(record))return cache.get(record);
  const value=meta.miniSectors?.timingHash===profile.timingHash?meta.miniSectors:analyseTrajectory(record.points,profile,{mode:meta.mode||'ai',difficulty:meta.difficulty||'extreme',raceLaps:meta.raceLaps||Math.max(1,record.points.at(-1).lapIndex||1),physicsHash:PHYSICS_HASH,weather:'dry',tyres:'med'});
  cache.set(record,value);return value;
}
const number=(v,d=1)=>Number.isFinite(v)?v.toFixed(d):'—';
function render(){
  const record=selected();if(!record){$('windows').replaceChildren();$('splits').replaceChildren();draw();return;}
  const sectors=analysis(record),other=comparison(),reference=other?analysis(other).windows:profile.baselines||[];
  $('windows').replaceChildren(...sectors.windows.map(w=>{const row=document.createElement('tr'),match=reference.filter(b=>matchedWindow(w,b)).sort((a,b)=>a.time-b.time)[0];
    const values=[`${w.id} / ${w.lap+1}`,number(w.time,3)+' s',match?number(w.time-match.time,3)+' s':'Unmatched',number(w.entrySpeed),number(w.minimumCornerSpeed),number(w.exitSpeed),number(w.nextEntrySpeed),number(w.batteryUsed*100)+' pp',w.partial?'Partial':w.valid?'Valid':'Invalid'];
    const diagnostic=record.meta.cornerDiagnostics?.find(d=>d.id===w.id&&d.lap===w.lap);values.push(diagnostic?`${number(diagnostic.brakePoint)} / ${number(diagnostic.referenceBrakingDistance)} units`:'—',diagnostic?.failures?.join(', ')||'No flagged issue');
    for(let i=0;i<values.length;i++){const cell=document.createElement('td');if(i===0){const button=document.createElement('button');button.textContent=values[i];button.onclick=()=>{time=w.start;clipEnd=w.end;playing=true;$('play').textContent='Pause replay';draw();};cell.append(button);}else cell.textContent=values[i];row.append(cell);}return row;}));
  $('splits').replaceChildren(...sectors.splits.map(s=>{const row=document.createElement('tr');for(const value of [s.lap+1,s.from+' → '+s.to,number(s.time,3)+' s',s.valid?'Valid':'Invalid']){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}return row;}));
  $('resolution').textContent=record.meta.miniSectors&&!sectors.estimated?'Stored 60 Hz physics timing. Start/finish-crossing interpolation can differ from the game’s tick-rounded lap clock by up to one physics tick.':`Estimated from ${sectors.timingHz||'sampled'} Hz recorded poses; small deltas may be sampling error. Partial windows are excluded from matched deltas.`;
  $('seek').min=record.points[0].t;$('seek').max=record.points.at(-1).t;draw();
}
function poseAt(points,t){let lo=0,hi=points.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(points[mid].t<=t)lo=mid;else hi=mid-1;}const a=points[lo],b=points[Math.min(lo+1,points.length-1)],f=b.t>a.t?Math.max(0,Math.min(1,(t-a.t)/(b.t-a.t))):0;return {...a,x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f};}
function draw(){
  const canvas=$('map'),ctx=canvas.getContext('2d'),all=profile.centerline,minX=Math.min(...all.map(p=>p.x)),maxX=Math.max(...all.map(p=>p.x)),minY=Math.min(...all.map(p=>p.y)),maxY=Math.max(...all.map(p=>p.y));
  const scale=Math.min((canvas.width-70)/(maxX-minX+profile.width),(canvas.height-70)/(maxY-minY+profile.width)),x=p=>(p.x-(minX+maxX)/2)*scale+canvas.width/2,y=p=>(p.y-(minY+maxY)/2)*scale+canvas.height/2;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  function path(points,color,width,closed=false){if(!points.length)return;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(x(p),y(p)):ctx.moveTo(x(p),y(p)));if(closed)ctx.closePath();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
  path(all,'#41394e',profile.width*scale,true);path(profile.reference,'#ffb45c',2,true);
  for(const g of profile.gates){const n={x:-g.ty,y:g.tx},a={x:g.x+n.x*profile.width*.5,y:g.y+n.y*profile.width*.5},b={x:g.x-n.x*profile.width*.5,y:g.y-n.y*profile.width*.5};path([a,b],'#b4a6bd',1);if(g.id.endsWith('-apex')){ctx.fillStyle='#fff5e8';ctx.fillText(g.id.replace('-apex',''),x(g)+5,y(g)-5);}}
  const record=selected(),other=comparison();if(other)path(other.points,'#ed8dd0',1.5);if(record)path(record.points,'#6ee7f7',2);
  const camera=$('camera'),c=camera.getContext('2d');c.clearRect(0,0,camera.width,camera.height);
  if(record){const pose=poseAt(record.points,time);ctx.fillStyle='#6ee7f7';ctx.beginPath();ctx.arc(x(pose),y(pose),5,0,Math.PI*2);ctx.fill();window.KartBlitzReplayScene.draw(c,track,{...pose,flags:pose.flags??(pose.ersActive?16:0)},camera.width,camera.height,(context,cam)=>{context.beginPath();profile.reference.forEach((p,i)=>i?context.lineTo(p.x-cam.x+camera.width/2,p.y-cam.y+camera.height/2):context.moveTo(p.x-cam.x+camera.width/2,p.y-cam.y+camera.height/2));context.closePath();context.strokeStyle='#ffb45c';context.lineWidth=2;context.stroke();});
    c.fillStyle='rgba(25,18,35,.9)';c.fillRect(12,12,460,65);c.fillStyle='#fff5e8';c.font='18px system-ui';c.fillText(`Battery ${number(pose.ersCharge*100,0)}% · ERS ${pose.ersActive?'ON':'OFF'} · DRS ${pose.drsActive?'ON':'OFF'}`,24,40);c.fillText(`${number(time,2)} s · speed ${number(pose.speed,0)}`,24,66);}
  $('seek').value=time;$('clock').textContent=number(time,2)+' s';
}
function frame(now){if(playing&&selected()){time+=(lastFrame?Math.min(.1,(now-lastFrame)/1000):0);const end=Math.min(clipEnd,selected().points.at(-1).t);if(time>=end){time=end;playing=false;$('play').textContent='Play recorded run';}draw();}lastFrame=now;requestAnimationFrame(frame);}
