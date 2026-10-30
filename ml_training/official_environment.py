"""SB3 vector interface to batched Node workers running the actual game Kart."""
from __future__ import annotations
import json
import os
import subprocess
from pathlib import Path
import numpy as np
from stable_baselines3.common.vec_env import VecEnv
from gymnasium import spaces

ROOT = Path(__file__).resolve().parents[1]

class NodeBatch:
    def __init__(self, count, config):
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        self.process = subprocess.Popen(['node', str(ROOT / 'ml_training/official-worker.mjs')], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=flags)
        self.count = count
        self.send({'command':'init', 'count':count, 'config':config})
        self.metadata = self.receive()
    def send(self, value):
        self.process.stdin.write(json.dumps(value, separators=(',',':'))+'\n'); self.process.stdin.flush()
    def receive(self):
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('Game simulator exited: '+self.process.stderr.read()[-3000:])
        result = json.loads(line)
        if not result.get('ok'): raise RuntimeError(result.get('error','Game simulator failed'))
        return result
    def call(self, value): self.send(value); return self.receive()
    def close(self):
        if self.process.poll() is None:
            try: self.call({'command':'close'}); self.process.wait(timeout=3)
            except Exception:
                self.process.kill();self.process.wait(timeout=3)
        for stream in [self.process.stdin,self.process.stdout,self.process.stderr]:
            if stream: stream.close()

class OfficialVecEnv(VecEnv):
    def __init__(self, config, on_episode=None):
        self.config = dict(config); self.on_episode = on_episode
        count = max(1,min(128,int(config.get('numEnvs',16))))
        workers = max(1,min(count,16,int(config.get('workers', min(4,os.cpu_count() or 1)))))
        self.batches=[]; self.attributes={}; self.closed=False
        try:
            for index in range(workers):
                size=count//workers+(index<count%workers)
                self.batches.append(NodeBatch(size,{**config,'seed':int(config.get('seed',1))+index*65537}))
        except Exception:
            self.close(); raise
        self.metadata=self.batches[0].metadata
        observation_count=len(self.metadata['observationNames'])
        self.physics_hash=self.metadata['physicsHash']
        if any(b.metadata['physicsHash']!=self.physics_hash for b in self.batches): raise RuntimeError('Simulator workers disagree on physics')
        self.last_infos=[]
        super().__init__(count,spaces.Box(-np.inf,np.inf,(observation_count,),np.float32),spaces.Box(-1,1,(5,),np.float32))
        self.metadata=self.batches[0].metadata
    def reset(self):
        for batch in self.batches: batch.send({'command':'reset'})
        return np.asarray([obs for b in self.batches for obs in b.receive()['observations']],dtype=np.float32)
    def fixed_reset(self, mode='ai', random_start=False):
        for batch in self.batches: batch.send({'command':'reset','options':{'fixed':True,'mode':mode,'randomStart':random_start}})
        return np.asarray([obs for b in self.batches for obs in b.receive()['observations']],dtype=np.float32)
    def step_async(self, actions):
        offset=0
        for batch in self.batches:
            batch.send({'command':'step','actions':np.asarray(actions[offset:offset+batch.count]).tolist()});offset+=batch.count
    def step_wait(self):
        rows=[row for batch in self.batches for row in batch.receive()['results']]
        infos=[]
        for row in rows:
            info=row['info']
            if row['done']: self.completed_trajectory=info.get('trajectory',[])
            if row['done'] and self.on_episode:
                self.on_episode(info)
            info.pop('trajectory',None)
            if 'terminal_observation' in info: info['terminal_observation']=np.asarray(info['terminal_observation'],dtype=np.float32)
            infos.append(info)
        self.last_infos=infos
        return np.asarray([r['observation'] for r in rows],dtype=np.float32),np.asarray([r['reward'] for r in rows],dtype=np.float32),np.asarray([r['done'] for r in rows],dtype=bool),infos
    def snapshot(self, batch=0):
        index=max(0,min(len(self.batches)-1,int(batch)))
        return {'batch':index,'batchCount':len(self.batches),**self.batches[index].call({'command':'snapshot'})}
    def teacher_actions(self):
        return np.asarray([a for b in self.batches for a in b.call({'command':'teacher'})['actions']],dtype=np.float32)
    def close(self):
        if getattr(self,'closed',False):return
        self.closed=True
        for batch in self.batches:batch.close()
    def get_attr(self, attr_name, indices=None):
        ids=self._get_indices(indices)
        if attr_name=='render_mode': return [None for _ in ids]
        return [self.attributes.get(attr_name) for _ in ids]
    def set_attr(self, attr_name, value, indices=None):self.attributes[attr_name]=value
    def env_method(self, method_name, *args, indices=None, **kwargs):raise NotImplementedError(method_name)
    def env_is_wrapped(self, wrapper_class, indices=None):return [False for _ in self._get_indices(indices)]
