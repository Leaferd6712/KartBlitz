import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import numpy as np
import torch
from stable_baselines3 import PPO
from .official_environment import OfficialVecEnv
from .official_environment_v2 import EnergyVecEnv
from .official_train import export_policy,save_checkpoint,ROOT,TrainingControl
from .official_train_v2 import new_policy,warm_start,train_arm,result_rank,evaluation_cases,campaign_is_live,choose_result

class EnergyTests(unittest.TestCase):
    def test_guard_refuses_when_process_inspection_is_denied(self):
        import psutil
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as folder:
            state=Path(folder)/'ml_training/runs/campaign/current/state.json';state.parent.mkdir(parents=True)
            state.write_text(json.dumps({'managerPid':123,'managerCreated':1}))
            with patch('ml_training.official_train_v2.ROOT',Path(folder)),patch('psutil.Process',side_effect=psutil.AccessDenied(123)):
                self.assertTrue(campaign_is_live())
            with patch('ml_training.official_train_v2.ROOT',Path(folder)),patch('psutil.Process',side_effect=psutil.NoSuchProcess(123)):
                self.assertFalse(campaign_is_live())
            import os
            state.write_text(json.dumps({'managerPid':os.getpid(),'managerCreated':psutil.Process().create_time()}))
            result=subprocess.run(['node',str(ROOT/'scripts/train-energy.mjs'),'--track','0','--seconds','60'],cwd=folder,capture_output=True,text=True)
            self.assertEqual(result.returncode,2);self.assertIn('V2 was not started',result.stderr)
    def test_vector_contract_partial_archive_and_resets(self):
        rows=[];env=EnergyVecEnv({'trackId':0,'numEnvs':2,'workers':1,'raceLaps':3,'mode':'ai','episodeSeconds':.09},rows.append)
        try:
            self.assertEqual(env.reset().shape,(2,57));self.assertEqual(env.action_space.shape,(4,))
            obs,_,done,info=env.step(np.tile([0,1,-1,-1],(2,1)));self.assertFalse(done.any())
            env.archive_partials();self.assertEqual(len(rows),2);self.assertTrue(all(r['interrupted'] for r in rows))
            obs,_,done,info=env.step(np.tile([0,1,-1,-1],(2,1)));self.assertTrue(done.all());self.assertEqual(info[0]['terminal_observation'].shape,(57,))
            self.assertEqual(info[0]['raceLaps'],3);self.assertFalse(info[0]['finished'])
            self.assertIn('drsTransitions',info[0]);self.assertIn('energyDeployed',info[0])
            with self.assertRaisesRegex(RuntimeError,'invalid actions'):env.step(np.ones((2,5)))
        finally:env.close()

    def test_warm_start_preserves_four_controls_and_resets_optimiser(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as folder:
            env1=OfficialVecEnv({'trackId':0,'numEnvs':1,'workers':1,'episodeSeconds':.1})
            env2=EnergyVecEnv({'trackId':0,'numEnvs':1,'workers':1,'episodeSeconds':.1})
            try:
                old=PPO('MlpPolicy',env1,device='cpu',n_steps=16,batch_size=16,policy_kwargs={'net_arch':{'pi':[128,128],'vf':[128,128]},'activation_fn':torch.nn.Tanh},seed=42)
                old.learn(16);checkpoint=Path(folder)/'last.zip';save_checkpoint(old,checkpoint)
                (Path(folder)/'contract.json').write_text(json.dumps({'trackId':0,'physicsHash':env1.physics_hash}))
                new=new_policy(env2,{'gamma':.9995,'horizon':16});warm_start(new,checkpoint,0,env2.physics_hash)
                self.assertEqual(new.num_timesteps,0);self.assertEqual(len(new.policy.optimizer.state),0);self.assertEqual(new.gamma,.9995)
                data=np.random.default_rng(12).normal(size=(6,57)).astype(np.float32)
                expected,_=old.predict(data[:,:48],deterministic=True);actual,_=new.predict(data,deterministic=True)
                np.testing.assert_allclose(expected[:,:4],actual,rtol=1e-5,atol=1e-6)
                script="import {forward} from './sim/official-policy.mjs';let s='';for await(const c of process.stdin)s+=c;let v=JSON.parse(s);console.log(JSON.stringify(v.obs.map(o=>forward(v.policy,o))));"
                result=subprocess.run(['node','--input-type=module','-e',script],cwd=ROOT,input=json.dumps({'policy':export_policy(new),'obs':data.tolist()}),capture_output=True,text=True,check=True)
                np.testing.assert_allclose(actual,json.loads(result.stdout),rtol=1e-5,atol=1e-6)
                with self.assertRaisesRegex(ValueError,'mismatch'):warm_start(new,checkpoint,1,env2.physics_hash)
            finally:env1.close();env2.close()

    def test_real_cpu_update_archives_and_exports_versioned_candidate(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as folder:
            cfg={'trackId':0,'difficulty':'extreme','gamma':.9995,'horizon':16,'steps':32,'numEnvs':2,'workers':1,'device':'cpu','episodeSeconds':.12,'smokeEvaluation':True}
            pack,report=train_arm(cfg,Path(folder))
            self.assertEqual(pack['modelGeneration'],2);self.assertEqual(pack['actionCount'],4);self.assertEqual(pack['observationCount'],57)
            self.assertEqual(len(report['cases']),2);self.assertEqual(report['summary']['ai']['finishRate'],0)
            self.assertTrue((Path(folder)/'last.zip').exists());self.assertTrue((Path(folder)/'attempt-index.jsonl').exists())
            import gzip
            first=json.loads(next(gzip.open(Path(folder)/'attempts.jsonl.gz','rt')))
            self.assertEqual(first['raceLaps'],first['points'][-1]['raceLaps']);self.assertIn('ersPower',first['points'][-1])
            self.assertTrue(any('interrupted' in json.loads(line) for line in (Path(folder)/'attempt-index.jsonl').read_text().splitlines()))

    def test_case_schedule_matches_native_and_completion_beats_speed(self):
        result=subprocess.run(['node','--input-type=module','-e',"import {evaluationCases} from './sim/energy-evaluation.mjs';console.log(JSON.stringify(evaluationCases()));"],cwd=ROOT,capture_output=True,text=True,check=True)
        self.assertEqual(evaluation_cases(),json.loads(result.stdout))
        row={'finished':True,'contacts':0,'offTrackRate':0,'racePosition':1,'raceTime':50}
        self.assertGreater(result_rank({'cases':[row]}),result_rank({'cases':[{**row,'finished':False,'raceTime':1}]}))

    def test_time_budget_and_cancelled_evaluation_save_honest_results(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as folder:
            cfg={'trackId':0,'difficulty':'extreme','gamma':.995,'horizon':16,'seconds':.15,'numEnvs':2,'workers':1,'device':'cpu','episodeSeconds':.12,'smokeEvaluation':True}
            pack,report=train_arm(cfg,Path(folder)/'timed')
            status=json.loads((Path(folder)/'timed/status.json').read_text());self.assertGreater(status['steps'],0);self.assertGreaterEqual(status['elapsedSeconds'],.15)
            control=TrainingControl();control.cancelled.set()
            _,report=train_arm({**cfg,'seconds':None,'steps':32},Path(folder)/'cancelled',control)
            self.assertTrue(report['cancelled']);self.assertEqual(report['cases'],[])
            self.assertTrue((Path(folder)/'cancelled/last.zip').exists());self.assertTrue(json.loads((Path(folder)/'cancelled/evaluation/report.json').read_text())['cancelled'])

    def test_catalog_accepts_v2_without_activating_or_rewriting_it(self):
        from . import server
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as folder:
            job='d'*32;directory=Path(folder)/'ml_training/runs/official'/job;directory.mkdir(parents=True)
            pack={'format':'kartblitz-official-track-v2','modelGeneration':2,'trackId':0,'trackFingerprint':'test','name':'V2 candidate','variants':{'extreme':{}},'physicsHash':'test'}
            path=directory/'track-0.kartai.json';path.write_text(json.dumps(pack));before=path.read_bytes()
            with patch.object(server,'ROOT',Path(folder)),patch.object(server,'JOBS',{}),patch.object(server,'MODEL_CATALOG_CACHE',{}):
                self.assertEqual(server.saved_official_models()[0]['jobId'],job);self.assertEqual(server.saved_official_model(job,0)['package'],pack)
                self.assertEqual(path.read_bytes(),before);self.assertFalse(server.JOBS)

    def test_lap_time_wins_and_style_only_breaks_a_fifty_millisecond_tie(self):
        def item(seconds,style):return ({},{'cases':[{'finished':True,'offTrackRate':0,'contacts':0,'racePosition':1,'raceTime':seconds,'styleScore':style}]},Path('candidate'))
        fast=item(20,0);pretty=item(20.04,1);slow=item(20.2,1)
        self.assertIs(choose_result([fast,pretty]),pretty)
        self.assertIs(choose_result([fast,slow]),fast)

    def test_same_shape_v2_warm_start_uses_fresh_optimizer_and_preserves_weights(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as folder:
            env=EnergyVecEnv({'trackId':0,'numEnvs':1,'workers':1,'episodeSeconds':.12})
            try:
                source=new_policy(env,{'gamma':.995,'horizon':16});source.learn(16);checkpoint=Path(folder)/'last.zip';save_checkpoint(source,checkpoint)
                (Path(folder)/'contract.json').write_text(json.dumps({'trackId':0,'physicsHash':env.physics_hash}))
                target=new_policy(env,{'gamma':.9995,'horizon':16});warm_start(target,checkpoint,0,env.physics_hash)
                self.assertFalse(target.policy.optimizer.state);self.assertEqual(target.num_timesteps,0)
                for name,tensor in source.policy.state_dict().items():self.assertTrue(torch.equal(tensor,target.policy.state_dict()[name]),name)
            finally:env.close()

if __name__=='__main__':unittest.main()
