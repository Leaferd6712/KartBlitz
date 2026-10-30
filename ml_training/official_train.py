"""Per-track PPO training, evaluation, resumable checkpoints and measured replay capture."""
from __future__ import annotations
import copy
import gzip
import io
import json
import math
import os
import statistics
import shutil
import subprocess
import threading
import time
import uuid
import zipfile
from pathlib import Path
from collections import deque

ROOT=Path(__file__).resolve().parents[1]
DIFFICULTIES=['extreme','hard','medium','easy','ultraeasy']

class TrainingControl:
    def __init__(self):
        self.running=threading.Event();self.running.set();self.cancelled=threading.Event()
        self.batch=0;self.attempts=0;self.track_attempts={};self.lock=threading.RLock();self.steps=0;self.update=0
    def check(self):
        while not self.running.wait(.2):
            if self.cancelled.is_set():return False
        return not self.cancelled.is_set()

def _dependencies():
    import torch
    from stable_baselines3 import PPO
    from stable_baselines3.common.callbacks import BaseCallback
    from .official_environment import OfficialVecEnv
    return torch,PPO,BaseCallback,OfficialVecEnv

def export_policy(model):
    import torch
    layers=[]
    for layer in [*model.policy.mlp_extractor.policy_net,model.policy.action_net]:
        if isinstance(layer,torch.nn.Linear):layers.append({'kernel':layer.weight.detach().cpu().tolist(),'bias':layer.bias.detach().cpu().tolist()})
    return {'activation':'tanh','output':'clipped-linear','layers':layers}

def evaluate_policy(model, config, control, count=3):
    from .official_environment import OfficialVecEnv
    env=OfficialVecEnv({**config,'numEnvs':1,'workers':1,'seed':int(config.get('seed',1))+900001,'randomization':False})
    rows=[];paths=[]
    try:
        for mode in ['ai','shootout']:
            for episode in range(count):
                if not control.check():return {'cancelled':True,'finishRate':0,'meanProgress':0,'medianLapTime':None,'offTrackRate':1,'episodes':rows},paths
                obs=env.fixed_reset(mode,episode>0)
                while True:
                    action,_=model.predict(obs,deterministic=True)
                    obs,_,done,infos=env.step(action)
                    if done[0]:
                        row={k:v for k,v in infos[0].items() if k in ['finished','lapTime','offTrackRate','contacts','progress','mode']};rows.append(row)
                        paths.append({'mode':mode,'episode':episode,'points':getattr(env,'completed_trajectory',[])})
                        break
        laps=[r['lapTime'] for r in rows if r['finished']]
        return {'finishRate':sum(r['finished'] for r in rows)/len(rows),'medianLapTime':statistics.median(laps) if laps else None,
            'meanProgress':statistics.fmean(r['progress'] for r in rows),'meanContacts':statistics.fmean(r['contacts'] for r in rows),'offTrackRate':statistics.fmean(r['offTrackRate'] for r in rows),'episodes':rows},paths
    finally:env.close()

def score(metrics):
    # Completion comes first. Once all test laps finish, compare lap time rather
    # than rewarding the tiny distance overshoot past the finish gate.
    finished=metrics.get('finishRate',0)
    clean=metrics.get('offTrackRate',1)<.01 and metrics.get('meanContacts',0)==0
    pace=-(metrics.get('medianLapTime') or math.inf) if finished==1 else metrics.get('meanProgress',0)
    return (finished,int(clean),pace,-metrics.get('meanContacts',0),-metrics.get('offTrackRate',1))

def save_checkpoint(model,path):
    # Torch 2.9 on Windows cannot reliably read its nested ZIP tensors through
    # Python ZipExtFile (SB3 2.9). Its supported legacy tensor container avoids
    # that seek bug while preserving SB3's weights_only=True load path.
    import torch
    temporary=path.with_name(path.stem+'.tmp.zip');raw=io.BytesIO();model.save(raw);raw.seek(0)
    with zipfile.ZipFile(raw) as source,zipfile.ZipFile(temporary,'w') as target:
        for name in source.namelist():
            value=source.read(name)
            if name.endswith('.pth'):
                tensors=torch.load(io.BytesIO(value),map_location='cpu',weights_only=True)
                buffer=io.BytesIO();torch.save(tensors,buffer,_use_new_zipfile_serialization=False);value=buffer.getvalue()
            target.writestr(name,value)
    os.replace(temporary,path)

