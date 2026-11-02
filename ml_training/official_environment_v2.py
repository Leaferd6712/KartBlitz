"""Opt-in V2 vector environment; V1 imports and active workers are untouched."""
import os
import subprocess
import numpy as np
from gymnasium import spaces
from stable_baselines3.common.vec_env import VecEnv
from .official_environment import OfficialVecEnv,NodeBatch,ROOT

class EnergyBatch(NodeBatch):
    def __init__(self,count,config):
        flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
        self.process=subprocess.Popen(['node',str(ROOT/'ml_training/official-worker-v2.mjs')],cwd=ROOT,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=flags)
        self.count=count
        try:
            self.send({'command':'init','count':count,'config':config});self.metadata=self.receive()
        except Exception:
            self.close();raise

class EnergyVecEnv(OfficialVecEnv):
    def __init__(self,config,on_episode=None):
        self.config=dict(config);self.on_episode=on_episode;self.batches=[];self.attributes={};self.closed=False
        count=max(1,min(128,int(config.get('numEnvs',16))))
        workers=max(1,min(count,16,max(1,(os.cpu_count() or 4)-2),int(config.get('workers',4))))
        try:
            for index in range(workers):
                size=count//workers+(index<count%workers)
                self.batches.append(EnergyBatch(size,{**config,'seed':int(config.get('seed',42))+index*65537}))
            metadata=self.batches[0].metadata;self.physics_hash=metadata['physicsHash']
            if any(b.metadata['physicsHash']!=self.physics_hash or b.metadata['actionCount']!=4 or b.metadata['observationNames']!=metadata['observationNames'] for b in self.batches):raise RuntimeError('V2 workers disagree on contract')
            self.last_infos=[]
            VecEnv.__init__(self,count,spaces.Box(-np.inf,np.inf,(len(metadata['observationNames']),),np.float32),spaces.Box(-1,1,(4,),np.float32))
            self.metadata=metadata
        except Exception:
            self.close();raise
