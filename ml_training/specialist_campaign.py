"""Resumable V3 pilot, followed by quality-gated specialist training. Local only."""
from __future__ import annotations
import argparse
import copy
import ctypes
import hashlib
import json
import os
import signal
import subprocess
import sys
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path
import psutil
from .campaign import ROOT,RUNS,TRACKS,read_json,write_json
from .campaign_resources import ResourceMonitor,admission,pressure
from .official_train import TrainingControl,save_checkpoint,export_policy
from .official_train_v2 import train_arm,new_policy,evaluate,evaluation_cases
from .specialist_training import REVISION,configuration,calibrate_teacher,collect_demonstrations,taught_seed,solo_selection,corrective_refresh,drive,driving_summary,package,rank
from .specialist_quality import quality,cases,clean,matched_performance
from .independent_ppo import IndependentPPO
from .official_environment_v2 import EnergyVecEnv

CURRENT=ROOT/'ml_training/runs/specialists-v3/current'
DIFFICULTIES=['extreme','hard','medium','easy','ultraeasy']
SOURCES=['index.html','sim/official-policy.mjs','sim/official-policy-v2.mjs','sim/official-policy-v3.mjs','sim/official-runtime.mjs','sim/native-training-environment.mjs','sim/pace-planner.mjs','sim/racing-line.mjs','sim/corner-monitor.mjs','sim/official-race-strategy.mjs','ml_training/native-worker-v2.mjs','ml_training/official_environment.py','ml_training/official_environment_v2.py','ml_training/official_train_v2.py','ml_training/specialist_training.py','ml_training/specialist_quality.py','ml_training/trajectory_archive.py','ml_training/specialist_campaign.py','ml_training/independent_ppo.py']
def fingerprint():return hashlib.sha256(b''.join((ROOT/p).read_bytes() for p in SOURCES)).hexdigest()
def alive(owner):
    try:
        p=psutil.Process(owner['pid']);return p.is_running() and abs(p.create_time()-owner['created'])<.1
    except (psutil.NoSuchProcess,KeyError):return False
    except psutil.AccessDenied:return True

def seed_path(track,difficulty):
    old=read_json(ROOT/'ml_training/runs/continuous-v2/current/state.json',{})
    if track==0 and difficulty=='extreme':
        path=ROOT/'ml_training/runs/pace-rnd/sunset-review/candidate.kartai.json'
        if path.exists():return path
    task=next((t for t in old.get('tasks',[]) if t['track']==track and t['difficulty']==difficulty),{})
    path=task.get('reference')
    return Path(path) if path and Path(path).exists() else None

def predict_package(path,difficulty,metadata,env,cfg):
    from .policy_seed import import_actor
    pack=read_json(path);model=new_policy(env,cfg,policy_class=IndependentPPO)
    import_actor(model,pack,metadata,difficulty);return model

def evaluate_driver(cfg,sample,directory,*,pack=None,legacy=False,control=None,progress=None):
    cfg={**cfg,'policyPackage':pack,'driver':'legacy' if legacy else 'learned','recordObservations':False,'lineGuidance':False}
    env=EnergyVecEnv(cfg);rows=[]
    class Zero:
        def predict(self,obs,deterministic=True):
            import numpy as np
            return np.zeros((len(obs),4),dtype=np.float32),None
    try:
        for case in sample:rows.append(driving_summary(drive(env,case,cfg,model=Zero(),archive=Path(directory)/'attempts.jsonl.gz',control=control,progress=progress)))
        write_json(Path(directory)/'report.json',{'cases':rows});return rows
    finally:env.close()

