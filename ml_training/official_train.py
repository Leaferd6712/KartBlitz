"""Per-track PPO training, evaluation, resumable checkpoints and measured replay capture."""
from __future__ import annotations
import gzip
import io
import json
import math
import os
import statistics
import subprocess
import threading
import time
import uuid
import zipfile
from pathlib import Path
from collections import deque
from .official_performance import learning_parameters,benchmark_choice,PhaseTimer,HardwareSampler

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
            for episode in range(max(1,min(20,int(count)))):
                if not control.check():return {'cancelled':True,'finishRate':0,'meanProgress':0,'medianLapTime':None,'offTrackRate':1,'episodes':rows},paths
                obs=env.fixed_reset(mode)
                while True:
                    # Evaluation can last a whole lap. Honour pause/stop at each
                    # decision, rather than making cancellation wait for a finish.
                    if not control.check():return {'cancelled':True,'finishRate':0,'meanProgress':0,'medianLapTime':None,'offTrackRate':1,'episodes':rows},paths
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
    # Before it can lap, a clean car that barely moves must not outrank one
    # learning to reach the later corners. Once it laps reliably, favour clean
    # racing and then pace. The underlying training penalties still apply.
    quality=(int(clean),-(metrics.get('medianLapTime') or math.inf)) if finished==1 else (metrics.get('meanProgress',0),int(clean))
    return (finished,*quality,-metrics.get('meanContacts',0),-metrics.get('offTrackRate',1))

def ppo_diagnostics(model):
    names=['approx_kl','clip_fraction','entropy_loss','explained_variance','value_loss','policy_gradient_loss','std','learning_rate']
    result={'step':model.num_timesteps,'updates':model._n_updates}
    for name in names:
        value=model.logger.name_to_value.get('train/'+name)
        if value is not None:result[name]=float(value) if math.isfinite(float(value)) else None
    return result

