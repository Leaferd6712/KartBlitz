"""Resumable V2 campaign with native races, fair coverage and verified promotion.

The local controller needs no chat, API calls or subscription credits. It keeps
training until stopped, paused, blocked by resources, or interrupted by shutdown.
"""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
import math
from collections import deque
import psutil
from .campaign import ROOT, RUNS, TRACKS, read_json, write_json, owned_record, Capacity
from .campaign_resources import ResourceMonitor, admission, pressure

CURRENT=ROOT/'ml_training/runs/continuous-v2/current'
ACTIVE=ROOT/'ai-models/active.json'
DIFFICULTIES=['extreme','hard','medium','easy','ultraeasy']
FLAGS=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
LIVE_ENVS={}
SOURCES=['index.html','online-sim.js','sim/official-game.mjs','sim/official-contract.mjs',
 'sim/official-policy.mjs','sim/official-policy-v2.mjs','sim/native-training-environment.mjs',
 'sim/official-runtime.mjs','sim/ai-model-library.mjs','sim/official-race-strategy.mjs','sim/racing-line.mjs','sim/energy-evaluation.mjs','ml_training/native-worker-v2.mjs',
 'ml_training/official_environment.py','ml_training/official_train.py','ml_training/official_environment_v2.py','ml_training/official_train_v2.py','ml_training/policy_seed.py',
 'ml_training/continuous_campaign.py','ml_training/campaign_resources.py',
 'scripts/ai-training/energy-browser-check.mjs']

def fingerprint():
    rows={p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in SOURCES}
    return hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest(),rows

def alive(record):
    try:
        p=psutil.Process(record['pid']);return p.is_running() and abs(p.create_time()-record['created'])<.1
    except (psutil.NoSuchProcess,KeyError):return False
    except psutil.AccessDenied:return True

def terminate_owned(record):
    if record.get('sharedLearner'):
        # A learner thread shares the manager PID. Never kill that PID as if
        # it were one independent worker. Interrupt only its simulator pipes.
        env=LIVE_ENVS.get(record.get('id'))
        if env:
            for batch in env.batches:
                try:batch.process.kill()
                except OSError:pass
        return
    if not alive(record):return
    p=psutil.Process(record['pid'])
    try:
        if 'ml_training.continuous_campaign' not in ' '.join(p.cmdline()):return
        children=p.children(recursive=True)
        for child in reversed(children):
            try:child.terminate()
            except psutil.Error:pass
        p.terminate();_,remaining=psutil.wait_procs([*children,p],timeout=3)
        for child in remaining:
            try:child.kill()
            except psutil.Error:pass
    except psutil.Error:pass

def terminate_validator(record):
    if not alive(record):return
    try:
        p=psutil.Process(record['pid'])
        if 'scripts/ai-training/energy-browser-check.mjs' not in p.cmdline():return
        children=p.children(recursive=True)
        for child in reversed(children):
            try:child.terminate()
            except psutil.Error:pass
        p.terminate();_,remaining=psutil.wait_procs([*children,p],timeout=3)
        for child in remaining:
            try:child.kill()
            except psutil.Error:pass
    except psutil.Error:pass