def train_official(config, callback, control, run_dir):
    callback({'status':'running','phase':'loading-libraries'})
    os.environ.setdefault('OMP_NUM_THREADS',str(config.get('torchThreads',2)))
    os.environ.setdefault('MKL_NUM_THREADS',str(config.get('torchThreads',2)))
    torch,PPO,BaseCallback,OfficialVecEnv=_dependencies()
    callback({'status':'running','phase':'preparing-physics'})
    run_dir=Path(run_dir);run_dir.mkdir(parents=True,exist_ok=True)
    flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
    subprocess.run(['node','scripts/build-official-core.mjs'],cwd=ROOT,check=True,capture_output=True,creationflags=flags)
    device=config.get('device','auto')
    if device=='auto':device='cuda' if torch.cuda.is_available() else 'cpu'
    if device=='cuda' and not torch.cuda.is_available():raise RuntimeError('CUDA is unavailable. Run official-install.ps1, or select CPU for the benchmark.')
    torch.set_num_threads(max(1,min(8,int(config.get('torchThreads',2)))))
    track_ids=[int(t) for t in config.get('trackIds',[0])]
    if not track_ids or any(t not in range(8) for t in track_ids):raise ValueError('Choose KartBlitz tracks 0–7')
    variants=DIFFICULTIES if config.get('allDifficulties',True) else [config.get('difficulty','extreme')]
    if any(d not in DIFFICULTIES for d in variants):raise ValueError('Unknown difficulty')
    budget=max(128,min(100_000_000,int(config.get('totalSteps',1_000_000))))
    total_budget=budget*len(track_ids);completed_total=0;packages=[];history=[];logs=[]
    replay_path=run_dir/'attempts.jsonl.gz'
    def emit(**fields):
        callback({'totalSteps':total_budget,'completedSteps':completed_total,'attempts':control.attempts,'device':device,'logs':logs[-20:],'history':history[-200:],**fields})
    for track_id in track_ids:
        package=None;base_checkpoint=None
        for difficulty in variants:
            if not control.check():break
            stage_budget=budget if len(variants)==1 else round(budget*(.5 if difficulty=='extreme' else .125))
            stage_dir=run_dir/f'track-{track_id}'/difficulty;stage_dir.mkdir(parents=True,exist_ok=True)
            env_config={**config,'trackId':track_id,'difficulty':difficulty,'mode':'mixed','traffic':max(0,min(3,int(config.get('traffic',0))))}
            episode_rows=[]
            def on_episode(info):
                control.attempts+=1
                control.track_attempts[track_id]=control.track_attempts.get(track_id,0)+1
                record={'attempt':control.attempts,'trackAttempt':control.track_attempts[track_id],'trackId':track_id,'difficulty':difficulty,'policyStep':control.steps,'policyUpdate':control.update,
                    **{k:v for k,v in info.items() if k in ['mode','finished','lapTime','progress','contacts','offTrackRate']},'points':info.get('trajectory',[])}
                episode_rows.append({k:v for k,v in record.items() if k!='points'})
                if len(episode_rows)>100:episode_rows.pop(0)
                with control.lock:
                    offset=replay_path.stat().st_size if replay_path.exists() else 0
                    with gzip.open(replay_path,'at',encoding='utf-8') as out:out.write(json.dumps(record,separators=(',',':'))+'\n')
                    with (run_dir/'attempt-index.jsonl').open('a',encoding='utf-8') as index:
                        index.write(json.dumps({**{k:v for k,v in record.items() if k!='points'},'offset':offset,'bytes':replay_path.stat().st_size-offset})+'\n')
            emit(status='running',phase='starting-workers',trackId=track_id,difficulty=difficulty)
            env=OfficialVecEnv(env_config,on_episode)
            try:
                (stage_dir.parent/'track.json').write_text(json.dumps(env.metadata['tracks'][track_id]),encoding='utf-8')
                if config.get('demonstrations') and difficulty=='extreme':
                    config['demonstrationPairs']=env.batches[0].call({'command':'demonstrations','replays':config['demonstrations']})['pairs']
                if package is None:
                    package={'format':'kartblitz-official-track-v1','trackId':track_id,'name':env.metadata['tracks'][track_id]['name']+' Official AI',
                        'physicsHash':env.physics_hash,'trackFingerprint':env.metadata['tracks'][track_id]['fingerprint'],'observationVersion':1,'observationCount':len(env.metadata['observationNames']),'observationNames':env.metadata['observationNames'],
                        'decisionHz':20,'variants':{},'createdAt':int(time.time()*1000),'humanLevelClaimed':False}
                if package['physicsHash']!=env.physics_hash:raise RuntimeError('Physics changed during training')
                horizon=max(16,min(512,int(config.get('horizon',128))));batch_size=min(256,horizon*env.num_envs)
                resume=None
                if config.get('resumeRun'):
                    candidate=Path(config['resumeRun'])/f'track-{track_id}'/difficulty/'last.zip'
                    contract=candidate.parent/'contract.json'
                    if candidate.exists():
                        saved=json.loads(contract.read_text());
                        if saved['physicsHash']!=env.physics_hash:raise RuntimeError('Resume checkpoint uses different physics')
                        resume=candidate
                    elif difficulty=='extreme':raise ValueError('Resume checkpoint was not found for this track')
                if resume or (base_checkpoint and difficulty!='extreme'):
                    emit(status='running',phase='loading-checkpoint',trackId=track_id,difficulty=difficulty)
                    model=PPO.load(resume or base_checkpoint,env=env,device=device)
                else:
                    emit(status='running',phase='initializing-policy',trackId=track_id,difficulty=difficulty)
                    model=PPO('MlpPolicy',env,device=device,learning_rate=3e-4,n_steps=horizon,batch_size=batch_size,n_epochs=6,
                        gamma=.995,gae_lambda=.95,ent_coef=.008,policy_kwargs={'net_arch':{'pi':[128,128],'vf':[128,128]},'activation_fn':torch.nn.Tanh},seed=int(config.get('seed',42)),verbose=0)
                (stage_dir/'contract.json').write_text(json.dumps({'physicsHash':env.physics_hash,'trackId':track_id,'difficulty':difficulty,'config':{k:v for k,v in config.items() if k not in ['demonstrations','demonstrationPairs']}},indent=2),encoding='utf-8')
                # Optional imitation is a separate initialization objective, never mixed into PPO returns.
                pairs=config.get('demonstrationPairs',[])
                if pairs and not resume and difficulty=='extreme':
                    observations=torch.tensor([p['observation'] for p in pairs if p.get('trackId')==track_id],dtype=torch.float32,device=device)
                    actions=torch.tensor([p['action'] for p in pairs if p.get('trackId')==track_id],dtype=torch.float32,device=device)
                    if observations.numel():
                        for epoch in range(5):
                            for indices in torch.randperm(len(actions),device=device).split(256):
                                dist=model.policy.get_distribution(observations[indices]).distribution
                                loss=torch.nn.functional.mse_loss(dist.mean,actions[indices]);model.policy.optimizer.zero_grad();loss.backward();model.policy.optimizer.step()
                    logs.append(f'Imitation initialized from {len(actions)} same-track samples; PPO now learns independently.')
                initial_steps=completed_total
                last_checkpoint=stage_dir/'last.zip';best_checkpoint=stage_dir/'best.zip'
                best_metrics=None;best_score=None
                if resume:
                    previous_package=Path(config['resumeRun'])/f'track-{track_id}.kartai.json'
                    previous_best=resume.parent/'best.zip'
                    if previous_package.exists() and previous_best.exists():
                        previous=json.loads(previous_package.read_text(encoding='utf-8')).get('variants',{}).get(difficulty)
                        if previous:
                            best_metrics=previous['evaluation'];best_score=score(best_metrics)
                            if previous_best.resolve()!=best_checkpoint.resolve():shutil.copyfile(previous_best,best_checkpoint)
                outer_emit=emit
                class Progress(BaseCallback):
                    def __init__(self):super().__init__();self.last=0;self.last_eval=0
                    def _on_step(self):
                        nonlocal best_metrics,best_score
                        if not control.check():return False
                        control.steps=initial_steps+self.num_timesteps;control.update=self.model._n_updates
                        now=time.monotonic()
                        if now-self.last>=.75:
                            self.last=now
                            avg=statistics.fmean(r['progress'] for r in episode_rows) if episode_rows else None
                            history.append({'step':control.steps,'trackId':track_id,'difficulty':difficulty,'progress':avg,'finishRate':statistics.fmean(r['finished'] for r in episode_rows) if episode_rows else None,
                                'medianLapTime':statistics.median([r['lapTime'] for r in episode_rows if r['finished']]) if any(r['finished'] for r in episode_rows) else None})
                            outer_emit(status='running',phase='learning',trackId=track_id,difficulty=difficulty,completedSteps=control.steps,
                                stageSteps=self.num_timesteps,stageBudget=stage_budget,preview=env.snapshot(control.batch),recentEpisodes=episode_rows[-10:])
                        interval=max(horizon*env.num_envs,int(config.get('checkpointEvery',100000)))
                        if self.num_timesteps-self.last_eval>=interval:
                            self.last_eval=self.num_timesteps;save_checkpoint(self.model,last_checkpoint)
                            outer_emit(status='running',phase='evaluation',trackId=track_id,difficulty=difficulty,completedSteps=control.steps)
                            metrics,paths=evaluate_policy(self.model,env_config,control,int(config.get('evaluationEpisodes',3)))
                            with (stage_dir/'evaluations.jsonl').open('a',encoding='utf-8') as out:out.write(json.dumps({'steps':self.num_timesteps,'metrics':metrics,'paths':paths})+'\n')
                            if best_score is None or score(metrics)>best_score:
                                best_metrics=metrics;best_score=score(metrics);save_checkpoint(self.model,best_checkpoint)
                            outer_emit(status='running',phase='learning',evaluation=metrics)
                        return True
                logs.append(f'Track {track_id} / {difficulty}: PPO in the actual game physics, {env.num_envs} environments across {len(env.batches)} workers.')
                emit(status='running',phase='learning',trackId=track_id,difficulty=difficulty,track=env.metadata['tracks'][track_id],physicsHash=env.physics_hash,preview=env.snapshot(control.batch))
                model.learn(total_timesteps=stage_budget,callback=Progress(),reset_num_timesteps=True)
                save_checkpoint(model,last_checkpoint)
                completed_total+=model.num_timesteps
                metrics,paths=evaluate_policy(model,env_config,control,int(config.get('evaluationEpisodes',3)))
                with (stage_dir/'evaluations.jsonl').open('a',encoding='utf-8') as out:out.write(json.dumps({'steps':model.num_timesteps,'metrics':metrics,'paths':paths})+'\n')
                if best_score is None or score(metrics)>best_score:
                    best_metrics=metrics;best_score=score(metrics);save_checkpoint(model,best_checkpoint)
                selected=PPO.load(best_checkpoint,device=device)
                package['variants'][difficulty]={'id':uuid.uuid4().hex,'policy':export_policy(selected),'evaluation':best_metrics,
                    'training':{'algorithm':'PPO','steps':model.num_timesteps,'warmStart':'resume' if resume else 'extreme' if base_checkpoint else 'none','device':device,'traffic':env_config['traffic']}}
                file=run_dir/f'track-{track_id}.kartai.json';temporary=file.with_suffix('.tmp.json');temporary.write_text(json.dumps(package,separators=(',',':')),encoding='utf-8');os.replace(temporary,file)
                if difficulty=='extreme':base_checkpoint=best_checkpoint
                packages=[p for p in packages if p['trackId']!=track_id]+[{'trackId':track_id,'name':package['name'],'variants':list(package['variants']),'file':str(file),'evaluation':best_metrics}]
                emit(status='running',phase='checkpoint-saved',packages=packages,evaluation=best_metrics,completedSteps=completed_total)
            finally:env.close()
        if control.cancelled.is_set():break
    return {'status':'cancelled' if control.cancelled.is_set() else 'complete','phase':'finished','packages':packages,'completedSteps':completed_total,'totalSteps':total_budget,'attempts':control.attempts,'device':device,'logs':logs[-20:],'history':history[-200:]}

