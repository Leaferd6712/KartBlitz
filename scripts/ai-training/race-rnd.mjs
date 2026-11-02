import {spawnSync} from 'node:child_process';
import {buildOfficialCore} from '../build-official-core.mjs';
buildOfficialCore({checkOnly:true});
const python=process.platform==='win32'?'.venv-official/Scripts/python.exe':'.venv-official/bin/python';
const result=spawnSync(python,['-m','ml_training.race_rnd',...process.argv.slice(2)],{stdio:'inherit'});
if(result.error)throw result.error;process.exit(result.status??1);
