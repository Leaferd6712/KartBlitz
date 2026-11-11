/** Browser dispatcher; does not replace the running V1 trainer's imports. */
import * as v1 from './official-policy.mjs';
import * as v2 from './official-policy-v2.mjs';
import * as v3 from './official-policy-v3.mjs';
export * from './official-policy.mjs';
export const generation=pack=>pack?.format==='kartblitz-official-track-v3'?3:pack?.format==='kartblitz-official-track-v2'?2:1;
export function displayName(pack){const version='V'+generation(pack),name=pack.name||'Track model';return new RegExp('\\b'+version+'\\b').test(name)?name:`${version} · ${name}`;}
export function validatePackage(pack){return generation(pack)===3?v3.validatePackage(pack):generation(pack)===2?v2.validatePackage(pack):v1.validatePackage(pack);}
export function makeController(track,pack,difficulty,context){return generation(pack)===3?v3.makeController(track,pack,difficulty,context):generation(pack)===2?v2.makeController(track,pack,difficulty,context):v1.makeController(track,pack,difficulty,context);}
function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open('kartblitz-official-models',1);request.onupgradeneeded=()=>request.result.createObjectStore('tracks',{keyPath:'trackId'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export async function loadPackages(){
  if(typeof indexedDB==='undefined')return;
  const db=await database();try{const rows=await new Promise((resolve,reject)=>{const r=db.transaction('tracks').objectStore('tracks').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});for(const pack of rows){try{validatePackage(pack);v1.packages.set(pack.trackId,pack);}catch{}}}finally{db.close();}
}
export async function installPackage(pack){
  validatePackage(pack);const db=await database();try{await new Promise((resolve,reject)=>{const tx=db.transaction('tracks','readwrite');tx.objectStore('tracks').put(pack);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});v1.packages.set(pack.trackId,pack);}finally{db.close();}
}
export async function attach(){
  if(typeof window==='undefined')return;
  // A plain facade leaves V1 module exports immutable and its package IDs intact.
  window.KartBlitzOfficial={...v1,validatePackage,makeController,loadPackages,installPackage,displayName,generation};
  await loadPackages();
  if(!window.KartBlitzNativeTraining&&!new URLSearchParams(location.search).has('nativeTraining')){
    await syncApprovedModels();
    if(!window.KartBlitzApprovedModelTimer)window.KartBlitzApprovedModelTimer=setInterval(()=>syncApprovedModels().catch(console.warn),30000);
  }
}

let syncing=false;
export async function syncApprovedModels(){
  if(syncing||localStorage.getItem('kartblitz_auto_models_disabled')==='1')return;
  syncing=true;
  try{
    const url=new URL('../ai-models/active.json',import.meta.url),response=await fetch(url,{cache:'no-store'});
    if(!response.ok)return;
    const manifest=await response.json();
    if(manifest.format!=='kartblitz-active-models-v1'||manifest.automatic!==true)return;
    const applied=JSON.parse(localStorage.getItem('kartblitz_auto_model_versions')||'{}');
    const disabled=JSON.parse(localStorage.getItem('kartblitz_auto_models_disabled_tracks')||'{}');
    for(const [id,entry] of Object.entries(manifest.tracks||{})){
      if(disabled[id]||applied[id]===entry.sha256)continue;
      if(!/^ai-models\/approved\/continuous\/track-[0-7]-[a-f0-9]{32}\.kartai\.json$/.test(entry.path)||!Number.isInteger(Number(id))||Number(id)<0||Number(id)>7)throw Error('Invalid approved model path');
      const file=await fetch(new URL('../'+entry.path,import.meta.url),{cache:'no-store'});if(!file.ok)throw Error('Approved weights unavailable');
      const bytes=await file.arrayBuffer(),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
      if(digest!==entry.sha256)throw Error('Approved model checksum differs');
      const pack=JSON.parse(new TextDecoder().decode(bytes));validatePackage(pack);if(pack.trackId!==Number(id))throw Error('Approved model track differs');
      const library=await import('./ai-model-library.mjs'),previous=v1.packages.get(Number(id));
      if(previous)await library.saveCandidate(previous,{kind:'automatic-promotion-backup'});
      const row=await library.saveCandidate(pack,{kind:'approved-continuous-campaign'});await installPackage(pack);
      const choices=library.trackChoices();for(let track=0;track<8;track++)if(!choices[track])choices[track]=localStorage.getItem(library.DRIVER_KEY)==='trained'&&v1.packages.has(track)?'installed':'legacy';choices[id]=row.id;
      localStorage.setItem(library.TRACK_CHOICES_KEY,JSON.stringify(choices));localStorage.setItem(library.DRIVER_KEY,'trained');
      applied[id]=entry.sha256;localStorage.setItem('kartblitz_auto_model_versions',JSON.stringify(applied));
      localStorage.setItem(library.CHANGE_KEY,`${Date.now()}-${Math.random()}`);window.dispatchEvent(new Event('official-model-installed'));
    }
  }finally{syncing=false;}
}