def benchmark_official(config,callback,control):
    torch,PPO,BaseCallback,OfficialVecEnv=_dependencies()
    torch.set_num_threads(2);results=[]
    for device in ['cpu','cuda']:
        if not control.check():break
        if device=='cuda' and not torch.cuda.is_available():continue
        env=OfficialVecEnv({**config,'trackId':0,'numEnvs':max(1,min(32,int(config.get('numEnvs',8)))),'episodeSeconds':10})
        try:
            model=PPO('MlpPolicy',env,device=device,n_steps=64,batch_size=64,n_epochs=3,policy_kwargs={'net_arch':{'pi':[128,128],'vf':[128,128]}},verbose=0)
            start=time.monotonic()
            class Preview(BaseCallback):
                def _on_step(self):
                    if not control.check():return False
                    if self.n_calls%20==0:callback({'status':'running','phase':'benchmark','device':device,'completedSteps':self.num_timesteps,'track':env.metadata['tracks'][0],'preview':env.snapshot(control.batch)})
                    return True
            model.learn(total_timesteps=2048,callback=Preview())
            if device=='cuda':torch.cuda.synchronize()
            elapsed=time.monotonic()-start
            results.append({'device':device,'steps':model.num_timesteps,'seconds':elapsed,'stepsPerSecond':model.num_timesteps/elapsed})
        finally:env.close()
    best=max(results,key=lambda r:r['stepsPerSecond'])['device'] if results else None
    return {'status':'cancelled' if control.cancelled.is_set() else 'complete','phase':'benchmark-finished','benchmark':results,'recommendedDevice':best,'packages':[]}