def acceptance(report,expected_sha,incumbent=False):
    """Campaign approval is explicit; diagnostic harness approval is never reused."""
    reasons=[];rows=report.get('cases',[]);a=[r for r in rows if r.get('arm')=='V2']
    if report.get('candidateSha256')!=expected_sha:reasons.append('Candidate changed after validation')
    if report.get('evaluationVersion')!=2 or report.get('defenseMetric')!='lane-deviation-review-proxy-v1':reasons.append('Unsupported evaluator')
    if len(a)!=26:reasons.append('Full 26-case native suite required')
    expected={(m,l,e,s) for m,l,e,s in [('shootout',1,e,'solo') for e in [.25,.5,1]]+ [('ai',l,[.25,.5,1][i%3],'solo') for i,l in enumerate([1,2,3,5,8,10])]+ [('ai',3,.5,s) for s in ['passing','defending','recovery','mixed']]}
    identity=lambda r:(r.get('mode'),r.get('raceLaps'),r.get('energy'),r.get('scenario'))
    key=lambda r:(r.get('seed'),*identity(r))
    seeds={r.get('seed') for r in a}
    if len(seeds)!=2 or any({identity(r) for r in a if r.get('seed')==seed}!=expected for seed in seeds):reasons.append('Incomplete race lengths, charges or scenarios')
    if len({key(r) for r in a})!=26:reasons.append('Repeated or missing evaluation cases')
    if any(not r.get('finished') or not r.get('valid') or r.get('offTrackRate',1)>=.01 for r in a):reasons.append('Valid clean completion required in every case')
    if any(not isinstance(r.get('raceTime'),(int,float)) or not math.isfinite(r['raceTime']) or r['raceTime']<=0 or not math.isfinite(r.get('offTrackRate',float('nan'))) for r in a):reasons.append('Finite measured times and track-limit metrics required')
    if any(r.get('defensiveReversalFlags',0) for r in a):reasons.append('Defensive review flags remain')
    if any(r.get('spectatorIntrusionTicks',0) or r.get('scenario')=='solo' and r.get('measuredOpponentCount')!=0 for r in rows):reasons.append('Native spectator isolation failed')
    if any(r.get('scenario')=='recovery' and (r.get('recoveryTime') is None or r['recoveryTime']>10) for r in a):reasons.append('Recovery exceeds ten seconds')
    improved=False
    for arm in ['Legacy']+(['Research seed'] if incumbent else []):
        peer={key(r):r for r in rows if r.get('arm')==arm}
        if set(peer)!={key(r) for r in a}:reasons.append('Missing matched '+arm);continue
        for r in a:
            p=peer[key(r)]
            if r.get('contacts',0)>p.get('contacts',0):reasons.append('More contact than '+arm);break
        for mode in ['shootout','ai']:
            pairs=[(r,peer[key(r)]) for r in a if r.get('mode')==mode]
            valid=[(r,p) for r,p in pairs if p.get('finished') and p.get('valid') and isinstance(p.get('raceTime'),(int,float))]
            if any(not isinstance(r.get('raceTime'),(int,float)) for r,p in valid):reasons.append('Missing candidate time');continue
            if mode=='shootout' and any(r['raceTime']>p['raceTime']+.05 for r,p in valid):reasons.append('Shootout pace regression against '+arm)
            if mode=='ai' and valid:
                if sum(r.get('racePosition',999) for r,p in valid)>sum(p.get('racePosition',999) for r,p in valid):reasons.append('Worse finishing positions than '+arm)
                if sum(r['raceTime'] for r,p in valid)>sum(p['raceTime'] for r,p in valid)+.05:reasons.append('Whole-race time regression against '+arm)
            if any(not p.get('finished') or not p.get('valid') for r,p in pairs):improved=True
            if valid and (sum(r['raceTime'] for r,p in valid)<sum(p['raceTime'] for r,p in valid)-.05 or sum(r.get('contacts',0) for r,p in valid)<sum(p.get('contacts',0) for r,p in valid)):improved=True
    if not improved:reasons.append('No measured improvement')
    return {'approved':not reasons,'reasons':sorted(set(reasons)),'conditions':'dry / stock / medium tyres',
            'note':'Defensive flags are conservative review proxies; no claim of perfect rule enforcement or WR pace.'}

def current_difficulty(tasks,order=None):
    for difficulty in order or DIFFICULTIES:
        if any(t.get('difficulty')==difficulty and not t.get('ready') for t in tasks):return difficulty
    return None

def schedule(tasks,difficulty_order=None):
    # Every track/difficulty gets a turn before a combination gets another turn.
    difficulty=current_difficulty(tasks,difficulty_order) if difficulty_order is not None else None
    return sorted((t for t in tasks if (difficulty_order is None or t.get('difficulty')==difficulty) and t['status'] in ['queued','retry-wait'] and t.get('retryAfter',0)<=time.time()),key=lambda t:(bool(t.get('targetReached')),t['turns'],t['priority']))

def count_attempts(directory,record):
    """Incremental durable index count; partial writes/fragments never count."""
    path=Path(directory)/'attempt-index.jsonl'
    if not path.exists():return
    offset=record.get('countedBytes',0)
    if path.stat().st_size<offset:raise RuntimeError('Attempt index shrank; refusing to invent cumulative counts')
    with path.open('rb') as source:
        source.seek(offset)
        while True:
            line=source.readline()
            if not line or not line.endswith(b'\n'):break
            row=json.loads(line)
            if not row.get('interrupted'):
                record['countedAttempts']=record.get('countedAttempts',0)+1
                record['countedRaces']=record.get('countedRaces',0)+int(row.get('mode')=='ai')
                record['countedValid']=record.get('countedValid',0)+int(bool(row.get('finished')))
            record['countedBytes']=source.tell()

def scheduler_update_is_safe(previous,current):
    allowed={'ml_training/continuous_campaign.py','ml_training/native-worker-v2.mjs','ml_training/official_environment_v2.py','ml_training/official_train_v2.py'}
    changed={p for p in set(previous)|set(current) if previous.get(p)!=current.get(p)}
    return bool(previous) and changed<=allowed,sorted(changed)

def can_start(row):
    return (row.get('onMains',False) and row.get('diskFreeGiB',0)>=20 and row.get('ramAvailableGiB',0)>=1.5 and row.get('ramPercent',100)<93 and row.get('gpuTempC',100)<83 and row.get('gpuUsedMiB',99999)<6400 and row.get('sharedGpuMiB') is not None and row.get('sharedGpuExcessMiB',99999)<64)

