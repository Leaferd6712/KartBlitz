import * as official from '../sim/official-policy.mjs';
import * as library from '../sim/ai-model-library.mjs';
const root=document.createElement('main');root.id='official-ml';document.body.appendChild(root);
window.showScreen?.('official-ml');
root.innerHTML=`<section id="om-lock" class="om-card"><h1>Official ML for AI</h1><p>Local training for AI Race and One Lap Shootout.</p><form id="om-unlock"><label>Password<input id="om-password" type="password" autocomplete="off" required></label><button class="om-primary">Unlock</button><p id="om-lock-error" role="alert"></p></form></section><div id="om-dashboard" hidden></div>`;
const $=id=>document.getElementById('om-'+id);
let jobId='',capturedJob='',job=null,track=null,liveTrack=null,replays=[],selected=0,mode='live',playTime=0,playing=true,previous=0,lastDraw=0,lastEpisode=null,pollTimer=null,replayCache=null,liveClip=null,clipTime=0,clipWall=0,replayRequest=0,loadingReplays=false;
let appliedBenchmark='';
let previewFrozen=true,previewReason='Waiting for actual car positions.',connectionLost=false,stopRequested=false,stopAcknowledged=false,pauseRequested=false,lastFrozenRender='';
function stopPlayback(){playing=false;if($('play'))$('play').textContent='Play replay';}
const terminal=status=>['complete','cancelled','failed'].includes(status);
function freezePreview(reason){previewFrozen=true;previewReason=reason;}
function updatePreviewState(){
  if(connectionLost)return freezePreview('Connection lost — last preview frozen. Trainer status is unconfirmed.');
  if(terminal(job?.status))return freezePreview(`${job.phase==='benchmark-finished'?'Benchmark': 'Job'} ${job.status} — preview stopped.`);
  if(stopRequested||job?.status==='stopping')return freezePreview(stopAcknowledged||job?.status==='stopping'?'Stop accepted — preview frozen while the trainer saves.':'Stop not confirmed — preview frozen; waiting for trainer acknowledgement.');
  if(pauseRequested||job?.status==='paused')return freezePreview('Training paused — preview frozen.');
  if(job?.phase==='evaluation')return freezePreview('Evaluating policy — training preview frozen.');
  previewFrozen=job?.status!=='running';previewReason='Waiting for the trainer to start.';
}
const params=new URLSearchParams(location.search);
// The trainer pairing code is separate from the deliberately simple HTML gate.
const incoming=params.get('trainerCode');
if(incoming){sessionStorage.setItem('official-trainer-code',incoming);params.delete('trainerCode');history.replaceState(null,'',location.pathname+'?'+params);}
const rememberedCode=incoming||sessionStorage.getItem('official-trainer-code')||localStorage.getItem('official-trainer-code')||'';
if(rememberedCode)localStorage.setItem('official-trainer-code',rememberedCode);
$('unlock').onsubmit=event=>{event.preventDefault();if(!window.unlockOfficialML($('password').value)){$('lock-error').textContent='Incorrect password';return;}$('lock').hidden=true;$('dashboard').hidden=false;open();};
function message(value){$('message').textContent=value;}
async function api(path,body){
  const base=$('url').value.replace(/\/$/,'');
  let response;
  try{response=await fetch(base+'/api/official/'+path,{method:body?'POST':'GET',headers:{'X-KartBlitz-Key':$('code').value,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  catch{connectionLost=true;stopPlayback();updatePreviewState();throw Error('Cannot reach the local trainer. Preview frozen; any stop request is unconfirmed. Click Connect to retry.');}
  const data=await response.json();if(!response.ok)throw Error(data.error||`Trainer ${response.status}`);return data;
}
function safe(action){return async()=>{try{await action();}catch(error){message(error.message);}};}
function open(){
  $('dashboard').innerHTML=`<div class="om-row"><div style="flex:1"><h1>Official ML for AI</h1><p>One learner, parallel driving environments. The preview observes training without slowing every car down to screen speed.</p></div><button id="om-window">Open separate window</button><a id="om-model-library" href="ui/ai-models.html" target="_blank">AI Models</a><a href="index.html">Game</a></div>
  <section class="om-card"><h2>Local trainer</h2><div class="om-row"><label>Trainer URL<input id="om-url" value="http://127.0.0.1:8766"></label><label>Pairing code<input id="om-code" autocomplete="off"></label><button id="om-connect">Connect</button><button id="om-benchmark">Benchmark CPU / GPU</button><button id="om-shutdown">Shut down trainer</button></div><p id="om-benchmark-results" class="om-muted" style="white-space:pre-line"></p><p id="om-device">Start the local trainer with npm run official:start. This opens the window and pairs it automatically.</p></section>
  <section class="om-card"><h2>Training setup</h2><div class="om-row"><label>Track<select id="om-track"></select></label><label>Budget<select id="om-budget"><option value="time" selected>Run for a set time</option><option value="steps">Run for a step count</option></select></label><label id="om-duration-label">Training hours<input id="om-hours" type="number" min="0.0166667" max="24" step="0.25" value="2"></label><label id="om-steps-label" hidden>Steps per track<input id="om-steps" type="number" min="128" max="100000000" value="1000000"></label><label>Parallel cars<input id="om-envs" type="number" min="1" max="128" value="128"></label><label>CPU worker batches<input id="om-workers" type="number" min="1" max="16" value="8"></label><label>Learning device<select id="om-device-choice"><option value="auto">Auto (CUDA if available)</option><option value="cpu">CPU</option><option value="cuda" selected>NVIDIA CUDA</option></select></label></div>
  <div class="om-row" style="margin-top:12px"><label>Difficulties<select id="om-difficulties"><option value="all">All five</option><option value="extreme" selected>Extreme first</option><option value="hard">Hard</option><option value="medium">Medium</option><option value="easy">Easy</option><option value="ultraeasy">Ultra easy</option></select></label><label>Opponents per environment<select id="om-traffic"><option value="0">0 · learn the track</option><option value="1">1</option><option value="2">2</option><option value="3">3 · racecraft</option></select></label><label>Resume earlier job ID (optional)<input id="om-resume" placeholder="Saved job ID"></label><label>Human laps, full archive JSON (optional)<input id="om-demos" type="file" accept=".json" multiple></label></div>
  <div class="om-row" style="margin-top:12px"><label>Training name<input id="om-run-name" maxlength="80" placeholder="e.g. Sunset solo two hours"></label><label>Rollout steps per car<input id="om-horizon" type="number" min="16" max="512" value="128"></label><label>Learning minibatch size<input id="om-batch-size" type="number" min="32" max="16384" value="2048"></label></div>
  <p class="om-muted">Timed training shares the total active-time budget across selected tracks and difficulties. Pauses do not use the budget. Final evaluation and saving can take a little extra time. Longer training does not guarantee a better model; the best evaluated checkpoint is kept.</p><p class="om-muted">GPU throughput defaults: 128 cars, eight physics workers and 2,048 samples per learning minibatch. The browser actor stays small. Larger batches can improve speed but change learning behaviour; compare completion and lap times. GPU load varies while CPU physics gathers experience. Calibration compares 16, 64 and 128 cars on CPU/CUDA and applies the best result for your selected device; Auto chooses the fastest overall.</p>
  <p class="om-muted">New attempts start from rest just behind the actual start/finish line. Start with one track and no traffic. A step is one 50 ms driving decision per car. An attempt is a completed or failed episode; it is not a training update. Budgets round to full PPO rollouts. Current training conditions: dry, medium tyres, stock dynamics with variation. Test wet weather and upgrades before using a policy there.</p><div class="om-row"><button id="om-start" class="om-primary">Start training</button><button id="om-pause">Pause</button><button id="om-resume-button">Resume</button><button id="om-stop">Stop and save</button></div></section>
  <p id="om-message" role="status"></p><section class="om-card"><h2>Measured progress</h2><div id="om-metrics">No training job yet.</div><p id="om-job" class="om-muted"></p><p id="om-performance" class="om-muted"></p><p id="om-hardware" class="om-muted"></p><p id="om-diagnostics" class="om-muted"></p><canvas id="om-history" width="1000" height="130" aria-label="Track completion progress history"></canvas><p class="om-muted">Chart: mean distance through an attempt (blue), completion rate (green). Evaluation uses a frozen policy in both modes. Evaluation times are diagnostics; compare real game laps under matched settings before claiming human or WR pace.</p></section>
  <div class="om-grid"><section class="om-card"><h2 id="om-view-title">Live training batch</h2><div class="om-row"><label>View<select id="om-view"><option value="live">Live batch</option><option value="early">Recorded attempts 1–1,000</option><option value="middle">Recorded attempts 3,001–4,000</option><option value="final">Last 1,000 recorded attempts</option></select></label><label>Worker batch<select id="om-batch"><option value="0">0</option></select></label><label>Follow car / attempt<select id="om-car"><option value="0">0</option></select></label><button id="om-refresh">Load recordings</button></div><canvas id="om-map" width="900" height="600"></canvas><p id="om-view-status" class="om-muted">Waiting for actual car positions.</p><div class="om-row"><button id="om-play">Pause replay</button><label>Replay seconds<input id="om-time" type="range" min="0" max="120" step=".05" value="0"></label><label>Replay speed<select id="om-speed"><option>1</option><option>4</option><option>10</option><option>25</option></select></label></div></section>
  <section class="om-card"><h2>Game camera · selected car</h2><canvas id="om-camera" width="750" height="500"></canvas><p id="om-car-status" class="om-muted">Uses the existing game renderer and camera.</p></section></div>
  <section class="om-card"><h2>Track weights</h2><div class="om-row"><label>Saved run ID<input id="om-load-id" placeholder="Reconnect to a run in this trainer session"></label><button id="om-load">Watch run</button><label>Import candidate package<input id="om-import" type="file" accept=".json,.kartai"></label></div><div id="om-packages"></div><p id="om-installed" class="om-muted"></p><p>Completed packages are automatically saved as candidates in AI Models. Open AI Models to inspect and manually activate a version. Current AI remains available. Download/import transfers candidates between your local trainer and the hosted game.</p></section>
  <section class="om-card"><h2>How to start</h2><p>1. Benchmark the laptop. 2. Train Extreme on one track with no traffic. 3. Inspect completions, paths and real game laps. 4. Resume that run with opponents for racecraft, then train all five difficulties. Training can require many millions of steps; a successful short test only proves the pipeline runs.</p><p>Every completed attempt is stored locally under ml_training/runs/official/&lt;job ID&gt;/attempts.jsonl.gz, including positions, controls, speed, progress, reward and contact counts. Keep last.zip for resuming and best.zip for evaluation. Closing this window does not stop training; use Stop and save.</p><p>Research: <a target="_blank" rel="noreferrer" href="https://www.gran-turismo.com/us/gran-turismo-sophy/project/">GT Sophy</a> · <a target="_blank" rel="noreferrer" href="https://github.com/trackmania-rl/tmrl">TMRL</a> · <a target="_blank" rel="noreferrer" href="https://github.com/Linesight-RL/linesight">Linesight</a> · <a target="_blank" rel="noreferrer" href="https://github.com/learn-to-race/l2r">Learn-to-Race</a> · <a target="_blank" rel="noreferrer" href="https://arxiv.org/abs/2306.07003">Trajectory-aided F1Tenth</a>. See docs/official-ml-research.md for what each supports and where this design differs.</p></section>`;
  simplifyLayout();
  const names=window.KartBlitzReplayScene;
  for(let id=0;id<8;id++){const t=names?.getTrack(id);$('track').add(new Option(t?.name||`Track ${id}`,id));}
  $('track').add(new Option('All tracks','all'));
  if(location.port==='8766')$('url').value=location.origin;
  $('code').value=rememberedCode;
  $('budget').onchange=updateBudgetControls;
  $('connect').onclick=safe(connect);$('benchmark').onclick=safe(()=>start(true));$('start').onclick=safe(()=>start(false));
  for(const [id,action] of [['pause','pause'],['resume-button','resume'],['stop','stop']])$(id).onclick=safe(()=>control(action));
  $('window').onclick=()=>window.open(location.href,'KartBlitzOfficialTraining','width=1400,height=950');
  $('shutdown').onclick=safe(async()=>{stopRequested=true;stopPlayback();updatePreviewState();await api('shutdown',{});message('Shutdown requested. Trainer is saving; preview stopped.');clearTimeout(pollTimer);});
  $('batch').onchange=safe(()=>control('batch',{batch:Number($('batch').value)}));
  $('car').onchange=()=>{selected=Number($('car').value);lastEpisode=null;liveClip=null;};
  $('view').onchange=safe(async()=>{mode=$('view').value;selected=0;playTime=0;await loadReplays();});
  $('refresh').onclick=safe(loadReplays);$('play').onclick=()=>{playing=!playing;$('play').textContent=playing?'Pause replay':'Play replay';};
  $('time').oninput=()=>{playTime=Number($('time').value);};
  $('load').onclick=safe(async()=>{const next=$('load-id').value.trim();if(next!==jobId){job=null;stopRequested=false;stopAcknowledged=false;pauseRequested=false;liveClip=null;freezePreview('Loading selected job…');}jobId=next;await poll();});
  $('import').onchange=safe(async()=>{const file=$('import').files[0];if(file)await install(JSON.parse(await file.text()));});
  updateInstalled();requestAnimationFrame(draw);if($('code').value)connect().catch(e=>message(e.message));
}
async function connect(){const s=await api('status');connectionLost=false;$('device').textContent=`${s.deviceName} · ${s.torchVersion||'No PyTorch'} · ${s.ready?'Ready':'Install dependencies first'} · CUDA ${s.cudaAvailable?'available':'unavailable'}`;if(!s.cudaAvailable&&$('device-choice').value==='cuda')$('device-choice').value='cpu';sessionStorage.setItem('official-trainer-code',$('code').value);localStorage.setItem('official-trainer-code',$('code').value);message('Trainer status loaded.');if(jobId)await poll();}
async function start(benchmarkOnly){
  freezePreview('Starting a new job…');stopRequested=false;stopAcknowledged=false;pauseRequested=false;
  const demonstrations=[];for(const file of $('demos').files)demonstrations.push(JSON.parse(await file.text()));
  const d=$('difficulties').value;
  const config={format:'kartblitz-official-job-v1',benchmarkOnly,budgetMode:$('budget').value,durationSeconds:Number($('hours').value)*3600,runName:$('run-name').value.trim(),trackIds:$('track').value==='all'?[0,1,2,3,4,5,6,7]:[Number($('track').value)],totalSteps:Number($('steps').value),numEnvs:Number($('envs').value),workers:Number($('workers').value),horizon:Number($('horizon').value),batchSize:Number($('batch-size').value),device:$('device-choice').value,allDifficulties:d==='all',difficulty:d==='all'?'extreme':d,traffic:Number($('traffic').value),demonstrations,...($('resume').value.trim()?{resumeJobId:$('resume').value.trim()}:{})};
  const s=await api('jobs',config);connectionLost=false;jobId=s.id;capturedJob='';library.rememberJob(jobId,$('url').value.replace(/\/$/,''));job=null;liveClip=null;replays=[];playing=true;mode='live';$('view').value='live';message(benchmarkOnly?'Benchmark queued. This compares devices; it does not produce trained weights.':'Training job queued. Keep its ID to resume later.');await poll();
}
async function control(action,extra={}){
  if(!jobId)throw Error('Start or select a run first');
  if(action==='stop'){stopRequested=true;stopAcknowledged=false;stopPlayback();updatePreviewState();
    if(terminal(job?.status)){freezePreview(`Displayed job is already ${job.status} — preview stopped.`);message('The displayed job has already finished. Its preview is now stopped.');return;}}
  if(terminal(job?.status)&&['pause','resume'].includes(action)){message('This job has finished. To continue training, start a new run using Resume earlier job ID.');return;}
  if(action==='pause'){pauseRequested=true;updatePreviewState();}
  try{
    const result=await api(`jobs/${jobId}/control`,{action,...extra});connectionLost=false;
    if(result.alreadyFinished){job.status=result.status;message('This job has already finished. Preview stopped.');}
    else if(action==='stop'){stopAcknowledged=true;job.status=result.status||'stopping';message('Stop accepted. Preview stopped; waiting for checkpoint save confirmation.');}
    else if(action==='pause'){job.status=result.status||'paused';message('Pause accepted.');}
    else if(action==='resume'){pauseRequested=false;job.status=result.status||'running';message('Resume accepted.');}
    else message(`${action} requested`);
    updatePreviewState();if(action!=='batch')await poll();
  }catch(error){if(action==='stop'){connectionLost=true;updatePreviewState();message('STOP NOT CONFIRMED: '+error.message);}else message(error.message);}
}
async function poll(){
  clearTimeout(pollTimer);if(!jobId)return;
  try{
    job=await api(`jobs/${jobId}`);connectionLost=false;updatePreviewState();$('model-library').href='ui/ai-models.html?jobId='+encodeURIComponent(jobId);library.rememberJob(jobId,$('url').value.replace(/\/$/,''));if(job.track){const t=job.track;liveTrack=window.KartBlitzReplayScene.getTrack(t.id,{spline:t.spline,trackWidth:t.width,cpLines:t.cpLines,cum:t.cum,totalLen:t.length});if(mode==='live')track=liveTrack;}
    $('job').textContent=`Job ${jobId} · track ${job.trackId??'—'} · ${job.difficulty||'—'} · ${job.phase||job.status}`;$('load-id').value=jobId;
    const evaluation=job.evaluation;
    const benchmark=job.kind==='benchmark'||job.phase?.startsWith('benchmark');
    const duration=n=>{n=Math.max(0,Math.floor(n||0));return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(v=>String(v).padStart(2,'0')).join(':');};
    $('metrics').textContent=`${benchmark?'Benchmark':'Training'} · ${job.status} · ${(job.completedSteps||0).toLocaleString()}${job.totalSteps?' / '+job.totalSteps.toLocaleString():''} steps${benchmark?'':` · ${(job.attempts||0).toLocaleString()} attempts`} · ${job.device||'initializing'}${job.budgetMode==='time'?`\nActive time ${duration(job.elapsedSeconds)} / ${duration(job.durationSeconds)} · ${duration(job.timeRemainingSeconds)} remaining`:''}${evaluation?.cancelled?'\nEvaluation incomplete: stopped before the test finished.':evaluation?`\nEvaluation: ${(evaluation.finishRate*100).toFixed(0)}% completed · median ${evaluation.medianLapTime?.toFixed(2)||'—'} s · ${(evaluation.offTrackRate*100).toFixed(1)}% off track`:''}`;
    if(stopRequested&&terminal(job.status))message(`Stop confirmed: job ${job.status}. Preview stopped.`);
    if(job.error)message(job.error);
    if(job.benchmark?.length){
      $('benchmark-results').textContent=job.benchmark.map(r=>`${r.device.toUpperCase()} · ${r.numEnvs??'—'} cars / ${r.workers??'—'} workers · batch ${r.batchSize??'—'} · ${r.stepsPerSecond.toFixed(0)} steps/s`).join('\n');
      if(job.phase==='benchmark-finished'&&job.status==='complete'&&appliedBenchmark!==jobId){
        const c=job.recommendedConfig||{device:job.recommendedDevice};
        if(c.device)$('device-choice').value=c.device;
        for(const [field,key] of [['envs','numEnvs'],['workers','workers'],['horizon','horizon'],['batch-size','batchSize']])if(c[key])$(field).value=c[key];
        appliedBenchmark=jobId;message(`Calibration complete. Applied ${c.device} settings for the selected device preference. `+(job.fastestOverall?`Fastest overall: ${job.fastestOverall.device}, ${job.fastestOverall.stepsPerSecond.toFixed(0)} steps/s. `:'')+'These measure compute speed, not driving quality.');
      }
    }
    renderPerformance();
    if(job.preview){options($('batch'),job.preview.batchCount,i=>`Batch ${i}`,Number($('batch').value));if(mode==='live')options($('car'),job.preview.environments.length,i=>`Car ${i}`,selected);}
    renderPackages();chart();
    if(['complete','cancelled'].includes(job.status)&&job.packages?.length&&capturedJob!==jobId){await library.captureFinishedJob({...job,id:jobId},track=>api(`jobs/${jobId}/model?trackId=${track}`));capturedJob=jobId;message((stopRequested?'Stop confirmed. ':'')+'Training weights saved to AI Models as inactive candidates. Your selected driver has not changed.');}
    const active=['queued','running','paused','stopping'].includes(job.status);$('start').disabled=active;$('benchmark').disabled=active;
    if(active)pollTimer=setTimeout(()=>poll(),900);
  }catch(error){connectionLost=true;stopPlayback();updatePreviewState();message(error.message+' · Click Connect or Watch run to verify the job status.');}
}
function renderPerformance(){
  const d=job.diagnostics,number=(v,digits=3)=>Number.isFinite(v)?v.toFixed(digits):'unavailable';
  $('diagnostics').textContent=d?`PPO health: KL ${number(d.approx_kl)} · clipped updates ${number(Number.isFinite(d.clip_fraction)?d.clip_fraction*100:null,1)}% · value explained variance ${number(d.explained_variance)}. Saved with each completed update; these are diagnostics, not a driving score.`:'';
  const p=job.performance,h=job.hardware;
  $('performance').textContent=p?`${p.stepsPerSecond.toFixed(0)} actual steps/s · sampling / logging / checks ${p.collectionSeconds.toFixed(1)} s · updates ${p.updateSeconds.toFixed(1)} s (${(p.updateWallFraction*100).toFixed(0)}% of measured wall time)`:'Throughput and timing appear after collection starts.';
  if(!h||h.gpuMemoryUsedMiB==null){$('hardware').textContent='GPU telemetry is being collected or is unavailable.';return;}
  const label=terminal(job.status)?'Last GPU sample':'GPU sample';
  $('hardware').textContent=`${label}: ${h.gpuUtilizationPercent.toFixed(0)}% whole-device utilization · VRAM ${(h.gpuMemoryUsedMiB/1024).toFixed(2)} / ${(h.gpuMemoryTotalMiB/1024).toFixed(2)} GiB`+
    (h.torchAllocatedMiB!=null?` · Torch tensors ${h.torchAllocatedMiB.toFixed(1)} MiB, peak ${h.torchPeakAllocatedMiB.toFixed(1)} MiB, reserved ${h.torchReservedMiB.toFixed(1)} MiB`:' · CPU learning does not store its model on CUDA')+
    (h.sampleAt?` · ${new Date(h.sampleAt*1000).toLocaleTimeString()}`:'');
}
function options(el,count,label,value){if(el.options.length!==count){el.replaceChildren(...Array.from({length:count},(_,i)=>new Option(label(i),i)));}el.value=String(Math.min(Math.max(0,value),count-1));}
async function loadReplays(){
  const token=++replayRequest;$('batch').disabled=mode!=='live';
  if(mode==='live'){track=liveTrack;loadingReplays=false;if(job?.preview)options($('car'),job.preview.environments.length,i=>`Car ${i}`,selected);return;}
  if(!jobId)throw Error('Select a run first');const requestedTrack=liveTrack;loadingReplays=true;message('Loading recorded attempts…');
  try{const s=await api(`jobs/${jobId}/replays?cohort=${mode}&trackId=${requestedTrack?.id??0}`);if(token!==replayRequest)return;
    replays=s.attempts;track=requestedTrack;replayCache=null;selected=0;options($('car'),replays.length,i=>`Attempt ${replays[i].attempt}`,0);playTime=0;
    const max=Math.max(1,...replays.map(r=>r.points.at(-1)?.t||0));$('time').max=max;message(`${replays.length} recorded attempts loaded. These are saved trajectories, not simultaneous training cars.`);
  }finally{if(token===replayRequest)loadingReplays=false;}
}
function download(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
async function install(pack){await library.saveCandidate(pack,{kind:'training-window-import',jobId});updateInstalled();message(`Saved ${pack.name} as a candidate. Open AI Models to activate it manually.`);}
function updateInstalled(){$('installed').textContent='Installed in this browser origin: '+([...official.packages.values()].map(p=>`${p.name} (${Object.keys(p.variants).join(', ')})`).join(' · ')||'none');}
function renderPackages(){const parent=$('packages');const signature=JSON.stringify((job.packages||[]).map(p=>[p.trackId,p.variants]));if(parent.dataset.signature===signature)return;parent.dataset.signature=signature;parent.replaceChildren();for(const pack of job.packages||[]){const row=document.createElement('div');row.className='om-row';const text=document.createElement('p');text.textContent=`${pack.name} · ${pack.variants.join(', ')}`;row.appendChild(text);for(const action of ['Download','Save candidate']){const b=document.createElement('button');b.textContent=action;b.onclick=safe(async()=>{const data=await api(`jobs/${jobId}/model?trackId=${pack.trackId}`);if(action==='Download')download(data,`track-${pack.trackId}.kartai.json`);else await install(data);});row.appendChild(b);}parent.appendChild(row);}}
function chart(){const c=$('history'),ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);const h=(job.history||[]).filter(r=>r.trackId===job.trackId&&r.difficulty===job.difficulty);for(const [key,color] of [['progress','#77bfff'],['finishRate','#67e0ab']]){ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();let first=true;for(let i=0;i<h.length;i++){if(h[i][key]==null)continue;const x=i/Math.max(1,h.length-1)*c.width,y=(1-Math.max(0,Math.min(1,h[i][key])))*(c.height-10)+5;if(first){ctx.moveTo(x,y);first=false;}else ctx.lineTo(x,y);}ctx.stroke();}}
function poseAt(points,t){if(!points?.length)return null;let lo=0,hi=points.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].t<t)lo=mid+1;else hi=mid;}const b=points[lo],a=points[Math.max(0,lo-1)],f=Math.min(1,Math.max(0,(t-a.t)/Math.max(.001,b.t-a.t)));return {...b,x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,a:a.a+Math.atan2(Math.sin(b.a-a.a),Math.cos(b.a-a.a))*f};}
function draw(now){requestAnimationFrame(draw);if(now-lastDraw<1000/30)return;lastDraw=now;const dt=Math.min(.1,(now-previous)/1000||0);previous=now;if(!track)return;
  const frozenKey=mode==='live'&&previewFrozen?`${jobId}:${selected}:${$('batch').value}:${previewReason}`:'';
  if(frozenKey&&lastFrozenRender===frozenKey)return;lastFrozenRender=frozenKey;
  const c=$('map'),ctx=c.getContext('2d'),spl=track.spline;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of spl){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}const scale=Math.min((c.width-50)/(maxX-minX+track.trackWidth),(c.height-50)/(maxY-minY+track.trackWidth));const x=p=>(p.x-(minX+maxX)/2)*scale+c.width/2,y=p=>(p.y-(minY+maxY)/2)*scale+c.height/2;
  ctx.clearRect(0,0,c.width,c.height);ctx.beginPath();spl.forEach((p,i)=>i?ctx.lineTo(x(p),y(p)):ctx.moveTo(x(p),y(p)));ctx.closePath();ctx.strokeStyle='#354156';ctx.lineWidth=track.trackWidth*scale;ctx.lineJoin='round';ctx.stroke();
  const sf=track.cpLines?.[0];if(sf){ctx.beginPath();ctx.strokeStyle='#ffffff';ctx.lineWidth=3;ctx.setLineDash([5,5]);ctx.moveTo(x({x:sf.x1,y:sf.y1}),y({x:sf.x1,y:sf.y1}));ctx.lineTo(x({x:sf.x2,y:sf.y2}),y({x:sf.x2,y:sf.y2}));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#ffffff';ctx.font='12px Nunito, sans-serif';ctx.fillText('START / FINISH',x({x:(sf.x1+sf.x2)/2})+10,y({y:(sf.y1+sf.y2)/2})-10);}
  let cars=[],pose=null,details='';
  if(mode==='live'){
    const rows=job?.preview?.environments||[];const row=rows[selected]||rows[0];cars=rows.map(r=>r.car);pose=row?.car;
    if(row){const key=`${jobId}:${job.preview.batch}:${row.environment}:${row.episode}`;if(lastEpisode!==key){window.KartBlitzReplayScene.clear();lastEpisode=key;}
      ctx.strokeStyle='#73c8ff';ctx.lineWidth=1.5;ctx.beginPath();row.path.forEach((p,i)=>i?ctx.lineTo(x(p),y(p)):ctx.moveTo(x(p),y(p)));ctx.stroke();
      if(!liveClip||liveClip.track!==track.id||liveClip.batch!==job.preview.batch||liveClip.selected!==selected||(!previewFrozen&&(clipTime>=liveClip.points.at(-1).t||clipWall>8))){liveClip={...row,track:track.id,batch:job.preview.batch,selected,points:row.path};clipTime=row.path[0]?.t||0;clipWall=0;}
      if(!previewFrozen){clipTime+=dt;clipWall+=dt;}pose=poseAt(liveClip.points,clipTime)||row.car;
      details=`Car ${row.environment} · sampled attempt ${liveClip.episode} · ${liveClip.mode} · camera ${clipTime.toFixed(1)} s · batch reward ${row.reward.toFixed(1)}`;}
    $('view-status').textContent=previewFrozen?previewReason:`${cars.length} live environments from batch ${job?.preview?.batch??0}. Updates are sampled; training runs faster than playback.`;
    if(previewFrozen)details+=' · PREVIEW STOPPED';
  }else{
    if(playing)playTime+=dt*Number($('speed').value);const max=Number($('time').max);if(playTime>max)playTime=0;$('time').value=playTime;
    if(!replayCache){replayCache=document.createElement('canvas');replayCache.width=c.width;replayCache.height=c.height;const rc=replayCache.getContext('2d');rc.strokeStyle='rgba(100,190,255,.07)';rc.lineWidth=1;for(const r of replays){rc.beginPath();r.points.forEach((p,i)=>i?rc.lineTo(x(p),y(p)):rc.moveTo(x(p),y(p)));rc.stroke();}}
    ctx.drawImage(replayCache,0,0);
    for(let i=0;i<replays.length;i++){const points=replays[i].points;if(i===selected){ctx.beginPath();ctx.strokeStyle='#ffe17c';ctx.lineWidth=2;for(let j=0;j<points.length;j++){const p=points[j];if(p.t>playTime)break;if(j)ctx.lineTo(x(p),y(p));else ctx.moveTo(x(p),y(p));}ctx.stroke();}const p=poseAt(points,playTime);if(p)cars.push(p);if(i===selected)pose=p;}
    const row=replays[selected];if(row)details=`Attempt ${row.attempt} · ${row.difficulty} · ${row.finished?'finished':'failed / timed out'} · ${playTime.toFixed(1)} s · ${row.contacts} contacts`;
    $('view-status').textContent=loadingReplays?'Loading recorded attempts…':`${replays.length} recorded attempts · full paths overlaid · cars at ${playTime.toFixed(1)} s. Failed cars stop at their last recorded position.`;
  }
  cars.forEach((p,i)=>{ctx.fillStyle=i===selected?'#ffe17c':p.offTrack?'#ff8f92':'#7ce6c7';ctx.beginPath();ctx.arc(x(p),y(p),i===selected?5:2.4,0,Math.PI*2);ctx.fill();});
  const camera=$('camera');if(pose){window.KartBlitzReplayScene.draw(camera.getContext('2d'),track,pose,camera.width,camera.height,()=>{});$('car-status').textContent=details+` · speed ${pose.speed?.toFixed(0)||0}`;}else{camera.getContext('2d').clearRect(0,0,camera.width,camera.height);$('car-status').textContent=loadingReplays?'Loading…':'No recorded car available in this range.';}
  $('view-title').textContent=mode==='live'?(previewFrozen?'Training preview · stopped':'Live training batch'):'Recorded training attempts';
}

function updateBudgetControls(){
  const timed=$('budget').value==='time';$('duration-preset-label').hidden=!timed;
  $('duration-label').hidden=!timed||$('duration-preset').value!=='custom';$('steps-label').hidden=timed;
}
function simplifyLayout(){
  const setup=$('track').closest('section'),connection=$('url').closest('section'),progress=$('metrics').closest('section');
  connection.querySelector('h2').textContent='1. Connect your laptop';setup.querySelector('h2').textContent='2. Choose your training run';
  const intro=document.createElement('div');intro.className='om-start-guide';
  intro.innerHTML=`<p>Open <strong>Command Prompt (CMD)</strong> on your laptop, paste these two lines and press Enter. Use the local training window it opens: pairing is automatic.</p><pre id="om-command"></pre><button id="om-copy-command">Copy CMD command</button><p class="om-muted">This command uses the KartBlitz folder shown above. If you moved the project, change the folder in the command. Keep the laptop plugged in and awake while training.</p><details><summary>First time on this laptop?</summary><p>Install Node.js and Python, download this repository, then run <code>npm install</code> and <code>npm run official:install</code> from its folder once. After installation, use the startup command above.</p></details><p><a href="http://127.0.0.1:8766/index.html?tool=official-ml" target="_blank">Open local training window</a> · Unlock with <strong>KartBlitzPass</strong>. If pairing is missing, rerun the startup command.</p>`;
  intro.querySelector('pre').textContent=String.raw`cd /d "C:\Users\mcmat\Downloads\KartBlitz"`+'\nnpm run official:start';
  connection.querySelector('h2').after(intro);
  $('copy-command').onclick=safe(async()=>{await navigator.clipboard.writeText($('command').textContent);$('copy-command').textContent='Copied — paste into CMD';});
  const advanced=document.createElement('details');advanced.id='om-advanced';advanced.innerHTML='<summary>Advanced settings · defaults are ready for your GPU</summary><div class="om-row"></div>';
  const advancedRow=advanced.querySelector('.om-row');
  for(const id of ['envs','workers','device-choice','horizon','batch-size','budget','resume','demos'])advancedRow.append($(id).closest('label'));
  advancedRow.append($('benchmark'),$('shutdown'));
  const duration=document.createElement('label');duration.id='om-duration-preset-label';duration.innerHTML='<span>Training time</span><select id="om-duration-preset"><option value="0.5">30 minutes</option><option value="1">1 hour</option><option value="2" selected>2 hours</option><option value="4">4 hours</option><option value="custom">Custom time</option></select>';
  $('duration-label').before(duration);$('duration-preset').onchange=()=>{if($('duration-preset').value!=='custom')$('hours').value=$('duration-preset').value;updateBudgetControls();};
  for(const p of [...setup.querySelectorAll(':scope > p')])advanced.append(p);
  const note=document.createElement('p');note.textContent='Start with one track, Extreme and no opponents. The time is shared across selected tracks. Pause freezes the timer; final checks and saving may take a little longer. Finished weights go to AI Models for you to choose.';
  setup.querySelector('h2').after(note);setup.append(advanced);updateBudgetControls();
  const watch=document.createElement('section');watch.className='om-card';watch.innerHTML='<h2>3. Watch the driving</h2><p>Watch one live batch and follow a car with the game camera, or overlay up to 1,000 recorded attempts from this run.</p><div class="om-row"><button data-watch="live">Watch current batch</button><button data-watch="final">Replay latest 1,000 attempts</button><button data-watch="early">Replay first 1,000</button><button data-watch="middle">Replay attempts 3,001–4,000</button></div><p class="om-muted">Start a run first. Replay groups fill as attempts are recorded; they are not 1,000 cars training together. Use Follow car / attempt below to choose the camera car.</p>';
  const views=$('map').closest('.om-grid');views.before(watch);views.after(progress);
  for(const button of watch.querySelectorAll('button'))button.onclick=safe(async()=>{if(!jobId)throw Error('Start training first, or use Watch run below to load an existing run.');mode=button.dataset.watch;$('view').value=mode;selected=0;playTime=0;playing=true;$('play').textContent='Pause replay';await loadReplays();views.scrollIntoView({behavior:'smooth',block:'start'});});
  for(const id of ['performance','hardware','diagnostics']){let detail=progress.querySelector('details');if(!detail){detail=document.createElement('details');detail.innerHTML='<summary>GPU and learning details</summary>';progress.append(detail);}detail.append($(id));}
  const weights=$('load-id').closest('section');const extra=document.createElement('details');extra.className='om-card';extra.innerHTML='<summary>Saved runs, downloads and research</summary>';weights.before(extra);extra.append(weights);const help=[...$('dashboard').querySelectorAll('section')].find(e=>e.querySelector('h2')?.textContent==='How to start');if(help)extra.append(help);
  $('dashboard').querySelector('h1').nextElementSibling.textContent='Train on your laptop. Watch real driving. Choose the finished model yourself.';
}
