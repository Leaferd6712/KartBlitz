/** Candidate storage is deliberately separate from the game's installed policies. */
import * as official from './official-policy.mjs';
export const DRIVER_KEY='kartblitz_official_driver';
export const CHANGE_KEY='kartblitz_ai_library_changed';
const JOBS_KEY='kartblitz_ai_library_jobs';
function database(){return new Promise((resolve,reject)=>{const r=indexedDB.open('kartblitz-ai-library',1);r.onupgradeneeded=()=>r.result.createObjectStore('candidates',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function transaction(mode,fn){const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('candidates',mode),r=fn(tx.objectStore('candidates'));tx.oncomplete=()=>resolve(r?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Model library write failed'));});}finally{db.close();}}
function notify(){localStorage.setItem(CHANGE_KEY,`${Date.now()}-${Math.random()}`);window.dispatchEvent(new Event('official-model-installed'));}
export async function candidateId(pack){const bytes=new TextEncoder().encode(JSON.stringify(pack));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export function compatibility(pack,track){try{official.validatePackage(pack);if(track&&official.trackFingerprint(track)!==pack.trackFingerprint)throw Error('Track layout differs');return {ok:true,reason:'Compatible with this game'};}catch(error){return {ok:false,reason:error.message};}}
export async function saveCandidate(pack,source={}){
  if(typeof pack?.physicsHash!=='string')throw Error('Missing physics version');
  // Retain older physics versions as archives, while checking the JSON contract.
  official.validatePackage({...pack,physicsHash:official.PHYSICS_HASH});
  const id=await candidateId(pack),existing=await transaction('readonly',store=>store.get(id));
  if(existing){if(source.catalogId&&existing.source.catalogId!==source.catalogId){existing.source={...existing.source,...source};await transaction('readwrite',store=>store.put(existing));}return existing;}
  const row={id,package:pack,source,receivedAt:Date.now()};await transaction('readwrite',store=>store.put(row));notify();return row;
}
export async function listCandidates(){return (await transaction('readonly',store=>store.getAll())).sort((a,b)=>(b.package.createdAt||b.receivedAt)-(a.package.createdAt||a.receivedAt)||b.receivedAt-a.receivedAt);}
export async function activateCandidate(id,track){
  const row=await transaction('readonly',store=>store.get(id));if(!row)throw Error('Candidate not found');
  const check=compatibility(row.package,track);if(!check.ok)throw Error(check.reason);
  await official.loadPackages();const previous=official.packages.get(row.package.trackId);
  if(previous)await saveCandidate(previous,{kind:'previously-installed'});
  await official.installPackage(row.package);
  localStorage.setItem(DRIVER_KEY,'trained');notify();return row;
}
export function useCurrentAI(){localStorage.setItem(DRIVER_KEY,'current');notify();}
export function knownJobs(){try{return JSON.parse(localStorage.getItem(JOBS_KEY)||'[]');}catch{return [];}}
export function rememberJob(id,url){if(!id)return;const jobs=knownJobs().filter(j=>j.id!==id||j.url!==url);jobs.unshift({id,url});localStorage.setItem(JOBS_KEY,JSON.stringify(jobs.slice(0,100)));}
export async function captureFinishedJob(job,fetchModel){
  if(!['complete','cancelled'].includes(job.status))return [];
  const rows=[];for(const descriptor of job.packages||[]){const pack=await fetchModel(descriptor.trackId);rows.push(await saveCandidate(pack,{kind:job.status==='complete'?'completed-training':'stopped-training',jobId:job.id}));}return rows;
}