def cases(stage,selection=False):
    seed=470011 if selection else 580013
    rows=[{'mode':'shootout','raceLaps':1,'energy':e,'scenario':'solo','seed':seed+i} for i,e in enumerate([.25,.5,1])]
    if stage!='solo':
        rows += [{'mode':'ai','raceLaps':l,'energy':e,'scenario':s,'seed':seed+10+i} for i,(l,e,s) in enumerate([(3,.5,'passing'),(3,.5,'defending'),(3,.5,'recovery'),(10,.25,'solo')])]
    return rows

def worker(run_id,control=None):
    from .official_train import TrainingControl
    from .official_train_v2 import train_arm
    import torch
    directory=RUNS/run_id;spec=read_json(directory/'campaign-spec.json');cfg=spec['config'];control=control or TrainingControl();done=threading.Event()
    if fingerprint()[0]!=spec['sourceFingerprint']:raise RuntimeError('Sources changed before worker startup')
    def commands():
        while not done.wait(1):
            action=read_json(directory/'campaign-control.json',{}).get('action')
            if action in ['pause','stop'] or not alive(spec['owner']):control.cancelled.set();control.running.set()
    threading.Thread(target=commands,daemon=True).start()
    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGINT,lambda *_:control.cancelled.set());signal.signal(signal.SIGTERM,lambda *_:control.cancelled.set())
    last=[0.];state={'id':run_id,'official':True,'status':'running','runName':spec['label'],'trackId':cfg['trackId'],'difficulty':cfg['difficulty'],'device':cfg['device'],'budgetMode':'time','durationSeconds':cfg['seconds'],'phase':'initializing','attempts':0,'completedSteps':0,'history':[]}
    recent=deque(maxlen=100)
    def episode_progress(row):
        if row.get('interrupted'):return
        recent.append({k:row.get(k) for k in ['progress','raceLaps','finished']})
        state['history'].append({'step':row['policyStep'],'trackId':cfg['trackId'],'difficulty':cfg['difficulty'],'progress':sum(min(1,r.get('progress',0)/max(1,r.get('raceLaps',1))) for r in recent)/len(recent),'finishRate':sum(bool(r.get('finished')) for r in recent)/len(recent)})
        state['history']=state['history'][-500:]
    def progress(model,env,attempts,elapsed):
        LIVE_ENVS[run_id]=env
        if time.monotonic()-last[0]<5:return
        last[0]=time.monotonic();state.update(phase='learning',completedSteps=model.num_timesteps,attempts=attempts,elapsedSeconds=elapsed,timeRemainingSeconds=max(0,cfg['seconds']-elapsed),track=env.metadata['tracks'][cfg['trackId']],updatedAt=time.time(),preview=env.snapshot(0))
        write_json(directory/'campaign-status.json',state)
    write_json(directory/'campaign-status.json',state)
    try:
        if cfg['device']=='cuda':torch.cuda.set_per_process_memory_fraction(float(cfg.get('cudaMemoryFraction',.15)))
        pack,report=train_arm(cfg,directory,control,progress=progress,episode_progress=episode_progress)
        # These are honest candidates; only the manager's native gate approves.
        pack['name']=spec['label'];pack['variants'][cfg['difficulty']]['training']['runName']=spec['label']
        write_json(directory/f"track-{cfg['trackId']}.kartai.json",pack)
        evaluation=pack['variants'][cfg['difficulty']]['evaluation'];evaluation['offTrackRate']=sum(r.get('offTrackRate',0) for r in report['cases'])/max(1,len(report['cases']))
        state.update(status='cancelled' if control.cancelled.is_set() else 'complete',phase='saved',evaluation=evaluation,packages=[{'trackId':cfg['trackId'],'name':pack['name'],'variants':[cfg['difficulty']]}],updatedAt=time.time())
    except Exception:
        import traceback
        state.update(status='failed',phase='failed',error=traceback.format_exc(),updatedAt=time.time())
        (directory/'campaign-error.txt').write_text(state['error'],encoding='utf-8')
    finally:done.set();LIVE_ENVS.pop(run_id,None);write_json(directory/'campaign-status.json',state)

class LearnerThread:
    def __init__(self,run_id):
        from .official_train import TrainingControl
        self.control=TrainingControl();self.thread=threading.Thread(target=worker,args=(run_id,self.control),daemon=True)
    def start(self):self.thread.start()
    def poll(self):return None if self.thread.is_alive() else 0

