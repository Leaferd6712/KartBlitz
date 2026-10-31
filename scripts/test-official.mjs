import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
const python=process.platform==='win32'?'.venv-official/Scripts/python.exe':'.venv-official/bin/python';
if(!existsSync(python))throw Error('Run official:install before the Python training tests.');
for(const [command,args] of [[process.execPath,['sim/__tests__/official-policy.test.mjs']],[python,['-m','unittest','ml_training.test_official','ml_training.test_ai_model_catalog']]]){
  const result=spawnSync(command,args,{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);
}
