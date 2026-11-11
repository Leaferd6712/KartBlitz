import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from gymnasium import spaces
from .specialist_quality import cases,quality,wilson_lower,matched_performance
from .trajectory_archive import TrajectorySpool,write_record,read_group
from .specialist_training import BalancedExamples,configuration
from .independent_ppo import IndependentPPO
from .official_train import save_checkpoint

def good(case):return {**case,'finished':True,'validLap':True,'offTrackRate':0,'contacts':0,'raceTime':30*case['raceLaps'],'racePosition':1}

class Contracts(unittest.TestCase):
    def test_wilson_not_raw_percentage(self):
        self.assertLess(wilson_lower(492,500),.97);self.assertGreaterEqual(wilson_lower(493,500),.97)
        sample=cases('shootout',500,'final');rows=list(map(good,sample));self.assertTrue(quality(rows,'shootout',500,True)['passed'])
        self.assertFalse(quality(rows[:-1],'shootout',500,True)['passed'])
        rows[0]['raceTime']=float('nan');self.assertFalse(quality(rows,'shootout',1)['passed'])
    def test_disjoint_seed_banks_and_race_conditions(self):
        banks=[cases('race',500,bank) for bank in ['training','selection','final']]
        for i,a in enumerate(banks):
            for b in banks[i+1:]:self.assertFalse({r['seed'] for r in a}&{r['seed'] for r in b})
        self.assertEqual({r['raceLaps'] for r in banks[2]},{1,2,3,5,8,10});self.assertEqual({r['energy'] for r in banks[2]},{.25,.5,1.})
    def test_failed_candidate_cannot_win_by_ignoring_a_case(self):
        rows=list(map(good,cases('shootout',3,'selection')));candidate=copy.deepcopy(rows);candidate[0]['finished']=False
        self.assertFalse(matched_performance(candidate,rows,'shootout'))
        candidate=copy.deepcopy(rows);candidate[0]['seed']+=1;self.assertFalse(matched_performance(candidate,rows,'shootout'))
    def test_disk_chunks_reconstruct_without_duplicate_points(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);spool=TrajectorySpool(root);points=[{'t':i/20,'x':i,'y':2,'a':0,'ersCharge':1-i/5000,'drsActive':i%2==0} for i in range(1001)]
            for start in range(0,len(points),100):spool.add((0,1),points[start:start+100])
            trajectory=spool.finish((0,1));self.assertEqual(len(trajectory),1001);self.assertEqual(list(trajectory),points)
            for attempt in range(2):write_record(root/'attempts.jsonl.gz',{'attempt':attempt+1,'trackId':5,'finished':True,'raceTime':50},trajectory)
            with gzip.open(root/'attempts.jsonl.gz','rt',encoding='utf-8') as source:rows=[json.loads(s) for s in source]
            self.assertEqual(rows[0]['points'],points);self.assertEqual(len(rows),2)
            replay=read_group([root/'attempts.jsonl.gz'],'final',5,1000);self.assertEqual(len(replay),2);self.assertLessEqual(len(replay[0]['points']),241);self.assertEqual(replay[0]['points'][-1],points[-1]);spool.close()
    def test_balanced_braking_examples_and_finite_controls(self):
        data=BalancedExamples(per_group=100)
        for _ in range(1000):data.add(np.zeros(57),[0,1,-1,-1])
        data.add(np.zeros(57),[.5,-1,1,-1]);data.add(np.zeros(57),[.5,1,-1,-1]);_,actions=data.arrays()
        self.assertEqual(sum(actions[:,2]>.5),100);self.assertEqual(sum(abs(actions[:,0])<.1),100)
    def test_independent_rng_and_checkpoint_round_trip(self):
        from stable_baselines3.common.vec_env import DummyVecEnv
        import gymnasium as gym
        class Tiny(gym.Env):
            observation_space=spaces.Box(-1,1,(57,),dtype=np.float32);action_space=spaces.Box(-1,1,(4,),dtype=np.float32)
            def reset(self,seed=None,options=None):return np.zeros(57,dtype=np.float32),{}
            def step(self,action):return np.zeros(57,dtype=np.float32),float(action[0]),False,False,{}
        def build():return IndependentPPO('MlpPolicy',DummyVecEnv([Tiny]),seed=123,device='cpu',n_steps=16,batch_size=16,policy_kwargs={'net_arch':dict(pi=[128,128],vf=[128,128])})
        a=build();b=build();x=torch.zeros((1,57))
        with torch.no_grad():
            first=a.policy(x)[0];torch.manual_seed(987);bfirst=b.policy(x)[0];self.assertTrue(torch.equal(first,bfirst))
            with tempfile.TemporaryDirectory() as tmp:
                path=Path(tmp)/'last.zip';save_checkpoint(a,path);loaded=IndependentPPO.load(path,device='cpu');expected=a.policy(x)[0];actual=loaded.policy(x)[0];self.assertTrue(torch.equal(expected,actual))
        a.learn(32);self.assertEqual(a.num_timesteps,32)

if __name__=='__main__':unittest.main()