def read_replays(run_dir,control,cohort='early',track_id=None):
    path=Path(run_dir)/'attempts.jsonl.gz'
    if not path.exists():return []
    if cohort not in ['early','middle','final']:raise ValueError('Unknown replay cohort')
    records=deque(maxlen=1000)
    index=Path(run_dir)/'attempt-index.jsonl'
    def include(row):
        if track_id is not None and row['trackId']!=int(track_id):return False
        number=row.get('trackAttempt',row['attempt']) if track_id is not None else row['attempt']
        return (cohort=='final' or (cohort=='early' and number<=1000) or (cohort=='middle' and 3001<=number<=4000))
    with control.lock:
        # Snapshot only the small index. Immutable gzip members can then be
        # decoded without holding up collectors or loading an entire long run.
        entries=index.read_text(encoding='utf-8').splitlines() if index.exists() else None
    if entries is not None:
        selected=deque(maxlen=1000)
        for line in entries:
            entry=json.loads(line)
            if include(entry):selected.append(entry)
            if cohort!='final' and len(selected)==1000:break
        with path.open('rb') as source:
            for entry in selected:
                source.seek(entry['offset']);records.append(json.loads(gzip.decompress(source.read(entry['bytes']))))
    else:
        with control.lock,gzip.open(path,'rt',encoding='utf-8') as source:
            for line in source:
                row=json.loads(line)
                if include(row):records.append(row)
                if cohort!='final' and len(records)==1000:break
    for row in records:
        points=row['points'];stride=max(1,math.ceil(len(points)/240));sampled=points[::stride]
        if points and sampled[-1] is not points[-1]:sampled.append(points[-1])
        row['points']=[{k:p[k] for k in ['t','x','y','a','speed','offTrack'] if k in p} for p in sampled]
    return list(records)
