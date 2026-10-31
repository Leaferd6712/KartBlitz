import * as official from '../sim/official-policy.mjs';
import * as library from '../sim/ai-model-library.mjs';
const root=document.createElement('main');root.id='ai-models';document.body.appendChild(root);window.showScreen?.('ai-models');
root.innerHTML=`<section id="am-lock" class="am-card"><h1>AI Models</h1><p>Keep Current AI and review trained candidates before switching.</p><form id="am-unlock"><label>Password<input id="am-password" type="password" required autocomplete="off"></label><button>Unlock</button><p id="am-error" role="alert"></p></form></section><div id="am-body" hidden></div>`;
const $=id=>document.getElementById('am-'+id),params=new URLSearchParams(location.search);
let timer=null,connected=false,rows=[],busy=false;
const checkedJobs=new Map();
const incoming=params.get('trainerCode');if(incoming){localStorage.setItem('official-trainer-code',incoming);params.delete('trainerCode');history.replaceState(null,'',location.pathname+'?'+params);}
function message(s){$('message').textContent=s;}
const safe=fn=>async()=>{try{await fn();}catch(error){message(error.message);}};
function download(pack){const url=URL.createObjectURL(new Blob([JSON.stringify(pack)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`track-${pack.trackId}-${pack.variants.extreme?.id?.slice(0,8)||'candidate'}.kartai.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
async function api(path){const response=await fetch($('url').value.replace(/\/$/,'')+'/api/official/'+path,{headers:{'X-KartBlitz-Key':$('code').value}});const body=await response.json();if(!response.ok)throw Error(body.error||`Trainer ${response.status}`);return body;}
$('unlock').onsubmit=e=>{e.preventDefault();if(!window.unlockOfficialML($('password').value)){$('error').textContent='Incorrect password';return;}$('lock').hidden=true;$('body').hidden=false;open().catch(e=>message(e.message));};
async function open(){
  $('body').innerHTML=`<div class="am-row"><div style="flex:1"><h1>AI Models</h1><p>Training adds candidates here. You choose when to change the driver.</p></div><a href="index.html?tool=official-ml">Training window</a><a href="index.html">Open game</a></div>
  <section id="am-current" class="am-card"><h2>Current AI · built-in controller</h2><p id="am-active"></p><p>The original racing-line, braking, overtaking and pit-strategy controller remains in the game. It has no RL weight file to overwrite. All five existing difficulties stay available.</p><button id="am-use-current">Use Current AI</button><details><summary>Inspect the actual Current AI driving algorithm</summary><pre id="am-source"></pre></details></section>
  <section class="am-card"><h2>Receive completed training files</h2><div class="am-row"><label>Local trainer URL<input id="am-url" value="http://127.0.0.1:8766"></label><label>Pairing code<input id="am-code" autocomplete="off"></label><button id="am-connect">Connect and sync</button></div><div class="am-row" style="margin-top:12px"><label>Watch a training job ID (optional)<input id="am-job" placeholder="Useful for a run started in an older training window"></label><button id="am-watch">Watch this run</button><label>Import candidate file<input id="am-import" type="file" accept=".json,.kartai" multiple></label></div><p id="am-sync" class="am-subtle">Completed runs started in the updated training window are received automatically. Imports also remain candidates until you choose Use this model.</p></section>
  <p id="am-message" role="status"></p><section><div class="am-row"><h2>Saved RL candidates</h2><label>Track filter<select id="am-filter"><option value="all">All tracks</option></select></label></div><div id="am-candidates"></div></section>
  <section class="am-card"><h2>Manual activation and rollback</h2><p>Use this model installs that candidate for its track and enables trained driving in AI Race and One Lap Shootout. Missing track/difficulty weights use Current AI. Other modes are unaffected. New races use your selection; a race already in progress keeps its controller.</p><p>Use Current AI switches back immediately for future races and keeps every candidate and installed package. Activating a replacement also archives the previously installed weights, so you can select an earlier version again.</p><p class="am-subtle">Selections and candidates belong to this browser origin. To use a local candidate on GitHub Pages, download it, open this page on the hosted site and import it there. Pushing the website does not automatically activate an RL candidate for players.</p></section>`;
  for(let id=0;id<8;id++)$('filter').add(new Option(window.KartBlitzReplayScene.getTrack(id)?.name||`Track ${id}`,id));
  $('code').value=incoming||localStorage.getItem('official-trainer-code')||sessionStorage.getItem('official-trainer-code')||'';
  $('source').textContent=window.makeAIInput?.toString()||'The Current AI controller is not available in this build.';
  $('use-current').onclick=safe(async()=>{library.useCurrentAI();await render();message('Current AI selected. Saved RL models are retained.');});
  $('filter').onchange=()=>render();$('connect').onclick=safe(async()=>{await api('status');localStorage.setItem('official-trainer-code',$('code').value);connected=true;await sync();});
  $('watch').onclick=safe(async()=>{const id=$('job').value.trim();if(!/^[a-f0-9]{32}$/.test(id))throw Error('Enter the 32-character training job ID');library.rememberJob(id,$('url').value.replace(/\/$/,''));connected=true;await sync();});
  $('import').onchange=safe(async()=>{for(const file of $('import').files)await library.saveCandidate(JSON.parse(await file.text()),{kind:'imported',filename:file.name});await render();message('Candidate saved. Current driver selection has not changed.');});
  window.addEventListener('storage',e=>{if([library.CHANGE_KEY,library.DRIVER_KEY].includes(e.key))render().catch(e=>message(e.message));});
  window.addEventListener('official-model-installed',()=>render().catch(e=>message(e.message)));
  const jobId=params.get('jobId');if(jobId)library.rememberJob(jobId,$('url').value.replace(/\/$/,''));
  await render();if($('code').value){connected=true;sync();}
}
async function sync(){
  clearTimeout(timer);if(busy)return;busy=true;
  let captured=0,active=0,unavailable=0;
  try{
    const url=$('url').value.replace(/\/$/,'');
    // New trainers expose saved runs across restarts. Older running trainers
    // still support watching remembered job IDs without being interrupted.
    let catalog=null;try{catalog=await api('models');}catch(error){if(!/Not found/i.test(error.message))throw error;}
    if(catalog){const existing=new Set((await library.listCandidates()).map(r=>r.source.catalogId));for(const entry of catalog.models){if(existing.has(entry.id))continue;const response=await api(`models/${entry.jobId}/${entry.trackId}`);await library.saveCandidate(response.package,{kind:'saved-training',jobId:entry.jobId,catalogId:response.id});captured++;}}
    for(const job of library.knownJobs().filter(j=>j.url===url)){
      try{const state=await api(`jobs/${encodeURIComponent(job.id)}`);if(['queued','running','paused','stopping'].includes(state.status))active++;
        const signature=JSON.stringify(state.packages||[]),key=url+'/'+job.id;
        if(['complete','cancelled'].includes(state.status)&&checkedJobs.get(key)!==signature){captured+=(await library.captureFinishedJob({...state,id:job.id},track=>api(`jobs/${job.id}/model?trackId=${track}`))).length;checkedJobs.set(key,signature);}}
      catch(error){if(!/Training job not found/i.test(error.message))throw error;unavailable++;}
    }
    $('sync').textContent=`Connected · ${active} active watched runs · ${captured} saved packages checked.${unavailable?' Older run status is unavailable; saved model files remain on disk.':''} New files stay inactive until you select them.`;
    await render();
  }catch(error){message(error.message);}finally{busy=false;if(connected)timer=setTimeout(sync,5000);}
}
async function render(){
  await official.loadPackages();rows=await library.listCandidates();
  const current=localStorage.getItem(library.DRIVER_KEY)!=='trained';$('current').classList.toggle('am-active',current);
  $('active').textContent=current?'ACTIVE · Current AI is selected for AI Race and One Lap Shootout.':`TRAINED AI SELECTED · ${official.packages.size} installed track packages. Missing weights use Current AI.`;
  const parent=$('candidates');parent.replaceChildren();
  const filtered=rows.filter(r=>$('filter').value==='all'||r.package.trackId===Number($('filter').value));
  if(!filtered.length){const p=document.createElement('p');p.textContent='No candidates yet. Finish a training run or import a trained JSON file. Current AI is available now.';parent.append(p);return;}
  for(const row of filtered){
    const pack=row.package,track=window.KartBlitzReplayScene.getTrack(pack.trackId),check=library.compatibility(pack,track),installed=official.packages.get(pack.trackId);
    const isInstalled=installed&&await library.candidateId(installed)===row.id;
    const card=document.createElement('article');card.className='am-card'+(!current&&isInstalled?' am-active':'');card.dataset.candidate=row.id;
    const title=document.createElement('h2');title.textContent=pack.name;card.append(title);
    const status=document.createElement('span');status.className='am-tag';status.textContent=!current&&isInstalled?'ACTIVE FOR THIS TRACK':isInstalled?'INSTALLED · Current AI selected':'CANDIDATE · inactive';card.append(status);
    const info=document.createElement('p');info.textContent=`${track?.name||`Track ${pack.trackId}`} · ${Object.keys(pack.variants).join(', ')} · version ${row.id.slice(0,10)} · ${new Date(row.receivedAt).toLocaleString()}`;card.append(info);
    for(const [difficulty,model] of Object.entries(pack.variants)){const p=document.createElement('p');p.className='am-subtle';p.textContent=`${difficulty}: ${(model.training?.steps||0).toLocaleString()} training steps · evaluation ${model.evaluation?.cancelled?'incomplete (stopped)':model.evaluation?`${Math.round(model.evaluation.finishRate*100)}% completed · median ${model.evaluation.medianLapTime?.toFixed(2)||'—'} s`:'not provided'}`;card.append(p);}
    const compat=document.createElement('p');compat.textContent=check.reason;card.append(compat);
    const buttons=document.createElement('div');buttons.className='am-row';
    const use=document.createElement('button');use.textContent='Use this model';use.disabled=!check.ok||(!current&&isInstalled);use.onclick=safe(async()=>{await library.activateCandidate(row.id,track);await render();message('Model selected for its track. Start a new AI Race or One Lap Shootout with one of its trained difficulties.');});
    const get=document.createElement('button');get.textContent='Download candidate';get.onclick=()=>download(pack);buttons.append(use,get);card.append(buttons);parent.append(card);
  }
}