def certify(cfg,pack,directory,control=None,progress=None,round_id=0):
    """Final bank is never used for cloning or checkpoint selection."""
    directory=Path(directory);role=cfg['specialist'];sample=cases(role,500,'final',271+round_id*1000)
    rows=evaluate_driver(cfg,sample,directory/'held-out',pack=pack,control=control,progress=progress)
    result={'candidateSha256':hashlib.sha256(json.dumps(pack,sort_keys=True,allow_nan=False).encode()).hexdigest(),'medianSecondsPerLap':__import__('statistics').median(r['raceTime']/r['raceLaps'] for r in rows if clean(r,role)) if any(clean(r,role) for r in rows) else None,'quality':quality(rows,role,500,final=True),'conditions':'dry / stock / medium tyres','revision':REVISION}
    # Exactly the pre-existing 26 native scenarios, partitioned by specialist.
    targeted=[c for c in evaluation_cases() if c['mode']==('shootout' if role=='shootout' else 'ai')]
    regression=evaluate_driver(cfg,targeted,directory/'targeted',pack=pack,control=control,progress=progress)
    legacy=evaluate_driver(cfg,targeted,directory/'legacy',legacy=True,control=control,progress=progress)
    regression_ok=all(clean(r,role) for r in regression) and matched_performance(regression,legacy,role)
    regression_ok=regression_ok and all(r.get('scenario')!='recovery' or r.get('recoveryTime') is not None and r['recoveryTime']<=10 for r in regression)
    result.update(targetedCount=len(targeted),targetedPassed=regression_ok,legacyCompared=True)
    strongest=seed_path(cfg['trackId'],cfg['difficulty'])
    if strongest:
        baseline=evaluate_driver(cfg,targeted,directory/'saved-baseline',pack=read_json(strongest),control=control,progress=progress)
        result['savedBaselinePreserved']=matched_performance(regression,baseline,role)
    else:result['savedBaselinePreserved']=True
    if role=='shootout' and cfg['difficulty']=='extreme':
        pairs=[(a,b) for a,b in zip(regression,legacy) if clean(a,role) and clean(b,role)]
        result['extremeImprovement']=any(clean(a,role) and not clean(b,role) for a,b in zip(regression,legacy)) or bool(pairs and sum(a['raceTime'] for a,b in pairs)<sum(b['raceTime'] for a,b in pairs)-.05)
    else:result['extremeImprovement']=True
    result['passed']=result['quality']['passed'] and regression_ok and result['savedBaselinePreserved'] and result['extremeImprovement']
    result['episodes']=rows;write_json(directory/'certification.json',result);return result

def soak(cfg,pack,directory,control=None,progress=None):
    cfg={**cfg,'specialist':'race'};sample=[c|{'mode':'ai','raceLaps':10,'scenario':'solo'} for c in cases('race',50,'training',989)]
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True);env=EnergyVecEnv({**cfg,'policyPackage':pack,'recordObservations':False});rss=[];rows=[]
    class Zero:
        def predict(self,obs,deterministic=True):
            import numpy as np
            return np.zeros((len(obs),4)),None
    try:
        for c in sample:
            row=drive(env,c,cfg,model=Zero(),archive=directory/'attempts.jsonl.gz',control=control,progress=progress);rows.append({k:row[k] for k in ['finished','validLap','offTrackRate','contacts','raceTime','raceLaps']})
            owned=[psutil.Process(os.getpid()),*psutil.Process(os.getpid()).children(recursive=True)]
            total=0
            for p in owned:
                try:total+=p.memory_info().rss
                except psutil.Error:pass
            rss.append(total);write_json(directory/'progress.json',{'completed':len(rows),'rssBytes':rss})
        # Run without other jobs: retained heaps may settle during first 25 races.
        first=sum(rss[25:35])/10;last=sum(rss[40:50])/10
        slope=__import__('statistics').linear_regression(range(25,50),rss[25:50]).slope
        passed=len(rows)==50 and all(clean(r,'race') for r in rows) and last<=first+32*1024**2 and slope<=256*1024
        result={'passed':passed,'crashes':0,'episodes':len(rows),'rssBytes':rss,'lateGrowthBytes':last-first,'lateSlopeBytesPerEpisode':slope,'note':'RSS of isolated Python and owned simulator tree; full recordings enabled. Late slope <= 256 KiB/episode and late-window growth <= 32 MiB.'}
        write_json(directory/'soak.json',result);return result
    finally:env.close()