def new_driving_policy(torch,PPO,env,device,sizes,seed=42):
    model=PPO('MlpPolicy',env,device=device,learning_rate=3e-4,n_steps=sizes['horizon'],batch_size=sizes['batchSize'],n_epochs=sizes['epochs'],
        gamma=.995,gae_lambda=.95,ent_coef=.008,policy_kwargs={'net_arch':{'pi':[128,128],'vf':[128,128]},'activation_fn':torch.nn.Tanh,'log_std_init':-.5},seed=seed,verbose=0)
    # Neutral Gaussian outputs mean half throttle AND half brake. This game's
    # brake engages reverse at rest. Bias only initialization; PPO still learns
    # every control, with no scripted steering or expert demonstrations.
    with torch.no_grad():
        model.policy.action_net.bias[1]=.5
        model.policy.action_net.bias[2]=-2.
    return model

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
    total_budget=budget*len(track_ids);completed_total=0;packages=[];history=[];logs=[];last_performance=None;last_hardware=None
    replay_path=run_dir/'attempts.jsonl.gz'
    def emit(**fields):
        callback({'totalSteps':total_budget,'completedSteps':control.steps,'attempts':control.attempts,'device':device,'logs':logs[-20:],'history':history[-200:],**fields})
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
                record={'attempt':control.attempts,'trackAttempt':control.track_attempts[track_id],'trackId':track_id,'difficulty':difficulty,'environmentVersion':env.metadata.get('environmentVersion',1),'policyStep':control.steps+env.num_envs,'policyUpdate':control.update,
                    **{k:v for k,v in info.items() if k in ['mode','finished','validLap','lapTime','completedLapTime','progress','contacts','offTrackRate','offTrackSeconds']},'points':info.get('trajectory',[])}
                episode_rows.append({k:v for k,v in record.items() if k!='points'})
                if len(episode_rows)>100:episode_rows.pop(0)
                with control.lock:
                    offset=replay_path.stat().st_size if replay_path.exists() else 0
                    with gzip.open(replay_path,'at',encoding='utf-8') as out:out.write(json.dumps(record,separators=(',',':'))+'\n')
                    with (run_dir/'attempt-index.jsonl').open('a',encoding='utf-8') as index:
                        index.write(json.dumps({**{k:v for k,v in record.items() if k!='points'},'offset':offset,'bytes':replay_path.stat().st_size-offset})+'\n')
            emit(status='running',phase='starting-workers',trackId=track_id,difficulty=difficulty)
            env=OfficialVecEnv(env_config,on_episode)
            hardware=HardwareSampler().start()
            try:
                (stage_dir.parent/'track.json').write_text(json.dumps(env.metadata['tracks'][track_id]),encoding='utf-8')
                if config.get('demonstrations') and difficulty=='extreme':
                    config['demonstrationPairs']=env.batches[0].call({'command':'demonstrations','replays':config['demonstrations']})['pairs']
                if package is None:
                    package={'format':'kartblitz-official-track-v1','trackId':track_id,'name':env.metadata['tracks'][track_id]['name']+' Official AI',
                        'physicsHash':env.physics_hash,'trackFingerprint':env.metadata['tracks'][track_id]['fingerprint'],'observationVersion':1,'observationCount':len(env.metadata['observationNames']),'observationNames':env.metadata['observationNames'],
                        'decisionHz':20,'environmentVersion':env.metadata.get('environmentVersion',1),'startMode':env.metadata.get('startMode'),'variants':{},'createdAt':int(time.time()*1000),'humanLevelClaimed':False}
                if package['physicsHash']!=env.physics_hash:raise RuntimeError('Physics changed during training')
                sizes=learning_parameters(config,env.num_envs);horizon=sizes['horizon'];batch_size=sizes['batchSize']
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
                    # Resize rollout/minibatch settings for the current hardware.
                    model.n_steps=horizon;model.batch_size=batch_size;model.n_epochs=sizes['epochs']
                    model.rollout_buffer=model.rollout_buffer_class(horizon,model.observation_space,model.action_space,device=model.device,gamma=model.gamma,gae_lambda=model.gae_lambda,n_envs=env.num_envs,**model.rollout_buffer_kwargs)
                else:
                    emit(status='running',phase='initializing-policy',trackId=track_id,difficulty=difficulty)
                    model=new_driving_policy(torch,PPO,env,device,sizes,int(config.get('seed',42)))
                (stage_dir/'contract.json').write_text(json.dumps({'physicsHash':env.physics_hash,'environmentVersion':env.metadata.get('environmentVersion',1),'startMode':env.metadata.get('startMode'),'trackId':track_id,'difficulty':difficulty,'config':{k:v for k,v in config.items() if k not in ['demonstrations','demonstrationPairs']}},indent=2),encoding='utf-8')
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
                control.steps=initial_steps;control.update=model._n_updates
                last_checkpoint=stage_dir/'last.zip';best_checkpoint=stage_dir/'best.zip'
                best_metrics=None;best_score=None
                if resume:
                    previous_package=Path(config['resumeRun'])/f'track-{track_id}.kartai.json'
                    previous_best=resume.parent/'best.zip'
                    if previous_package.exists() and previous_best.exists():
                        # Old scores can come from solo traffic, different time
                        # limits or older reset/reward rules. Re-test the actual
                        # saved policy under this run's evaluation conditions.
                        baseline=PPO.load(previous_best,device=device)
                        emit(status='running',phase='evaluation',trackId=track_id,difficulty=difficulty)
                        metrics,paths=evaluate_policy(baseline,env_config,control,int(config.get('evaluationEpisodes',3)))
                        with (stage_dir/'evaluations.jsonl').open('a',encoding='utf-8') as out:out.write(json.dumps({'steps':0,'source':'resume-best-recheck','metrics':metrics,'paths':paths})+'\n')
                        if not metrics.get('cancelled'):
                            best_metrics=metrics;best_score=score(metrics)
                            save_checkpoint(baseline,best_checkpoint)
                        del baseline
                outer_emit=emit
                phase_timer=PhaseTimer()
                class Progress(BaseCallback):
                    def __init__(self):super().__init__();self.last=0;self.last_eval=0;self.logged_updates=model._n_updates
                    def record_update(self):
                        control.update=self.model._n_updates
                        if self.model._n_updates==self.logged_updates:return
                        self.logged_updates=self.model._n_updates
                        diagnostics=ppo_diagnostics(self.model)
                        with (stage_dir/'training-diagnostics.jsonl').open('a',encoding='utf-8') as out:out.write(json.dumps(diagnostics)+'\n')
                        outer_emit(diagnostics=diagnostics)
                    def _on_rollout_start(self):self.record_update();phase_timer.begin_rollout()
                    def _on_rollout_end(self):phase_timer.end_rollout()
                    def _on_training_end(self):self.record_update();phase_timer.finish()
                    def _on_step(self):
                        nonlocal best_metrics,best_score
                        control.steps=initial_steps+self.num_timesteps;control.update=self.model._n_updates
                        if not control.check():return False
                        now=time.monotonic()
                        if now-self.last>=.75:
                            self.last=now
                            avg=statistics.fmean(r['progress'] for r in episode_rows) if episode_rows else None
                            history.append({'step':control.steps,'trackId':track_id,'difficulty':difficulty,'progress':avg,'finishRate':statistics.fmean(r['finished'] for r in episode_rows) if episode_rows else None,
                                'medianLapTime':statistics.median([r['lapTime'] for r in episode_rows if r['finished']]) if any(r['finished'] for r in episode_rows) else None})
                            outer_emit(status='running',phase='learning',trackId=track_id,difficulty=difficulty,completedSteps=control.steps,
                                stageSteps=self.num_timesteps,stageBudget=stage_budget,preview=env.snapshot(control.batch),recentEpisodes=episode_rows[-10:],
                                performance=phase_timer.snapshot(self.num_timesteps),hardware=hardware.snapshot(device),trainingSettings={**sizes,'numEnvs':env.num_envs,'workers':len(env.batches)})
                        interval=max(horizon*env.num_envs,int(config.get('checkpointEvery',100000)))
                        if self.num_timesteps-self.last_eval>=interval:
                            self.last_eval=self.num_timesteps;save_checkpoint(self.model,last_checkpoint)
                            outer_emit(status='running',phase='evaluation',trackId=track_id,difficulty=difficulty,completedSteps=control.steps)
                            metrics,paths=evaluate_policy(self.model,env_config,control,int(config.get('evaluationEpisodes',3)))
                            with (stage_dir/'evaluations.jsonl').open('a',encoding='utf-8') as out:out.write(json.dumps({'steps':self.num_timesteps,'metrics':metrics,'paths':paths})+'\n')
                            if not metrics.get('cancelled') and (best_score is None or score(metrics)>best_score):
                                best_metrics=metrics;best_score=score(metrics);save_checkpoint(self.model,best_checkpoint)
                            if not metrics.get('cancelled'):outer_emit(status='running',phase='learning',evaluation=metrics)
                            if control.cancelled.is_set():return False
                        return True
                logs.append(f'Track {track_id} / {difficulty}: {env.num_envs} cars / {len(env.batches)} workers, {horizon} steps per car, {batch_size} samples per update minibatch. Same 128-unit browser actor.')
                emit(status='running',phase='learning',trackId=track_id,difficulty=difficulty,track=env.metadata['tracks'][track_id],physicsHash=env.physics_hash,preview=env.snapshot(control.batch))
                model.learn(total_timesteps=stage_budget,callback=Progress(),reset_num_timesteps=True)
                last_performance=phase_timer.snapshot(model.num_timesteps);last_hardware=hardware.snapshot(device)
                save_checkpoint(model,last_checkpoint)
                completed_total+=model.num_timesteps
                metrics,paths=evaluate_policy(model,env_config,control,int(config.get('evaluationEpisodes',3)))
                with (stage_dir/'evaluations.jsonl').open('a',encoding='utf-8') as out:out.write(json.dumps({'steps':model.num_timesteps,'metrics':metrics,'paths':paths})+'\n')
                if not metrics.get('cancelled') and (best_score is None or score(metrics)>best_score):
                    best_metrics=metrics;best_score=score(metrics);save_checkpoint(model,best_checkpoint)
                # A stop before the first full evaluation still exports a
                # resumable candidate, explicitly marked as unevaluated.
                if best_metrics is None:best_metrics=metrics
                selected=PPO.load(best_checkpoint if best_checkpoint.exists() else last_checkpoint,device=device)
                package['variants'][difficulty]={'id':uuid.uuid4().hex,'policy':export_policy(selected),'evaluation':best_metrics,
                    'training':{'algorithm':'PPO','steps':model.num_timesteps,'warmStart':'resume' if resume else 'extreme' if base_checkpoint else 'none','initialization':'checkpoint' if resume or base_checkpoint else 'forward-driving-v1','device':device,'traffic':env_config['traffic'],**sizes,'numEnvs':env.num_envs,'workers':len(env.batches)}}
                file=run_dir/f'track-{track_id}.kartai.json';temporary=file.with_suffix('.tmp.json');temporary.write_text(json.dumps(package,separators=(',',':')),encoding='utf-8');os.replace(temporary,file)
                if difficulty=='extreme':base_checkpoint=best_checkpoint
                packages=[p for p in packages if p['trackId']!=track_id]+[{'trackId':track_id,'name':package['name'],'variants':list(package['variants']),'file':str(file),'evaluation':best_metrics}]
                emit(status='running',phase='checkpoint-saved',packages=packages,evaluation=best_metrics,completedSteps=completed_total)
            finally:hardware.close();env.close()
        if control.cancelled.is_set():break
    return {'status':'cancelled' if control.cancelled.is_set() else 'complete','phase':'finished','packages':packages,'completedSteps':completed_total,'totalSteps':total_budget,'attempts':control.attempts,'device':device,'logs':logs[-20:],'history':history[-200:],'performance':last_performance,'hardware':last_hardware}

