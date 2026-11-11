"""Small native smoke tests; the 500-case certification and soak remain real jobs."""
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
from .campaign import ROOT
from .official_environment_v2 import EnergyVecEnv
from .specialist_training import configuration,critic_warmup
from .specialist_campaign import compose,evaluate_driver,predict_package

class NativeTests(unittest.TestCase):
    def test_bounded_chunks_and_observation_action_alignment(self):
        cfg=configuration(5,'extreme','shootout',device='cpu');env=EnergyVecEnv(cfg)
        try:
            self.assertEqual(env.metadata['environmentVersion'],8);obs=env.fixed_reset('shootout',energy=.5,seed=12)
            initial=obs[0].copy()
            for _ in range(102):
                obs,_,done,info=env.step(np.asarray([[0,1,-1,-1]],dtype=np.float32))
                if done[0]:break
            snapshot=env.snapshot();self.assertLessEqual(len(snapshot['environments'][0]['path']),500)
            spool=env.batches[0].spool;files=list(spool.directory.glob('*.jsonl'));self.assertTrue(files)
            points=[json.loads(line) for p in files for line in p.read_text(encoding='utf-8').splitlines()]
            acted=next(p for p in points if p.get('rawAction') is not None);np.testing.assert_allclose(acted['observation'],initial,atol=1e-5);self.assertEqual(acted['rawAction'],[0,1,-1,-1])
        finally:env.close()
    def test_deployed_specialists_and_critic_freeze(self):
        source=json.loads((ROOT/'ml_training/runs/pace-rnd/sunset-review/candidate.kartai.json').read_text(encoding='utf-8'));pack=compose(source,source,'extreme','V3 smoke')
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as tmp:
            for role,mode,laps in [('shootout','shootout',1),('race','ai',3)]:
                cfg=configuration(0,'extreme',role,device='cpu');rows=evaluate_driver(cfg,[dict(mode=mode,raceLaps=laps,energy=.5,scenario='solo',seed=81271)],Path(tmp)/role,pack=pack)
                self.assertTrue(rows[0]['finished']);self.assertEqual(len(rows[0]['lapTimes']),laps);self.assertEqual(rows[0]['offTrackRate'],0)
            cfg=configuration(0,'extreme','shootout',device='cpu');env=EnergyVecEnv(cfg)
            try:model=predict_package(ROOT/'ml_training/runs/pace-rnd/sunset-review/candidate.kartai.json','extreme',env.metadata,env,cfg)
            finally:env.close()
            result=critic_warmup(model,cfg,steps=32);self.assertTrue(result['actorUnchanged']);self.assertEqual(len(model.policy.optimizer.state),0)

if __name__=='__main__':unittest.main()
