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
from .official_train import train_official,TrainingControl,export_policy,read_replays,evaluate_policy,score,new_driving_policy
from .official_performance import learning_parameters

ROOT=Path(__file__).resolve().parents[1]

class OfficialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):subprocess.run(['node','scripts/build-official-core.mjs'],cwd=ROOT,check=True,capture_output=True)

    def test_best_policy_rewards_learning_to_lap_before_cleanliness_tiebreaks(self):
        clean_stalled={'finishRate':0,'meanProgress':.03,'offTrackRate':0,'meanContacts':0}
        reaches_corners={'finishRate':0,'meanProgress':.85,'offTrackRate':.15,'meanContacts':2}
        self.assertGreater(score(reaches_corners),score(clean_stalled))
        finished={'finishRate':1,'medianLapTime':60,'offTrackRate':.005,'meanContacts':0}
        self.assertGreater(score(finished),score(reaches_corners))
        self.assertGreater(score({**finished,'medianLapTime':59}),score(finished))

    def test_new_policy_can_accelerate_forward_before_its_first_update(self):
        env=OfficialVecEnv({'trackId':0,'numEnvs':1,'workers':1,'randomization':False,'mode':'ai'})
        try:
            model=new_driving_policy(torch,PPO,env,'cpu',learning_parameters({'horizon':16},1))
            obs=env.reset()
            for _ in range(20):
                action,_=model.predict(obs,deterministic=True)
                obs,reward,done,info=env.step(action)
                self.assertFalse(done[0]);self.assertGreaterEqual(obs[0,0],0)
            self.assertGreater(obs[0,0]*500,20);self.assertGreater(info[0]['progress'],0)
            self.assertGreater(info[0]['rewardComponents']['progress'],0)
        finally:env.close()

    def test_parallel_environments_and_terminal_observation(self):
        env=OfficialVecEnv({'trackId':3,'numEnvs':4,'workers':2,'episodeSeconds':.09,'traffic':1})
        try:
            obs=env.reset();self.assertEqual(obs.shape,(4,48));self.assertTrue(np.isfinite(obs).all())
            env.step(np.tile([0,1,-1,-1,-1],(4,1)))
            obs,reward,done,info=env.step(np.tile([0,1,-1,-1,-1],(4,1)))
            self.assertTrue(done.all());self.assertTrue(all(i['TimeLimit.truncated'] for i in info))
            self.assertTrue(all(i['terminal_observation'].shape==(48,) for i in info));self.assertEqual(env.snapshot(1)['batch'],1)
            self.assertTrue(all(i['rewardComponents']['finish']==0 for i in info));self.assertTrue(np.isfinite(reward).all())
            with self.assertRaisesRegex(RuntimeError,'invalid actions'):env.step(np.full((4,5),np.nan))
            with self.assertRaisesRegex(RuntimeError,'invalid observations'):env._observations(np.full((4,48),np.inf))
        finally:env.close()

    def test_five_variants_checkpoint_resume_and_javascript_actor(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as directory:
            config={'trackIds':[0],'allDifficulties':True,'totalSteps':256,'numEnvs':2,'workers':1,'horizon':16,'episodeSeconds':.2,'evaluationEpisodes':1,'device':'cpu'}
            result=train_official(config,lambda _:None,TrainingControl(),directory)
            self.assertEqual(result['status'],'complete');self.assertEqual(len(result['packages'][0]['variants']),5)
            package=json.loads((Path(directory)/'track-0.kartai.json').read_text())
            self.assertEqual(package['environmentVersion'],3);self.assertEqual(package['startMode'],'start-finish-standing')
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
            track=json.loads((Path(directory)/'track-0/track.json').read_text())
            self.assertEqual(raw['environmentVersion'],3);self.assertEqual(raw['points'][0]['speed'],0)
            self.assertEqual(raw['points'][0]['x'],track['start']['x']);self.assertEqual(raw['points'][0]['y'],track['start']['y'])
            point=raw['points'][-1];self.assertTrue(all(k in point for k in ['position','action','reward','speed','contacts','progress']))
            self.assertTrue((Path(directory)/'attempt-index.jsonl').exists())
            diagnostics=[json.loads(line) for line in (Path(directory)/'track-0/extreme/training-diagnostics.jsonl').read_text().splitlines()]
            self.assertTrue(diagnostics);self.assertIn('approx_kl',diagnostics[-1]);self.assertGreater(diagnostics[-1]['updates'],0)
            # A stale perfect solo score must not survive a resume with traffic.
            package['variants']['extreme']['evaluation']={'finishRate':1,'medianLapTime':1,'offTrackRate':0,'meanContacts':0,'meanProgress':1}
            (Path(directory)/'track-0.kartai.json').write_text(json.dumps(package))
            resumed=train_official({**config,'allDifficulties':False,'traffic':1,'totalSteps':128,'numEnvs':4,'workers':2,'horizon':32,'batchSize':64,'resumeRun':directory},lambda _:None,TrainingControl(),Path(directory)/'resumed')
            self.assertEqual(resumed['status'],'complete')
            resized=PPO.load(Path(directory)/'resumed/track-0/extreme/last.zip',device='cpu')
            self.assertEqual(resized.n_envs,4);self.assertEqual(resized.n_steps,32);self.assertEqual(resized.batch_size,64)
            self.assertEqual(resized.rollout_buffer.buffer_size,32);self.assertEqual(resized.rollout_buffer.n_envs,4)
            self.assertEqual(resumed['performance']['phase'],'finished');self.assertGreater(resumed['performance']['stepsPerSecond'],0)
            self.assertEqual(resumed['packages'][0]['evaluation']['finishRate'],0)
            evaluations=[json.loads(line) for line in (Path(directory)/'resumed/track-0/extreme/evaluations.jsonl').read_text().splitlines()]
            self.assertEqual(evaluations[0]['source'],'resume-best-recheck')
            self.assertEqual(package['humanLevelClaimed'],False)

    def test_pause_and_stop_control(self):
        control=TrainingControl();control.running.clear();control.cancelled.set();self.assertFalse(control.check())
        control.running.set();self.assertFalse(control.check())

    def test_stopping_real_learning_saves_a_resumable_checkpoint(self):
        control=TrainingControl()
        steps=[]
        def update(status):
            if 'completedSteps' in status:steps.append(status['completedSteps'])
            if status.get('phase')=='learning' and status.get('completedSteps',0)>=32:
                control.cancelled.set();control.running.set()
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as directory:
            result=train_official({'trackIds':[0],'allDifficulties':False,'totalSteps':1000000,'numEnvs':2,'workers':1,'horizon':16,'episodeSeconds':.2,'evaluationEpisodes':1,'device':'cpu'},update,control,directory)
            self.assertEqual(result['status'],'cancelled');self.assertGreater(result['completedSteps'],0);self.assertLess(result['completedSteps'],1000000)
            checkpoint=Path(directory)/'track-0/extreme/last.zip';self.assertTrue(checkpoint.exists())
            model=PPO.load(checkpoint,device='cpu');self.assertGreater(model.num_timesteps,0)
            self.assertTrue((Path(directory)/'track-0.kartai.json').exists())
            self.assertTrue(result['packages'][0]['evaluation']['cancelled'])
            self.assertFalse((Path(directory)/'track-0/extreme/best.zip').exists())
            self.assertEqual(steps,sorted(steps),'Status updates must not reset the displayed step counter')

    def test_stop_during_evaluation_does_not_wait_for_a_whole_lap(self):
        control=TrainingControl()
        class Car:
            def __init__(self):self.decisions=0
            def predict(self,obs,deterministic=True):
                self.decisions+=1;control.cancelled.set()
                return np.tile([0,1,-1,-1,-1],(1,1)),None
        car=Car()
        metrics,paths=evaluate_policy(car,{'trackId':0,'episodeSeconds':400,'device':'cpu'},control)
        self.assertTrue(metrics['cancelled']);self.assertEqual(car.decisions,1);self.assertEqual(paths,[])

if __name__=='__main__':unittest.main()