def compose(shootout,race,difficulty,name):
    if shootout['trackId']!=race['trackId'] or shootout['physicsHash']!=race['physicsHash']:raise ValueError('Specialists differ in track/physics')
    merged=copy.deepcopy(shootout);merged.update(format='kartblitz-official-track-v3',modelGeneration=3,environmentVersion=8,name=name,revision=REVISION,createdAt=int(time.time()*1000))
    merged['variants']={difficulty:{'id':uuid.uuid4().hex,'policies':{'shootout':shootout['variants'][difficulty],'race':race['variants'][difficulty]}}};return merged

class Campaign:
    def __init__(self,slots=5):
        CURRENT.mkdir(parents=True,exist_ok=True);self.lease=(CURRENT/'manager.lock').open('a+b');self.lease.write(b'0');self.lease.flush();self.lease.seek(0)
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(self.lease.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(self.lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
        for old in ['continuous-v2','campaign']:
            previous=read_json(ROOT/f'ml_training/runs/{old}/current/state.json',{})
            owner=previous.get('owner',{'pid':previous.get('managerPid'),'created':previous.get('managerCreated')})
            if alive(owner):raise RuntimeError('Another campaign is active; V3 did not interrupt it')
        self.state=read_json(CURRENT/'state.json',{})
        if alive(self.state.get('owner',{})):raise RuntimeError('V3 already running')
        self.hash=fingerprint()
        frozen=CURRENT/'source'/self.hash
        if not frozen.exists():
            for relative in SOURCES:
                destination=frozen/relative;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/relative,destination)
        if self.state and self.state.get('sourceFingerprint')!=self.hash:raise RuntimeError('V3 sources changed. Archive current V3 state before creating another revision; checkpoints have not been overwritten.')
        self.state=self.state or {'revision':REVISION,'sourceFingerprint':self.hash,'phase':'pilot','jobs':[],'events':[],'approved':{},'startedAt':time.time()}
        self.state['owner']={'pid':os.getpid(),'created':psutil.Process().create_time()};self.slots=min(5,slots);self.active={};self.lock=threading.RLock();self.monitor=ResourceMonitor();self.stop=threading.Event();self.next_admission=0
        for j in self.state['jobs']:
            if j['status']=='running':
                j['status']='queued'
                checkpoint=Path(j.get('chunkPath',''))/'last.zip'
                if checkpoint.is_file():
                    import zipfile
                    with zipfile.ZipFile(checkpoint) as archive:steps=json.loads(archive.read('data'))['num_timesteps']
                    j['decisions']=j.get('decisions',0)+max(0,steps-j.get('checkpointSteps',0));j['checkpointSteps']=steps;j['checkpoint']=str(checkpoint)
        if not self.state['jobs']:
            for track in [0,5]:
                for role in ['shootout','race']:self.add('teacher',track,'extreme',role)
        self.save()
    def add(self,kind,track,difficulty,role,**extra):
        j=dict(id=uuid.uuid4().hex,kind=kind,track=track,difficulty=difficulty,specialist=role,status='queued',**extra);self.state['jobs'].append(j);return j
    def event(self,text):self.state['events']=(self.state['events']+[{'at':time.time(),'message':text}])[-100:]
    def save(self):
        with self.lock:write_json(CURRENT/'state.json',self.state)
    def pulse(self,job,env=None,info=None,model=None,attempts=0,elapsed=0):
        if time.monotonic()-job.get('_lastWrite',0)<5:return
        job['_lastWrite']=time.monotonic()
        if env:
            archives=sorted((CURRENT/'jobs'/job['id']).rglob('*.jsonl.gz'),key=lambda p:p.stat().st_mtime)
            known=job.setdefault('replaySources',[]);known.extend(str(p) for p in archives if str(p) not in known)
            write_json(RUNS/job['id']/'replay-sources.json',known)
            snapshot=env.snapshot();job['previewJobId']=job['id']
            state={'id':job['id'],'official':True,'status':'running','runName':self.label(job),'trackId':job['track'],'difficulty':job['difficulty'],'phase':job.get('stage',job['kind']),'device':'cuda','attempts':attempts,'completedSteps':getattr(model,'num_timesteps',0),'history':[],'updatedAt':time.time(),'track':env.metadata['tracks'][job['track']],'preview':snapshot}
            write_json(RUNS/job['id']/'campaign-status.json',state)
        if info:job.update(lastResult={k:info.get(k) for k in ['progress','finished','raceTime','offTrackRate','failureReason']})
    def label(self,j):return f"V3 · {TRACKS[j['track']]} · {j['difficulty']} · {j['specialist']} · {j['kind']} · {j.get('arm','')} seed {j.get('seed','')}"
    def review_episode(self,job,row):
        if row.get('interrupted'):return
        recent=job.setdefault('recentDriving',[]);recent.append({k:row.get(k) for k in ['finished','offTrackRate','raceTime','contacts']});del recent[:-100]
        corners=job.setdefault('cornerFailures',{})
        for corner in row.get('cornerDiagnostics',[]):
            for reason in corner.get('failures',[]):
                key=corner['id']+': '+reason;corners[key]=corners.get(key,0)+1
        job['drivingReview']={'attemptsReviewed':len(recent),'completionRate':sum(bool(r['finished']) for r in recent)/len(recent),'meanOffTrackRate':sum(r['offTrackRate'] or 0 for r in recent)/len(recent),'frequentCornerIssues':sorted(corners.items(),key=lambda p:-p[1])[:8]}
    def worker(self,j,control):
        import torch
        from .independent_ppo import IndependentPPO as PPO
        cfg=configuration(j['track'],j['difficulty'],j['specialist'],j.get('seed',42));directory=CURRENT/'jobs'/j['id'];directory.mkdir(parents=True,exist_ok=True)
        pulse=lambda env,info:self.pulse(j,env,info)
        try:
            if j['kind']=='teacher':
                teacher=calibrate_teacher(cfg,directory,control,pulse)
                _,profile,_=collect_demonstrations(cfg,teacher,directory/'clean-demonstrations',control,pulse)
                teacher['profile']=profile;write_json(directory/'teacher.json',teacher);j['teacherPath']=str(directory/'teacher.json');j['result']={'calibrated':True}
            elif j['kind']=='train':
                teach=next(x for x in self.state['jobs'] if x['kind']=='teacher' and x['track']==j['track'] and x['difficulty']==j['difficulty'] and x['specialist']==j['specialist'])
                teacher=read_json(teach['teacherPath']);cfg.update(teacher['teacher'])
                cfg['sharedLearner']=True;cfg['algorithm']='Balanced BC + three DAgger rounds + critic warmup + PPO' if j['arm']=='taught' else 'Repaired baseline PPO'
                cfg['lineProfile']=teacher['profile'];cfg['lineGuidance']=True
                seed=seed_path(j['track'],j['difficulty'])
                if seed:cfg['seedPackage']=str(seed)
                def factory(env,config):
                    if j.get('checkpoint'):
                        model=PPO.load(j['checkpoint'],env=env,device='cuda');return model
                    if j.get('taughtCheckpoint'):
                        model=PPO.load(j['taughtCheckpoint'],env=env,device='cuda');return model
                    model=new_policy(env,config,policy_class=IndependentPPO)
                    if seed:
                        from .policy_seed import import_actor
                        import_actor(model,read_json(seed),env.metadata,j['difficulty'])
                    with torch.no_grad():model.policy.log_std.fill_(-2.)
                    return model
                if j['arm']=='taught' and not j.get('taughtCheckpoint'):
                    j['stage']='balanced imitation and three corrections';self.save()
                    taught=taught_seed(cfg,teacher,directory/'imitation',control,pulse);j['taughtCheckpoint']=taught['checkpoint'];j['profilePath']=taught['profile'];self.save()
                # train_arm's generic seed import runs after model_factory;
                # preserve the taught actor instead of copying over it again.
                cfg.pop('seedPackage',None)
                if j.get('profilePath'):cfg['lineProfile']=read_json(j['profilePath']);cfg['lineGuidance']=True
                total=int(j.get('decisions',0));left=j.get('budget',1000000)-total
                cfg.update(steps=min(200000,left),bestCheckpoint=True,selectionIntervalSeconds=600,selectionCases=[c|{'raceLaps':1,'scenario':'solo'} for c in cases(j['specialist'],6,'selection',j['seed'])],evaluationCases=[c|{'raceLaps':1,'scenario':'solo'} for c in cases(j['specialist'],6,'selection',j['seed'])])
                # Admission to traffic requires a real 100-case native solo pass.
                if j['specialist']=='race' and total>=200000 and not j.get('soloPassed'):
                    env=EnergyVecEnv(cfg)
                    try:
                        model=factory(env,cfg);gate=solo_selection(model,cfg,directory/('solo-'+uuid.uuid4().hex[:8]),control);j['soloPassed']=gate['passed'];j['soloGate']=gate
                    finally:env.close()
                stages=['passing','defending','recovery','mixed']
                cfg['racecraft']=j.get('soloPassed',False) and j['specialist']=='race'
                if cfg['racecraft']:cfg['scenario']=stages[min(3,max(0,total//200000-1))]
                else:cfg['scenario']='solo'
                j['stage']=cfg['scenario'];cfg['resumeCheckpoint']=j.get('checkpoint')
                turn=directory/f'chunk-{total}-{uuid.uuid4().hex[:6]}';j['chunkPath']=str(turn);self.save()
                pack,report=train_arm(cfg,turn,control,model_factory=factory,progress=lambda model,env,a,e:self.pulse(j,env,model=model,attempts=a,elapsed=e),episode_progress=lambda row:self.review_episode(j,row))
                status=read_json(turn/'status.json',{});steps=int(status.get('steps',0))
                # Fresh model factories start at zero except the imitation critic warmup (which has no RL steps).
                delta=steps-int(j.get('checkpointSteps',0));j['decisions']=total+max(0,delta);j['checkpointSteps']=steps;j['checkpoint']=str(turn/'last.zip');j['candidate']=str(turn/f"track-{j['track']}.kartai.json")
                if control.cancelled.is_set():j['status']='queued';return
                review=j.get('drivingReview',{})
                if j['arm']=='taught' and j.get('correctiveReviews',0)<2 and (review.get('completionRate',1)<.97 or review.get('meanOffTrackRate',0)>=.01):
                    j['stage']='reviewing line and corrective imitation';self.save()
                    correction=corrective_refresh({**cfg,'completedDecisions':j['checkpointSteps']},teacher,turn/'best.zip' if (turn/'best.zip').exists() else j['checkpoint'],directory/f"corrective-review-{j.get('correctiveReviews',0)}",control,pulse);j['correctiveReviews']=j.get('correctiveReviews',0)+1;j['lastCorrectionAccepted']=correction['accepted']
                    if correction['accepted']:
                        j['checkpoint']=correction['checkpoint'];corrected=PPO.load(j['checkpoint'],device='cuda');pack['variants'][j['difficulty']]['policy']=export_policy(corrected);write_json(turn/f"track-{j['track']}.kartai.json",pack);save_checkpoint(corrected,turn/'best.zip')
                if j['decisions']<j.get('budget',1000000):j['status']='queued';return
                model=PPO.load(turn/'best.zip' if (turn/'best.zip').exists() else turn/'last.zip',device='cuda')
                sample=cases(j['specialist'],100,'selection',j['seed'])
                report=evaluate(model,cfg,directory/'selection-final',control,cases_override=sample);j['selection']=report['cases'];j['quality']=quality(report['cases'],j['specialist'],100);j['result']={'decisions':j['decisions'],'quality':j['quality']}
            elif j['kind']=='certify':
                result=certify(cfg,read_json(j['candidate']),directory,control,pulse,j.get('round',0));j['result']=result;j['certificationPath']=str(directory/'certification.json')
            elif j['kind']=='soak':j['result']=soak(cfg,read_json(j['candidate']),directory,control,pulse)
            j['status']='complete'
        except InterruptedError:j['status']='queued'
        except Exception as error:
            j['failures']=j.get('failures',0)+1;j['error']=traceback.format_exc();j['status']='repair-required' if j['failures']>=3 or 'Neither native teacher' in str(error) or 'Teacher produced no valid' in str(error) else 'retry-wait';j['retryAfter']=time.time()+60
            (directory/f"error-{j['failures']}.txt").write_text(j['error'],encoding='utf-8')
        finally:
            state=read_json(RUNS/j['id']/'campaign-status.json',{})
            if state:state.update(status='complete' if j['status']=='complete' else 'cancelled' if j['status']=='queued' else 'failed',phase=j['status'],updatedAt=time.time());write_json(RUNS/j['id']/'campaign-status.json',state)
            import gc
            gc.collect()
            self.save()
    def advance(self):
        jobs=self.state['jobs'];teachers=[j for j in jobs if j['kind']=='teacher']
        if self.state['phase']=='pilot' and teachers and all(j['status']=='complete' for j in teachers) and not any(j['kind']=='train' for j in jobs):
            for seed in [41,42,43]:
                for arm in ['baseline','taught']:
                    for t in teachers:self.add('train',t['track'],t['difficulty'],t['specialist'],seed=seed,arm=arm,budget=1000000,pilotExperiment=True)
            self.event('Native teachers passed. Starting equal-budget three-seed pilot comparison.')
        trains=[j for j in jobs if j['kind']=='train' and j.get('pilotExperiment')]
        if self.state['phase']=='pilot' and len(trains)==24 and all(j['status']=='complete' for j in trains) and not any(j['kind']=='certify' for j in jobs):
            comparison=[]
            for track in [0,5]:
                for role in ['shootout','race']:
                    group=[j for j in trains if j['track']==track and j['specialist']==role];pairs=[]
                    for seed in [41,42,43]:
                        a=next(j for j in group if j['arm']=='taught' and j['seed']==seed);b=next(j for j in group if j['arm']=='baseline' and j['seed']==seed)
                        pairs.append({'seed':seed,'taughtRank':rank(a['selection'],role),'baselineRank':rank(b['selection'],role),'nonRegression':rank(a['selection'],role)>=rank(b['selection'],role)})
                    passed=sum(p['nonRegression'] for p in pairs)>=2;comparison.append({'track':track,'specialist':role,'seeds':pairs,'passed':passed})
                    winner=max((j for j in group if j['arm']=='taught'),key=lambda j:rank(j['selection'],role));self.add('certify',track,'extreme',role,candidate=winner['candidate'],sourceJob=winner['id'])
            self.state['pilotComparison']=comparison;write_json(CURRENT/'pilot-comparison.json',comparison)
        # A failed certificate never marks a model ready. Continue from the
        # saved actor with another selection-only training block, then use a
        # fresh final seed bank. Original equal-budget experiments stay frozen.
        for failed in list(jobs):
            if failed['kind']!='certify' or failed['status']!='complete' or failed['result']['passed'] or failed.get('superseded'):continue
            if failed.get('round',0)>=3:
                failed['needsRepair']=True;continue
            source=next((j for j in jobs if j['id']==failed.get('sourceJob')),None)
            if not source:continue
            new=self.add('train',source['track'],source['difficulty'],source['specialist'],seed=source['seed'],arm='taught',budget=1000000,checkpoint=source['checkpoint'],checkpointSteps=source['checkpointSteps'],taughtCheckpoint=source['checkpoint'],profilePath=source.get('profilePath'),soloPassed=source.get('soloPassed',False),refinementOf=failed['id'],round=failed.get('round',0)+1)
            failed['superseded']=True;failed['refinementJob']=new['id'];self.event('Certification failed; continuing '+self.label(new)+' with the saved weights.')
        for trained in list(jobs):
            if trained['kind']=='train' and trained.get('refinementOf') and trained['status']=='complete' and not trained.get('certificationJob'):
                certificate=self.add('certify',trained['track'],trained['difficulty'],trained['specialist'],candidate=trained['candidate'],sourceJob=trained['id'],round=trained['round']);trained['certificationJob']=certificate['id']
        self.promote_ready()
    def promote_ready(self):
        jobs=self.state['jobs']
        for difficulty in DIFFICULTIES:
            for track in range(8):
                key=f'{track}:{difficulty}'
                if key in self.state['approved']:continue
                cert=[j for j in jobs if j['kind']=='certify' and j['track']==track and j['difficulty']==difficulty and j['status']=='complete' and not j.get('superseded')]
                if len(cert)!=2 or not all(j['result']['passed'] for j in cert):continue
                comparisons=self.state.get('pilotComparison',[])
                if self.state['phase']=='pilot' and (len(comparisons)!=4 or not all(c['passed'] for c in comparisons)):continue
                if any(hashlib.sha256(json.dumps(read_json(j['candidate']),sort_keys=True,allow_nan=False).encode()).hexdigest()!=j['result'].get('candidateSha256') for j in cert):continue
                combined=compose(*[read_json(next(j for j in cert if j['specialist']==r)['candidate']) for r in ['shootout','race']],difficulty,f'V3 · {TRACKS[track]} · taught specialists')
                for certification in cert:
                    combined['variants'][difficulty]['policies'][certification['specialist']]['certification']={k:v for k,v in certification['result'].items() if k!='episodes'}
                candidate=CURRENT/f'candidates/{track}-{difficulty}.kartai.json';write_json(candidate,combined)
                checks=[j for j in jobs if j['kind']=='soak' and j['track']==track and j['difficulty']==difficulty]
                if not checks:self.add('soak',track,difficulty,'race',candidate=str(candidate));continue
                if not any(j['status']=='complete' and j['result']['passed'] for j in checks):continue
                # Both pilot tracks must certify and soak before unlocking full rollout.
                if self.state['phase']=='pilot':
                    ready_tracks={j['track'] for j in jobs if j['kind']=='soak' and j['status']=='complete' and j['result']['passed']}
                    if not {0,5}<=ready_tracks:continue
                self.install(combined,cert);self.state['approved'][key]={'at':time.time()};self.event(f'Approved both specialists for {TRACKS[track]} {difficulty}')
        if self.state['phase']=='pilot' and all(f'{t}:extreme' in self.state['approved'] for t in [0,5]):self.state['phase']='rollout';self.event('Pilot passed. Extreme packages first, then the remaining difficulties.')
        if self.state['phase']=='rollout':
            difficulty=next((d for d in DIFFICULTIES if not all(f'{t}:{d}' in self.state['approved'] for t in range(8))),None)
            if difficulty is None:self.state['phase']='complete';return
            for track in range(8):
                if f'{track}:{difficulty}' in self.state['approved']:continue
                for role in ['shootout','race']:
                    group=[j for j in jobs if j['track']==track and j['difficulty']==difficulty and j['specialist']==role]
                    teach=next((j for j in group if j['kind']=='teacher'),None)
                    if not teach:self.add('teacher',track,difficulty,role);continue
                    trains=[j for j in group if j['kind']=='train']
                    if teach['status']=='complete' and not trains:self.add('train',track,difficulty,role,arm='taught',seed=42,budget=1000000)
                    if trains and all(j['status']=='complete' for j in trains) and not any(j['kind']=='certify' for j in group):
                        winner=max(trains,key=lambda j:rank(j['selection'],role));self.add('certify',track,difficulty,role,candidate=winner['candidate'],sourceJob=winner['id'])
    def install(self,pack,cert):
        active=ROOT/'ai-models/active.json';manifest=read_json(active,{'format':'kartblitz-active-models-v1','revision':0,'automatic':True,'tracks':{}});old=manifest['tracks'].get(str(pack['trackId']));merged=read_json(ROOT/old['path']) if old else None
        if merged:
            if merged.get('format')!='kartblitz-official-track-v3':
                # Keep existing versions on disk; only V3 variants may share a V3 package.
                shutil.copyfile(ROOT/old['path'],CURRENT/f"legacy-active-{uuid.uuid4().hex}.json")
            else:
                for d,v in merged['variants'].items():pack['variants'].setdefault(d,v)
        relative=f"ai-models/approved/continuous/track-{pack['trackId']}-{uuid.uuid4().hex}.kartai.json";destination=ROOT/relative;write_json(destination,pack);write_json(destination.with_suffix('.validation.json'),{'certifications':[j['certificationPath'] for j in cert],'revision':REVISION})
        manifest['tracks'][str(pack['trackId'])]={'path':relative,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'variants':list(pack['variants']),'approvedAt':time.time()};manifest['automatic']=True;manifest['revision']+=1;write_json(active,manifest)
    def run(self):
        import torch
        if torch.cuda.is_available():torch.cuda.set_per_process_memory_fraction(.75)
        subprocess.Popen([sys.executable,'-m','ml_training.specialist_guardian',json.dumps(self.state['owner'])],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.event('V3 manager started; old campaign checkpoints and counters are preserved.')
        try:
            while not self.stop.is_set():
                for key,(thread,control) in list(self.active.items()):
                    if not thread.is_alive():self.active.pop(key)
                row=self.monitor.sample([os.getpid()]);problem=pressure(row);action=read_json(CURRENT/'control.json',{}).get('action','run')
                workers=[]
                for process in psutil.Process().children(recursive=True):
                    try:
                        if 'native-worker-v2.mjs' in ' '.join(process.cmdline()):workers.append({'pid':process.pid,'created':process.create_time()})
                    except psutil.Error:pass
                self.state['ownedWorkers']=workers
                if fingerprint()!=self.hash:problem='sources-changed'
                if action=='stop':
                    for _,control in self.active.values():control.cancelled.set();control.running.set()
                    if not self.active:break
                elif action=='pause' or problem:
                    for _,control in self.active.values():control.running.clear()
                    if problem in ['ram-pressure','vram-pressure','shared-gpu-memory'] and self.active:
                        key=next(reversed(self.active));control=self.active[key][1];control.cancelled.set();control.running.set()
                    self.next_admission=time.time()+30
                else:
                    for _,control in self.active.values():control.running.set()
                    self.advance()
                    queued=[j for j in self.state['jobs'] if j['status'] in ['queued','retry-wait'] and j.get('retryAfter',0)<=time.time() and j['id'] not in self.active]
                    queued.sort(key=lambda j:j.get('decisions',0))
                    # RSS soak is isolated from other jobs so it measures retained memory.
                    soak_active=any(j['kind']=='soak' and j['id'] in self.active for j in self.state['jobs'])
                    chosen=next((j for j in queued if j['kind']=='soak'),None) if not self.active else None
                    if chosen is None and not soak_active:chosen=next((j for j in queued if j['kind']!='soak'),None)
                    if chosen and len(self.active)<self.slots and time.time()>=self.next_admission and admission(row):
                        chosen['status']='running';control=TrainingControl();thread=threading.Thread(target=self.worker,args=(chosen,control),daemon=True);self.active[chosen['id']]=(thread,control);self.save();thread.start();self.next_admission=time.time()+20;self.event('Started '+self.label(chosen))
                if os.name=='nt':ctypes.windll.kernel32.SetThreadExecutionState(0x80000003 if row.get('onMains') else 0x80000000)
                status={**self.state,'updatedAt':time.time(),'resources':row,'activeCount':len(self.active),'targetSlots':self.slots,'waitingReason':problem,'action':action,'minimumAttempts':None}
                write_json(CURRENT/'status.json',status);self.save()
                if self.state['phase']=='complete' and not self.active:break
                self.stop.wait(5)
        finally:
            for _,c in self.active.values():c.cancelled.set();c.running.set()
            for t,_ in self.active.values():t.join(timeout=120)
            self.state['stoppedAt']=time.time();self.save();self.monitor.close();self.lease.close()
            write_json(CURRENT/'status.json',{**self.state,'phase':'complete' if self.state['phase']=='complete' else 'stopped','activeCount':0,'updatedAt':time.time(),'action':'stop','resources':{}})
            if os.name=='nt':ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--slots',type=int,default=5);args=parser.parse_args();campaign=Campaign(args.slots)
    signal.signal(signal.SIGINT,lambda *_:campaign.stop.set());signal.signal(signal.SIGTERM,lambda *_:campaign.stop.set());campaign.run()
if __name__=='__main__':main()
