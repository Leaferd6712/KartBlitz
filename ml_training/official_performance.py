"""Real workload sizing and optional GPU telemetry; never reserves dummy memory."""
import os
import subprocess
import threading
import time
from collections import deque

DEFAULT_ENVS=128
DEFAULT_WORKERS=8
DEFAULT_HORIZON=128
DEFAULT_BATCH=2048

def learning_parameters(config,num_envs):
    horizon=max(16,min(512,int(config.get('horizon',DEFAULT_HORIZON))))
    rollout=horizon*num_envs
    requested=max(32,min(16384,int(config.get('batchSize',DEFAULT_BATCH))))
    batch=min(requested,rollout)
    # Equal minibatches avoid a small truncated tail on every PPO epoch.
    while batch>1 and rollout%batch:batch-=1
    if batch<2:batch=rollout
    return {'horizon':horizon,'batchSize':batch,'rolloutSize':rollout,'epochs':max(1,min(16,int(config.get('epochs',6))))}

def benchmark_choice(results,preference):
    eligible=[r for r in results if r['device']==preference]
    selected=max(eligible or results,key=lambda r:r['stepsPerSecond']) if results else None
    return {k:selected[k] for k in ['device','numEnvs','workers','horizon','batchSize','epochs']} if selected else None

class PhaseTimer:
    def __init__(self):self.started=time.monotonic();self.finished_at=None;self.phase=None;self.phase_start=self.started;self.collect=0.;self.update=0.
    def _end(self):
        elapsed=time.monotonic()-self.phase_start
        if self.phase=='collect':self.collect+=elapsed
        elif self.phase=='update':self.update+=elapsed
    def begin_rollout(self):self._end();self.phase='collect';self.phase_start=time.monotonic()
    def end_rollout(self):self._end();self.phase='update';self.phase_start=time.monotonic()
    def finish(self):self._end();self.phase=None;self.phase_start=time.monotonic();self.finished_at=self.phase_start
    def snapshot(self,steps):
        collect,update=self.collect,self.update
        elapsed=time.monotonic()-self.phase_start
        if self.phase=='collect':collect+=elapsed
        elif self.phase=='update':update+=elapsed
        return {'stepsPerSecond':steps/max(.001,(self.finished_at or time.monotonic())-self.started),'collectionSeconds':collect,'updateSeconds':update,
            'updateWallFraction':update/max(.001,collect+update),'phase':'finished' if self.finished_at else 'updating-weights' if self.phase=='update' else 'collecting-experience'}

class HardwareSampler:
    def __init__(self):self.latest={};self.samples=deque(maxlen=3600);self.stop_event=threading.Event();self.thread=None
    def start(self):
        self.thread=threading.Thread(target=self._run,daemon=True);self.thread.start();return self
    def _run(self):
        while not self.stop_event.is_set():
            try:
                flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
                command=['nvidia-smi','--id=0','--query-gpu=memory.total,memory.used,utilization.gpu','--format=csv,noheader,nounits']
                result=subprocess.run(command,capture_output=True,text=True,timeout=3,creationflags=flags)
                if result.returncode==0:
                    total,used,util=[float(v.strip()) for v in result.stdout.strip().splitlines()[0].split(',')]
                    sample={'sampleTime':time.monotonic(),'sampleAt':time.time(),'gpuMemoryTotalMiB':total,'gpuMemoryUsedMiB':used,'gpuUtilizationPercent':util}
                    self.latest=sample;self.samples.append(sample)
            except (OSError,ValueError,subprocess.SubprocessError):pass
            self.stop_event.wait(1)
    def snapshot(self,device='cpu'):
        row=dict(self.latest)
        if str(device).startswith('cuda'):
            import torch
            row.update(torchAllocatedMiB=torch.cuda.memory_allocated()/1048576,torchReservedMiB=torch.cuda.memory_reserved()/1048576,
                torchPeakAllocatedMiB=torch.cuda.max_memory_allocated()/1048576)
        return row
    def summary(self,since,device='cpu'):
        rows=[s for s in list(self.samples) if s['sampleTime']>=since]
        data=self.snapshot(device)
        if rows:data.update(meanGpuUtilizationPercent=sum(s['gpuUtilizationPercent'] for s in rows)/len(rows),peakGpuUtilizationPercent=max(s['gpuUtilizationPercent'] for s in rows),peakGpuMemoryUsedMiB=max(s['gpuMemoryUsedMiB'] for s in rows))
        return data
    def close(self):
        self.stop_event.set()
        if self.thread:self.thread.join(timeout=4)