class ContinuousCampaign:
    def __init__(self,chunk=1200,max_slots=5):
        CURRENT.mkdir(parents=True,exist_ok=True)
        # OS lease closes automatically after a crash. Two launchers cannot
        # both pass a JSON PID check and start duplicate training campaigns.
        self.lease=(CURRENT/'manager.lock').open('a+b');self.lease.seek(0);self.lease.write(b'0');self.lease.flush();self.lease.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(self.lease.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:raise RuntimeError('A continuous campaign already holds the manager lease')
        saved=read_json(CURRENT/'state.json',{})
        if alive(saved.get('owner',{})):raise RuntimeError('A continuous campaign is already running')
        from .official_train_v2 import campaign_is_live
        if campaign_is_live():raise RuntimeError('The old V1 campaign is active or inaccessible; it was not interrupted')
        self.hash,files=fingerprint();self.chunk=chunk;self.max_slots=max_slots;self.stop_event=threading.Event();self.processes={};self.monitor=ResourceMonitor();self.capacity=Capacity();self.capacity.target=max_slots;self.windows=set();self.validating=None;self.last_validation=0;self.next_admission=0
        self.settings=read_json(CURRENT/'settings.json',{})
        self.settings.setdefault('minimumAttempts',10000);self.settings.setdefault('minimumRaceAttempts',2000);self.settings.setdefault('carsPerJob',4);self.settings.setdefault('maxSlots',max_slots);self.settings.setdefault('stopWhenAllReady',True)
        self.settings.setdefault('schedulingMode','difficulty-first');self.settings.setdefault('difficultyOrder',DIFFICULTIES)
        if not self.settings.get('sharedLearners'):
            self.settings['sharedLearners']=True;self.settings['carsPerJob']=2
        write_json(CURRENT/'settings.json',self.settings)
        if saved and saved['sourceFingerprint']!=self.hash:
            previous=read_json(CURRENT/'source'/saved['sourceFingerprint']/'fingerprints.json',{})
            safe,changed=scheduler_update_is_safe(previous,files)
            if not safe:raise RuntimeError('Physics/control sources changed; prior campaign preserved, explicit review required')
            write_json(CURRENT/f'state-before-scheduler-update-{uuid.uuid4().hex}.json',saved)
            saved.setdefault('sourceRevisions',[]).append({'previous':saved['sourceFingerprint'],'current':self.hash,'changed':changed,'at':time.time(),'reason':'Authorised cumulative targets, five independent learners sharing Python/CUDA and bounded browser memory; driving contract unchanged.'})
            saved['sourceFingerprint']=self.hash
        self.state=saved or {'campaignId':uuid.uuid4().hex,'startedAt':time.time(),'tasks':[{'track':t,'difficulty':d,'priority':i*8+t,'status':'queued','stage':'solo','turns':0,'failures':0,'best':None,'last':None} for i,d in enumerate(DIFFICULTIES) for t in range(8)],'runs':[],'events':[],'promotions':{},'validations':[],'sourceFingerprint':self.hash}
        for r in self.state['runs']:
            if r.get('active'):
                terminate_owned(r);r['active']=False
                task=next(t for t in self.state['tasks'] if t['track']==r['track'] and t['difficulty']==r['difficulty'])
                checkpoint=RUNS/r['id']/'last.zip';spec=read_json(RUNS/r['id']/'campaign-spec.json',{})
                if checkpoint.exists() and spec.get('config'):
                    task['last']={'checkpoint':str(checkpoint),'gamma':spec['config']['gamma'],'stage':r['stage']}
                    task.setdefault('continuations',{})[f"{r['stage']}:{spec['config']['gamma']}"]=task['last']
        for task in self.state['tasks']:
            if task['status']=='running':task['status']='queued'
            task.setdefault('attempts',0);task.setdefault('raceAttempts',0);task.setdefault('validAttempts',0)
            task['minimumAttempts']=max(10000,int(self.settings['minimumAttempts']));task['minimumRaceAttempts']=int(self.settings['minimumRaceAttempts'])
        self.state.update(owner={'pid':os.getpid(),'created':psutil.Process().create_time()},phase='training',deadline=None)
        source=CURRENT/'source'/self.hash
        for name in SOURCES:
            target=source/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
        write_json(source/'fingerprints.json',files)
        if not saved:
            backup=ROOT/'ai-models/backups'/self.state['campaignId'];backup.mkdir(parents=True)
            shutil.copyfile(ROOT/'index.html',backup/'legacy-game.html')
            shutil.copytree(ROOT/'ai-models/approved',backup/'approved',dirs_exist_ok=True)
            if ACTIVE.exists():shutil.copyfile(ACTIVE,backup/'active.json')
            write_json(backup/'backup.json',{'createdAt':time.time(),'legacyController':'index.html:makeAIInput','sourceFingerprint':self.hash,'automaticActivationAuthorized':True})
        self.event('Continuous V2 campaign ready; 40 combinations, actual native races, no deadline.');self.save()
        self.refresh_counts()
    def save(self):write_json(CURRENT/'state.json',self.state)
    def queued(self):
        order=self.settings.get('difficultyOrder',DIFFICULTIES) if self.settings.get('schedulingMode')=='difficulty-first' else None
        return schedule(self.state['tasks'],order)
    def refresh_counts(self):
        totals={(t['track'],t['difficulty']):[0,0,0] for t in self.state['tasks']}
        for r in self.state['runs']:
            count_attempts(RUNS/r['id'],r);group=totals[(r['track'],r['difficulty'])]
            for i,key in enumerate(['countedAttempts','countedRaces','countedValid']):group[i]+=r.get(key,0)
        for task in self.state['tasks']:
            task['attempts'],task['raceAttempts'],task['validAttempts']=totals[(task['track'],task['difficulty'])]
            task['targetReached']=task['attempts']>=task['minimumAttempts'] and task['raceAttempts']>=task['minimumRaceAttempts']
            task['ready']=task['targetReached'] and f"{task['track']}:{task['difficulty']}" in self.state['promotions']
            if task['ready'] and task['status']=='queued' and self.settings.get('stopWhenAllReady'):task['status']='done'
    def event(self,message):
        row={'at':time.time(),'message':message};self.state['events'].append(row);self.state['events']=self.state['events'][-100:]
        with (CURRENT/'events.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(row)+'\n')
    def seeds(self,task):
        if task.get('best'):return task['best']['package'],task['difficulty']
        extreme=next(t for t in self.state['tasks'] if t['track']==task['track'] and t['difficulty']=='extreme')
        if extreme.get('best'):return extreme['best']['package'],'extreme'
        seed=ROOT/'ml_training/runs/pace-rnd/sunset-review/candidate.kartai.json'
        if task['track']==0 and seed.exists():return str(seed),'extreme'
        return None,None
    def spawn(self,task,slot):
        run_id=uuid.uuid4().hex;directory=RUNS/run_id;directory.mkdir(parents=True)
        seed,seed_difficulty=self.seeds(task);round_=task['turns'];gamma=.9995 if round_%2==0 else .9999
        if seed and seed_difficulty==task['difficulty'] and not task.get('reference'):task['reference']=seed
        cfg={'trackId':task['track'],'difficulty':task['difficulty'],'seed':42+round_*101+task['priority']*8191,'device':'cuda','cudaMemoryFraction':.15,'numEnvs':int(self.settings['carsPerJob']),'workers':1,'horizon':128,'batchSize':128,'learningRate':5e-5 if seed else 1e-4,'targetKL':.015,'gamma':gamma,'seconds':self.chunk,'nativeRace':True,'trainingMode':'shootout' if task['stage']=='solo' else 'mixed','racecraft':task['stage']!='solo','lineGuidance':False,'bestCheckpoint':True,'selectionIntervalSeconds':300,'selectionCases':cases(task['stage'],True),'evaluationCases':cases(task['stage']), 'initialTyreWearChoices':[0,0,.2,.4,.6]}
        if seed:
            reliable=not task.get('best') or task['best']['report']['summary']['shootout']['finishRate']>=.9
            cfg.update(seedPackage=seed,seedDifficulty=seed_difficulty,initialLogStd=[-2.3,-1.6,-1.6,-1.] if reliable else [-.7,-.5,-.5,-.5])
        previous=task.get('continuations',{}).get(f"{task['stage']}:{gamma}",task.get('last'))
        if previous and previous.get('gamma')==gamma and previous.get('stage')==task['stage'] and Path(previous['checkpoint']).exists():cfg['resumeCheckpoint']=previous['checkpoint']
        label=f"V2 · {TRACKS[task['track']]} · {task['difficulty']} · {task['stage']} · pass {round_+1}"
        write_json(directory/'campaign-spec.json',{'config':cfg,'sourceFingerprint':self.hash,'owner':self.state['owner'],'label':label,'continuous':True})
        cfg['sharedLearner']=True
        # Rewrite the serializable spec with the execution provenance before
        # the thread reads it. Each job still owns its own PPO/Adam objects.
        write_json(directory/'campaign-spec.json',{'config':cfg,'sourceFingerprint':self.hash,'owner':self.state['owner'],'label':label,'continuous':True})
        job=LearnerThread(run_id)
        record={**self.state['owner'],'id':run_id,'slot':slot,'track':task['track'],'trackId':task['track'],'trackName':TRACKS[task['track']],'difficulty':task['difficulty'],'stage':task['stage'],'active':True,'sharedLearner':True,'startedAt':time.time()}
        self.state['runs'].append(record);self.processes[run_id]=job;task['status']='running';job.start();self.event('Started '+label);self.open_window(slot);self.save()
    def open_window(self,slot):
        if slot in self.windows:return
        connection=read_json(RUNS/'connection-8766.json',{})
        if not connection.get('pairingCode'):return
        edge=Path(os.environ.get('PROGRAMFILES(X86)','C:/Program Files (x86)'))/'Microsoft/Edge/Application/msedge.exe'
        if not edge.exists():return
        url=f"http://127.0.0.1:8766/ui/continuous-training.html?slot={slot}&trainerCode={connection['pairingCode']}"
        subprocess.Popen([str(edge),'--new-window',url],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.windows.add(slot)
    def request_stop(self,r,reason):
        if r.get('stopRequested'):return
        r.update(stopRequested=True,stopAt=time.time());write_json(RUNS/r['id']/'campaign-control.json',{'action':'stop'})
        job=self.processes.get(r['id'])
        if isinstance(job,LearnerThread):job.control.cancelled.set();job.control.running.set()
        self.event('Saving slot '+str(r['slot']+1)+': '+reason)
    def collect(self):
        for r in self.state['runs']:
            if not r.get('active'):continue
            p=self.processes.get(r['id']);status=read_json(RUNS/r['id']/'campaign-status.json',{})
            r.update(phase=status.get('phase','initializing'),steps=status.get('completedSteps',0),attempts=status.get('attempts',0),updatedAt=status.get('updatedAt',r['startedAt']))
            if r.get('stopRequested') and time.time()-r['stopAt']>120:terminate_owned(r)
            if time.time()-r['updatedAt']>600:self.request_stop(r,'worker heartbeat stalled')
            if p and p.poll() is None:continue
            r['active']=False;r['endedAt']=time.time();task=next(t for t in self.state['tasks'] if t['track']==r['track'] and t['difficulty']==r['difficulty']);task['status']='queued'
            spec=read_json(RUNS/r['id']/'campaign-spec.json');checkpoint=RUNS/r['id']/'last.zip'
            if checkpoint.exists():
                task['last']={'checkpoint':str(checkpoint),'gamma':spec['config']['gamma'],'stage':r['stage']}
                task.setdefault('continuations',{})[f"{r['stage']}:{spec['config']['gamma']}"]=task['last']
            pack_path=RUNS/r['id']/f"track-{r['track']}.kartai.json";report=read_json(RUNS/r['id']/'evaluation/report.json')
            if status.get('status')=='complete' and report and not report.get('cancelled'):
                from .official_train_v2 import choose_result
                old=task.get('best');better=not old or choose_result([('old',old['report']),('new',report)])[0]=='new'
                if better:task['best']={'package':str(pack_path),'report':report,'run':r['id'],'stage':r['stage'],'needsValidation':r['stage']!='solo'}
                if r['stage']=='solo' and report['summary']['shootout']['finishRate']>=.95:task['stage']='mixed';task['last']=None;task['continuations']={};self.event(TRACKS[r['track']]+' '+r['difficulty']+' advances to full-race training')
                task['turns']+=1;task['failures']=0
            elif not r.get('stopRequested'):
                task['turns']+=1;task['failures']+=1
                self.event('Worker failure '+r['id']+': '+status.get('error','see worker log')[-350:])
                if any(word in status.get('error','').lower() for word in ['out of memory','target closed','simulator exited']) and self.settings['carsPerJob']>1:
                    self.settings['carsPerJob']=max(1,self.settings['carsPerJob']//2);write_json(CURRENT/'settings.json',self.settings);self.event('Reduced future simulator batches after memory/worker closure')
                if task['failures']>=3:
                    task['status']='retry-wait';task['retryAfter']=time.time()+min(1800,60*2**min(task['failures'],5));task['last']=None;task['continuations']={}
                    self.event('Fault cooldown; will retry '+TRACKS[task['track']]+' '+task['difficulty']+' from the retained best actor')
            self.event('Saved '+r['id']);self.save()
    def start_validation(self):
        if self.validating or time.time()-self.last_validation<30:return
        difficulty=current_difficulty(self.state['tasks'],self.settings.get('difficultyOrder',DIFFICULTIES)) if self.settings.get('schedulingMode')=='difficulty-first' else None
        for t in self.state['tasks']:
            if difficulty is not None and t['difficulty']!=difficulty:continue
            if not t.get('targetReached'):continue
            best=t.get('best')
            if not best or not best.get('needsValidation'):continue
            seed=uuid.uuid4().hex;directory=CURRENT/'validations'/seed;directory.mkdir(parents=True)
            command=['node','scripts/ai-training/energy-browser-check.mjs',best['package'],t['difficulty'],str(directory/'native.json'),'--offline-assets','--evaluation-seeds',f'{int(seed[:7],16)+1000000},{int(seed[7:14],16)+1000000}']
            manifest=read_json(ACTIVE,{});descriptor=manifest.get('tracks',{}).get(str(t['track']))
            incumbent=None
            if descriptor:
                incumbent=ROOT/descriptor['path'];pack=read_json(incumbent,{})
                if t['difficulty'] in pack.get('variants',{}):command+=['--research-baseline',str(incumbent)]
                else:incumbent=None
            if incumbent is None and t.get('reference'):
                incumbent=Path(t['reference']);command+=['--research-baseline',str(incumbent)]
            with (directory/'validation.log').open('w',encoding='utf-8') as log:p=subprocess.Popen(command,cwd=ROOT,stdout=log,stderr=log,creationflags=FLAGS)
            self.state['validator']=owned_record(p)
            self.validating={'process':p,'task':t,'best':dict(best),'output':directory/'native.json','startedAt':time.time(),'incumbent':str(incumbent) if incumbent else None};best['needsValidation']=False;self.event('Native approval check: '+TRACKS[t['track']]+' '+t['difficulty']);return
    def collect_validation(self):
        v=self.validating
        if not v:return
        p=v['process']
        if p.poll() is None:
            if time.time()-v['startedAt']>1800:terminate_validator(self.state.get('validator',{}));self.event('Native validator timed out; no promotion')
            else:return
        report=read_json(v['output'],{});path=Path(v['best']['package']);result=acceptance(report,hashlib.sha256(path.read_bytes()).hexdigest(),bool(v['incumbent']))
        if fingerprint()[0]!=self.hash:result={'approved':False,'reasons':['Sources changed during validation']}
        if report.get('gameSourceSha256')!=hashlib.sha256((ROOT/'index.html').read_bytes()).hexdigest() or report.get('evaluationSourceSha256')!=hashlib.sha256((ROOT/'scripts/ai-training/energy-browser-check.mjs').read_bytes()).hexdigest():result={'approved':False,'reasons':['Native source provenance differs']}
        result.update(track=v['task']['track'],difficulty=v['task']['difficulty'],candidate=str(path),native=str(v['output']),testedAt=time.time())
        write_json(v['output'].parent/'acceptance.json',result);self.state['validations'].append(result)
        if result['approved']:self.promote(v['task'],path,result)
        else:self.event('Candidate retained for research: '+'; '.join(result['reasons'][:3]))
        self.validating=None;self.state.pop('validator',None);self.last_validation=time.time();self.save()
    def promote(self,task,path,validation):
        pack=read_json(path);track=task['track'];difficulty=task['difficulty'];manifest=read_json(ACTIVE,{'format':'kartblitz-active-models-v1','revision':0,'tracks':{}})
        old=manifest['tracks'].get(str(track));merged=read_json(ROOT/old['path']) if old else None
        if merged and (merged['physicsHash']!=pack['physicsHash'] or merged['trackFingerprint']!=pack['trackFingerprint']):raise RuntimeError('Active model contract changed')
        if not merged:merged={**pack,'variants':{}}
        merged['variants'][difficulty]=pack['variants'][difficulty];merged['name']='V2 Continuous · '+TRACKS[track];merged['createdAt']=int(time.time()*1000)
        version=uuid.uuid4().hex;relative=f'ai-models/approved/continuous/track-{track}-{version}.kartai.json';destination=ROOT/relative
        write_json(destination,merged);write_json(destination.with_suffix('.validation.json'),validation)
        manifest['tracks'][str(track)]={'path':relative,'sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'variants':list(merged['variants']),'approvedAt':time.time()}
        manifest['revision']=int(manifest.get('revision',0))+1;manifest['automatic']=True;write_json(ACTIVE,manifest)
        self.state['promotions'][f'{track}:{difficulty}']=validation;self.event('APPROVED and automatically selected: '+TRACKS[track]+' '+difficulty)
    def publish(self,resources,rate):
        active=[r for r in self.state['runs'] if r.get('active')]
        tasks=[{k:v for k,v in t.items() if k not in ['best','last','continuations']}|{'hasCandidate':bool(t.get('best')),'approved':f"{t['track']}:{t['difficulty']}" in self.state['promotions']} for t in self.state['tasks']]
        difficulty=current_difficulty(self.state['tasks'],self.settings.get('difficultyOrder',DIFFICULTIES)) if self.settings.get('schedulingMode')=='difficulty-first' else None
        write_json(CURRENT/'status.json',{'phase':self.state['phase'],'deadline':None,'updatedAt':time.time(),'startedAt':self.state['startedAt'],'active':active,'activeCount':len(active),'queuedCount':len(self.queued()),'currentDifficulty':difficulty,'difficultyOrder':self.settings.get('difficultyOrder',DIFFICULTIES),'deferredCount':sum(not t.get('ready') and t['difficulty']!=difficulty for t in tasks) if difficulty else 0,'resources':resources,'aggregateStepsPerSecond':rate,'tasks':tasks,'promotions':len(self.state['promotions']),'readyCount':sum(bool(t.get('ready')) for t in tasks),'minimumAttempts':self.settings['minimumAttempts'],'targetSlots':self.max_slots,'events':self.state['events'],'validationActive':bool(self.validating),'creditUse':'Local training makes no model API calls; chat credits are not queried or managed.'});self.save()
    def run(self):
        guardian=subprocess.Popen([sys.executable,'-m','ml_training.continuous_campaign','--guardian'],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=FLAGS)
        history=deque(maxlen=25);failed=False
        try:
            while not self.stop_event.is_set():
                self.collect();self.collect_validation();self.refresh_counts();now=time.time();active=[r for r in self.state['runs'] if r.get('active')];resources=self.monitor.sample([r['pid'] for r in active]);problem=pressure(resources)
                if fingerprint()[0]!=self.hash:problem='sources-changed'
                action=read_json(CURRENT/'control.json',{}).get('action','run');self.state['phase']='paused' if action=='pause' else 'stopping' if action=='stop' else 'waiting: '+problem if problem else 'training'
                history.append((now,{r['id']:r.get('steps',0) for r in active}));then,previous=history[0]
                rate=sum(max(0,r.get('steps',0)-previous.get(r['id'],r.get('steps',0))) for r in active)/max(.1,now-then)
                if os.name=='nt':ctypes.windll.kernel32.SetThreadExecutionState(0x80000003 if resources.get('onMains') else 0x80000000)
                if action in ['stop','pause'] or problem in ['sources-changed','unplugged','disk-reserve','gpu-telemetry-unavailable']:
                    for r in active:self.request_stop(r,problem or action)
                    if self.validating:
                        self.validating['task']['best']['needsValidation']=True;terminate_validator(self.state.get('validator',{}));self.validating=None;self.state.pop('validator',None)
                    if action=='stop' and not active:break
                elif problem and active:
                    self.request_stop(active[-1],problem);self.next_admission=now+120
                    if problem=='ram-pressure' and int(self.settings['carsPerJob'])>1:
                        self.settings['carsPerJob']=max(1,int(self.settings['carsPerJob'])//2);write_json(CURRENT/'settings.json',self.settings);self.event('Reduced cars per future job to '+str(self.settings['carsPerJob'])+'; five-slot target retained')
                elif not problem:
                    busy={(r['track'],r['difficulty']) for r in active}
                    queued=[t for t in self.queued() if (t['track'],t['difficulty']) not in busy]
                    if queued and len(active)<self.max_slots and now>=self.next_admission and can_start(resources) and not any(r.get('stopRequested') for r in active):
                        slot=next(i for i in range(self.max_slots) if i not in {r['slot'] for r in active});self.spawn(queued[0],slot)
                    self.start_validation()
                if all(t.get('ready') for t in self.state['tasks']) and self.settings.get('stopWhenAllReady'):
                    for r in active:self.request_stop(r,'All 40 models met attempt and native-quality targets')
                    if not active:self.state['completedTargets']=True;break
                self.publish(resources,rate);self.stop_event.wait(5)
        except Exception as error:
            failed=True;self.state['failure']=repr(error);self.event('Controller failed: '+repr(error));raise
        finally:
            for r in self.state['runs']:
                if r.get('active'):self.request_stop(r,'controller stopping')
            until=time.time()+120
            while time.time()<until and any(r.get('active') for r in self.state['runs']):self.collect();time.sleep(1)
            for r in self.state['runs']:
                if r.get('active'):terminate_owned(r);r['active']=False
            if self.validating:
                self.validating['task']['best']['needsValidation']=True;terminate_validator(self.state.get('validator',{}));self.state.pop('validator',None)
            self.refresh_counts();self.state['phase']='failed' if failed else 'complete' if self.state.get('completedTargets') else 'stopped';self.publish(self.monitor.sample(),0);self.monitor.close()
            self.lease.close()
            if os.name=='nt':ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)

def guardian():
    state=read_json(CURRENT/'state.json',{});owner=state.get('owner',{})
    while alive(owner):
        time.sleep(10)
        if read_json(CURRENT/'state.json',{}).get('owner')!=owner:return
    state=read_json(CURRENT/'state.json',{})
    for record in state.get('runs',[]):
        if record.get('active'):terminate_owned(record)
    terminate_validator(state.get('validator',{}))
    action=read_json(CURRENT/'control.json',{}).get('action','run')
    if action=='run' and state.get('phase') not in ['stopped','complete'] and state.get('managerRestarts',0)<3 and state.get('sourceFingerprint')==fingerprint()[0]:
        state['managerRestarts']=state.get('managerRestarts',0)+1;write_json(CURRENT/'state.json',state)
        with (CURRENT/'manager.log').open('a',encoding='utf-8') as output,(CURRENT/'manager-errors.log').open('a',encoding='utf-8') as errors:
            subprocess.Popen([sys.executable,'-m','ml_training.continuous_campaign'],cwd=ROOT,stdout=output,stderr=errors,creationflags=FLAGS)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--worker');p.add_argument('--guardian',action='store_true');p.add_argument('--chunk-seconds',type=int,default=1200);p.add_argument('--max-slots',type=int,default=5)
    args=p.parse_args()
    if args.worker:worker(args.worker);return
    if args.guardian:guardian();return
    if not 60<=args.chunk_seconds<=7200 or not 1<=args.max_slots<=5:p.error('Use 60–7200 seconds per chunk and 1–5 slots')
    if alive(read_json(CURRENT/'state.json',{}).get('owner',{})):p.error('Continuous campaign already running; use its dashboard')
    from .official_train_v2 import campaign_is_live
    if campaign_is_live():p.error('The archived V1 manager is still active or inaccessible; no rebuild was attempted')
    subprocess.run(['node','scripts/build-official-core.mjs'],cwd=ROOT,check=True)
    campaign=ContinuousCampaign(args.chunk_seconds,args.max_slots)
    signal.signal(signal.SIGINT,lambda *_:campaign.stop_event.set());signal.signal(signal.SIGTERM,lambda *_:campaign.stop_event.set())
    campaign.run()

if __name__=='__main__':main()