def benchmark_official(config,callback,control):
    torch,PPO,BaseCallback,OfficialVecEnv=_dependencies()
    torch.set_num_threads(2);results=[];hardware=HardwareSampler().start()
    profiles=[(16,4,256),(64,8,1024),(128,8,2048)]
    devices=['cpu']+(['cuda'] if torch.cuda.is_available() else [])
    target=max(2048,min(65536,int(config.get('benchmarkSteps',8192))))
    total_budget=sum(max(target,cars*128) for cars,_,_ in profiles)*len(devices);completed=0
    try:
        for cars,workers,batch in profiles:
            for device in devices:
                if not control.check():break
                cfg={**config,'trackId':0,'mode':'mixed','numEnvs':cars,'workers':workers,'horizon':128,'batchSize':batch,'episodeSeconds':10}
                sizes=learning_parameters(cfg,cars)
                callback({'status':'running','phase':'benchmark-initializing','device':device,'completedSteps':completed,'totalSteps':total_budget,'benchmarkProfile':{'numEnvs':cars,'workers':workers,**sizes}})
                env=OfficialVecEnv(cfg)
                try:
                    model=new_driving_policy(torch,PPO,env,device,sizes)
                    class Preview(BaseCallback):
                        def __init__(self,measured,timer=None):super().__init__();self.measured=measured;self.timer=timer;self.last=0
                        def _on_rollout_start(self):
                            if self.timer:self.timer.begin_rollout()
                        def _on_rollout_end(self):
                            if self.timer:self.timer.end_rollout()
                        def _on_training_end(self):
                            if self.timer:self.timer.finish()
                        def _on_step(self):
                            if not control.check():return False
                            now=time.monotonic()
                            if now-self.last>=.75:
                                self.last=now;callback({'status':'running','phase':'benchmark-measuring' if self.measured else 'benchmark-warmup',
                                    'device':device,'completedSteps':completed+(self.num_timesteps if self.measured else 0),'totalSteps':total_budget,
                                    'track':env.metadata['tracks'][0],'preview':env.snapshot(control.batch),'hardware':hardware.snapshot(device),
                                    'trainingSettings':{'numEnvs':cars,'workers':len(env.batches),**sizes},
                                    'performance':self.timer.snapshot(self.num_timesteps) if self.timer else None})
                            return True
                    # Exclude cold CUDA kernels and model construction from throughput.
                    model.learn(total_timesteps=cars*sizes['horizon'],callback=Preview(False))
                    if not control.check():break
                    if device=='cuda':torch.cuda.synchronize();torch.cuda.reset_peak_memory_stats()
                    start=time.monotonic();timer=PhaseTimer()
                    model.learn(total_timesteps=max(target,sizes['rolloutSize']),callback=Preview(True,timer))
                    if device=='cuda':torch.cuda.synchronize()
                    elapsed=time.monotonic()-start;completed+=model.num_timesteps
                    result={'device':device,'numEnvs':cars,'workers':len(env.batches),**sizes,'steps':model.num_timesteps,'seconds':elapsed,
                        'stepsPerSecond':model.num_timesteps/elapsed,'timing':timer.snapshot(model.num_timesteps),'hardware':hardware.summary(start,device)}
                    results.append(result)
                    callback({'benchmark':results,'completedSteps':completed,'hardware':result['hardware'],'performance':result['timing']})
                finally:
                    env.close()
                    if 'model' in locals():del model
                    if device=='cuda':torch.cuda.empty_cache()
            if control.cancelled.is_set():break
    finally:hardware.close()
    preference=config.get('device','auto')
    fastest=max(results,key=lambda r:r['stepsPerSecond']) if results else None
    recommendation=benchmark_choice(results,preference)
    report={'status':'cancelled' if control.cancelled.is_set() else 'complete','phase':'benchmark-finished','completedSteps':completed,'totalSteps':completed,
        'benchmark':results,'recommendedDevice':recommendation['device'] if recommendation else None,'recommendedConfig':recommendation,
        'fastestOverall':{k:fastest[k] for k in ['device','numEnvs','workers','batchSize','stepsPerSecond']} if fastest else None,'packages':[]}
    if not control.cancelled.is_set():
        directory=ROOT/'ml_training/runs/official';directory.mkdir(parents=True,exist_ok=True)
        (directory/'hardware-profile.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    return report

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
