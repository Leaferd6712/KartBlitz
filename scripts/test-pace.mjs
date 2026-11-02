import {spawnSync} from 'node:child_process';
const python = process.platform === 'win32' ? '.venv-official/Scripts/python.exe' : '.venv-official/bin/python';
for (const [command, args] of [[process.execPath, ['sim/__tests__/pace-planner.test.mjs']], [process.execPath, ['sim/__tests__/policy-refinement.test.mjs']], [python, ['-m', 'unittest', 'ml_training.test_pace_distill', 'ml_training.test_policy_seed', 'ml_training.test_race_rehearsal']]]) {
  const result = spawnSync(command, args, {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
