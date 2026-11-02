import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
const python = process.platform === 'win32' ? '.venv-official/Scripts/python.exe' : '.venv-official/bin/python';
if (!existsSync(python)) throw Error('Install the Official ML Python environment first.');
const result = spawnSync(python, ['-m', 'ml_training.policy_seed', ...process.argv.slice(2)], {stdio: 'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
