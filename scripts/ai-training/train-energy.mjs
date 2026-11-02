import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
// Refuse before loading Torch as well. Unknown process permissions fail closed.
const statePath='ml_training/runs/campaign/current/state.json';
if(existsSync(statePath)){
  let state;try{state=JSON.parse(readFileSync(statePath,'utf8'));}catch{throw Error('Cannot verify campaign state; V2 was not started.');}
  if(state.managerPid&&!['finished','deadline-stopped','manager-failed'].includes(state.phase)){let alive=true;try{process.kill(state.managerPid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
    if(alive){console.error('V1 campaign is still running (or its process is inaccessible). V2 was not started.');process.exit(2);}}
}
const python=process.platform==='win32'?'.venv-official/Scripts/python.exe':'.venv-official/bin/python';
if(!existsSync(python))throw Error('Install the official trainer environment first.');
const result=spawnSync(python,['-m','ml_training.official_train_v2',...process.argv.slice(2)],{stdio:'inherit'});
if(result.error)throw result.error;process.exit(result.status??1);
