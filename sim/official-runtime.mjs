/** Browser dispatcher; does not replace the running V1 trainer's imports. */
import * as v1 from './official-policy.mjs';
import * as v2 from './official-policy-v2.mjs';
export * from './official-policy.mjs';
export const generation=pack=>pack?.format==='kartblitz-official-track-v2'?2:1;
export function displayName(pack){const version='V'+generation(pack),name=pack.name||'Track model';return new RegExp('\\b'+version+'\\b').test(name)?name:`${version} · ${name}`;}
export function validatePackage(pack){return generation(pack)===2?v2.validatePackage(pack):v1.validatePackage(pack);}
export function makeController(track,pack,difficulty,context){return generation(pack)===2?v2.makeController(track,pack,difficulty,context):v1.makeController(track,pack,difficulty,context);}
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
}
