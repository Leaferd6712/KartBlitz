"""Contract checks with real physics, real PPO updates and actual saved weights."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from stable_baselines3 import PPO
from .official_environment import OfficialVecEnv
from .official_train import train_official,TrainingControl,export_policy,read_replays

ROOT=Path(__file__).resolve().parents[1]

class OfficialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):subprocess.run(['node','scripts/build-official-core.mjs'],cwd=ROOT,check=True,capture_output=True)

    def test_parallel_environments_and_terminal_observation(self):
        env=OfficialVecEnv({'trackId':3,'numEnvs':4,'workers':2,'episodeSeconds':.09,'traffic':1})
        try:
            obs=env.reset();self.assertEqual(obs.shape,(4,48));self.assertTrue(np.isfinite(obs).all())
            env.step(np.tile([0,1,-1,-1,-1],(4,1)))
            obs,reward,done,info=env.step(np.tile([0,1,-1,-1,-1],(4,1)))
            self.assertTrue(done.all());self.assertTrue(all(i['TimeLimit.truncated'] for i in info))
            self.assertTrue(all(i['terminal_observation'].shape==(48,) for i in info));self.assertEqual(env.snapshot(1)['batch'],1)
            self.assertTrue(all(i['rewardComponents']['finish']==0 for i in info));self.assertTrue(np.isfinite(reward).all())
        finally:env.close()

    def test_five_variants_checkpoint_resume_and_javascript_actor(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as directory:
            config={'trackIds':[0],'allDifficulties':True,'totalSteps':256,'numEnvs':2,'workers':1,'horizon':16,'episodeSeconds':.2,'evaluationEpisodes':1,'device':'cpu'}
            result=train_official(config,lambda _:None,TrainingControl(),directory)
            self.assertEqual(result['status'],'complete');self.assertEqual(len(result['packages'][0]['variants']),5)
            package=json.loads((Path(directory)/'track-0.kartai.json').read_text())
            checkpoint=Path(directory)/'track-0/extreme/last.zip';model=PPO.load(checkpoint,device='cpu')
            observations=np.random.default_rng(12).normal(size=(7,48)).astype(np.float32)
            expected,_=model.predict(observations,deterministic=True)
            policy=export_policy(model)
            script="import {forward} from './sim/official-policy.mjs';let s='';for await(const c of process.stdin)s+=c;const v=JSON.parse(s);console.log(JSON.stringify(v.obs.map(o=>forward(v.policy,o))));"
            js=subprocess.run(['node','--input-type=module','-e',script],cwd=ROOT,input=json.dumps({'policy':policy,'obs':observations.tolist()}),capture_output=True,text=True,check=True)
            np.testing.assert_allclose(expected,json.loads(js.stdout),rtol=1e-5,atol=1e-6)
            control=TrainingControl();attempts=read_replays(directory,control,'early',0);self.assertTrue(attempts)
            import gzip
            with gzip.open(Path(directory)/'attempts.jsonl.gz','rt',encoding='utf-8') as source:raw=json.loads(source.readline())
            point=raw['points'][-1];self.assertTrue(all(k in point for k in ['position','action','reward','speed','contacts','progress']))
            self.assertTrue((Path(directory)/'attempt-index.jsonl').exists())
            resumed=train_official({**config,'allDifficulties':False,'totalSteps':128,'resumeRun':directory},lambda _:None,TrainingControl(),Path(directory)/'resumed')
            self.assertEqual(resumed['status'],'complete')
            self.assertEqual(package['humanLevelClaimed'],False)

    def test_pause_and_stop_control(self):
        control=TrainingControl();control.running.clear();control.cancelled.set();self.assertFalse(control.check())
        control.running.set();self.assertFalse(control.check())

if __name__=='__main__':unittest.main()
