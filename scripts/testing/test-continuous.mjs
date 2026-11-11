import {spawnSync} from 'node:child_process';
const python=process.platform==='win32'?'.venv-official/Scripts/python.exe':'.venv-official/bin/python';
const result=spawnSync(python,['-m','unittest','ml_training.test_continuous_campaign'],{stdio:'inherit'});
if(result.error)throw result.error;process.exitCode=result.status??1;
