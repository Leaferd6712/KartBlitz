"""Persistent, resource-aware independent PPO jobs with an absolute deadline.

Run through the project venv. The watchdog is a separate process; no cloud service
or continuously open chat is required. Candidate activation is always manual.
"""
from __future__ import annotations
import argparse
import ctypes
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
import hashlib
from collections import deque
import psutil
from .campaign_resources import ResourceMonitor,admission,pressure,terminate_tree

ROOT=Path(__file__).resolve().parents[1]
RUNS=ROOT/'ml_training/runs/official'
CURRENT=ROOT/'ml_training/runs/campaign/current'
FLAGS=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
TRACKS=['Sunset Speedway','Meadow Park','Blue Bay Run','Hurricane Pass','Riviera GP','Titan Loop','Amber Highway','Neon City GP']
SOURCE_FILES=['index.html','sim/official-policy.mjs','sim/official-contract.mjs','ml_training/official-worker.mjs','ml_training/official_environment.py','ml_training/official_train.py','ml_training/campaign.py','ml_training/campaign_resources.py','ml_training/campaign_validation.py','ml_training/campaign_guardian.py','scripts/campaign-browser-check.mjs']

def source_fingerprint():
    files={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in SOURCE_FILES}
    return hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest(),files

def read_json(path,default=None):
    try:return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError,ValueError):return default

def write_json(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+f'.{os.getpid()}.tmp')
    encoded=json.dumps(data,allow_nan=False)
    # Windows readers may briefly hold a handle without FILE_SHARE_DELETE.
    # A viewer read must not abort a learner or its checkpoint on rename.
    for attempt in range(12):
        try:
            temp.write_text(encoded,encoding='utf-8');os.replace(temp,path);return
        except PermissionError:
            if attempt==11:raise
            time.sleep(min(.25,.02*(attempt+1)))

def parse_deadline(value):
    date=dt.datetime.fromisoformat(value)
    if date.tzinfo is None:raise ValueError('Deadline must contain a timezone offset')
    return date.timestamp()

def owned_record(process):
    p=psutil.Process(process.pid)
    return {'pid':p.pid,'created':p.create_time()}

def run_worker(run_id):
    directory=RUNS/run_id;spec=read_json(directory/'campaign-spec.json')
    if not spec:raise ValueError('Missing campaign job specification')
    if spec.get('sourceFingerprint') and source_fingerprint()[0]!=spec['sourceFingerprint']:raise RuntimeError('Campaign source changed before worker startup')
    from .official_train import train_official,TrainingControl
    control=TrainingControl();done=threading.Event();state={'id':run_id,'official':True,'campaignOwned':True,
        'status':'queued','runName':spec['config']['runName'],'trackId':spec['track'],'difficulty':spec['difficulty'],'slot':spec['slot']}
    last_write=[0.]
    def update(fields,force=False):
        state.update(fields);state['updatedAt']=time.time()
        if control.cancelled.is_set() and state.get('status')=='running':state['status']='stopping'
        if force or time.monotonic()-last_write[0]>=1:
            last_write[0]=time.monotonic();write_json(directory/'campaign-status.json',state)
    def commands():
        parent=psutil.Process(spec['managerPid'])
        while not done.wait(1):
            action=read_json(directory/'campaign-control.json',{}).get('action')
            expired=time.time()>=spec['trainStop']
            try:parent_alive=parent.is_running() and abs(parent.create_time()-spec['managerCreated'])<.1
            except psutil.Error:parent_alive=False
            if action=='stop' or expired or not parent_alive:
                control.cancelled.set();control.running.set()
            elif action=='pause':control.running.clear()
            else:control.running.set()
    threading.Thread(target=commands,daemon=True).start();update({},True)
    try:
        result=train_official(spec['config'],update,control,directory)
        update(result,True)
    except Exception:
        import traceback
        update({'status':'failed','error':traceback.format_exc()},True)
        (directory/'campaign-error.txt').write_text(state['error'],encoding='utf-8')
    finally:done.set()

class Capacity:
    def __init__(self):self.target=1;self.changed=time.time();self.baseline=None;self.trial=False;self.cooldown=0
    def decide(self,now,count,rate,resources):
        if now-self.changed<120:return None
        if self.trial:
            self.trial=False
            if rate<self.baseline*1.10:
                self.target=max(1,count-1);self.cooldown=now+600;self.changed=now
                return 'retract'
            self.changed=now
            return 'keep'
        if count==self.target and count<4 and now>=self.cooldown and rate>0 and admission(resources):
            self.baseline=rate;self.trial=True;self.target=count+1;self.changed=now
            return 'add'
        return None

def rank(metrics):
    from .official_train import score
    return score(metrics or {})

def checkpoint_for(run_id,track,difficulty,best=True):
    path=RUNS/run_id/f'track-{track}'/difficulty/('best.zip' if best else 'last.zip')
    return path if path.exists() else None

class Campaign:
    def __init__(self,deadline):
        CURRENT.mkdir(parents=True,exist_ok=True);self.deadline=deadline;self.train_stop=deadline-3600;self.validation_stop=deadline-900
        saved=read_json(CURRENT/'state.json')
        if saved and saved['deadline']!=deadline:raise ValueError('Existing campaign has a different deadline; archive it explicitly before starting another')
        self.state=saved or {'deadline':deadline,'trainStop':self.train_stop,'validationStop':self.validation_stop,
            'startedAt':time.time(),'tasks':[],'runs':[],'bests':{},'events':[],'validations':{},'phase':'preparing'}
        for record in self.state['runs']:
            if record.get('active'):terminate_tree(record['pid'],record['created']);record['active']=False
            if not record.get('endedAt'):
                task=next((t for t in self.state['tasks'] if t['id']==record['task']),None)
                status=read_json(RUNS/record['id']/'campaign-status.json',{})
                if task:
                    task['remaining']=max(0,task['remaining']-min(task['remaining'],status.get('elapsedSeconds',0)))
                    if checkpoint_for(record['id'],task['track'],task['difficulty'],False):task['resume']=record['id']
                record['endedAt']=time.time()
        for task in self.state['tasks']:
            if task['status']=='running':task['status']='queued'
        self.processes={};self.monitor=ResourceMonitor();self.capacity=Capacity();self.history=deque(maxlen=30);self.last_resource_stop=0;self.windows=set();self.pressure_count=0
        self.state.update(managerPid=os.getpid(),managerCreated=psutil.Process().create_time(),phase='training')
        self.source_hash,source_files=source_fingerprint();self.state['sourceFingerprint']=self.source_hash
        snapshot=CURRENT/'source'/self.source_hash
        for name in SOURCE_FILES:
            target=snapshot/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,target)
        write_json(snapshot/'fingerprints.json',source_files)
        self.scan_existing()
        if not self.state['tasks']:
            for track in [1,2,3,4,5,6,7,0]:self.add_task(track,'extreme','solo',2700,42)
        self.save()
    def event(self,message):
        self.state['events'].append({'at':time.time(),'message':message});self.state['events']=self.state['events'][-100:]
        with (CURRENT/'events.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(self.state['events'][-1])+'\n')
    def save(self):write_json(CURRENT/'state.json',self.state)
    def scan_existing(self):
        from .official_train import ROOT as root
        import re
        contract=(ROOT/'sim/official-contract.mjs').read_text(encoding='utf-8');physics=re.search(r'PHYSICS_HASH="([a-f0-9]+)"',contract)[1]
        for path in RUNS.glob('*/track-*.kartai.json'):
            if read_json(path.parent/'campaign-spec.json',{}).get('config',{}).get('testOnly'):continue
            pack=read_json(path,{})
            if pack.get('physicsHash')!=physics:continue
            for difficulty,model in pack.get('variants',{}).items():
                m=model.get('evaluation',{})
                if not m or m.get('cancelled') or not checkpoint_for(path.parent.name,pack['trackId'],difficulty):continue
                key=f"{pack['trackId']}:{difficulty}:"+('race' if model.get('training',{}).get('racecraft') else 'solo')
                old=self.state['bests'].get(key)
                if not old or rank(m)>rank(old['metrics']):self.state['bests'][key]={'run':path.parent.name,'track':pack['trackId'],'difficulty':difficulty,'stage':'solo','metrics':m}
    def add_task(self,track,difficulty,stage,seconds,seed=42):
        task={'id':uuid.uuid4().hex,'track':track,'difficulty':difficulty,'stage':stage,'remaining':seconds,'seed':seed,'status':'queued','retries':0,'resume':None}
        self.state['tasks'].append(task);return task
    def spawn(self,task,slot):
        run_id=uuid.uuid4().hex;directory=RUNS/run_id;directory.mkdir(parents=True)
        chunk=min(1200,task['remaining']);variation=task['seed']!=42
        config={'trackIds':[task['track']],'allDifficulties':False,'difficulty':task['difficulty'],
            'budgetMode':'time','durationSeconds':max(1,chunk),'numEnvs':64,'workers':3,'torchThreads':1,
            'device':'cuda','cudaMemoryFraction':.125,'horizon':128,'batchSize':512 if variation else 2048,
            'learningRate':1e-4 if variation else 3e-4,'preparedCore':True,'recordPartials':True,'hardwareTelemetry':False,
            'racecraft':task['stage'] in ('race','difficulty'),'traffic':0,'evaluationEpisodes':3,'evaluationSeed':20261102,
            'checkpointEvery':500000,'seed':task['seed'],'runName':f"Campaign {task['stage']} {task['difficulty']} seed {task['seed']}"}
        if task['resume'] and checkpoint_for(task['resume'],task['track'],task['difficulty'],False):config['resumeRun']=str(RUNS/task['resume'])
        else:
            base=self.state['bests'].get(f"{task['track']}:{task['difficulty']}:solo") or self.state['bests'].get(f"{task['track']}:extreme:solo")
            if base:
                path=checkpoint_for(base['run'],task['track'],base['difficulty'])
                if path:config['warmStartCheckpoint']=str(path)
        spec={'config':config,'sourceFingerprint':self.source_hash,'track':task['track'],'difficulty':task['difficulty'],'slot':slot,
            'trainStop':self.train_stop,'managerPid':os.getpid(),'managerCreated':self.state['managerCreated']}
        write_json(directory/'campaign-spec.json',spec)
        output=(directory/'campaign-worker.log').open('a',encoding='utf-8')
        p=subprocess.Popen([sys.executable,'-m','ml_training.campaign','--worker',run_id],cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,creationflags=FLAGS);output.close()
        record={**owned_record(p),'id':run_id,'task':task['id'],'track':task['track'],'difficulty':task['difficulty'],'stage':task['stage'],'slot':slot,'trackName':TRACKS[task['track']],'active':True,'startedAt':time.time(),'stopRequested':False}
        if not any(r.get('active') for r in self.state['runs']):self.capacity.changed=time.time()
        self.state['runs'].append(record);task['status']='running';self.processes[run_id]=p;self.event(f"Started {TRACKS[task['track']]} {task['difficulty']} {task['stage']} in slot {slot+1}")
        self.save();self.open_window(slot)
    def open_window(self,slot):
        if slot in self.windows:return
        connection=read_json(RUNS/'connection-8766.json',{})
        if not connection.get('pairingCode'):return
        url=f"http://127.0.0.1:8766/ui/campaign.html?slot={slot}&trainerCode={connection['pairingCode']}"
        edge=Path(os.environ.get('PROGRAMFILES(X86)','C:/Program Files (x86)'))/'Microsoft/Edge/Application/msedge.exe'
        if edge.exists():subprocess.Popen([str(edge),'--new-window',url],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        else:
            import webbrowser
            webbrowser.open(url,new=1)
        self.windows.add(slot)
    def stop(self,record,reason):
        if record.get('stopRequested'):return
        record.update(stopRequested=True,stopAt=time.time(),stopReason=reason)
        write_json(RUNS/record['id']/'campaign-control.json',{'action':'stop'})
        self.event(f"Checkpoint/stop requested for slot {record['slot']+1}: {reason}")
    def collect(self):
        for record in self.state['runs']:
            if not record.get('active'):continue
            p=self.processes.get(record['id'])
            if p is None:continue
            status=read_json(RUNS/record['id']/'campaign-status.json',{})
            record['status']=status.get('status','starting');record['steps']=status.get('completedSteps',0)
            record['attempts']=status.get('attempts',0);record['phase']=status.get('phase','starting');record['metrics']=status.get('evaluation');record['updatedAt']=status.get('updatedAt',record['startedAt'])
            if record.get('stopRequested') and time.time()-record['stopAt']>90:terminate_tree(record['pid'],record['created'])
            if time.time()-record['updatedAt']>180:self.stop(record,'worker-stalled')
            if p.poll() is None:continue
            p.wait();record['active']=False;record['endedAt']=time.time()
            task=next(t for t in self.state['tasks'] if t['id']==record['task'])
            elapsed=min(task['remaining'],status.get('elapsedSeconds',0));task['remaining']=max(0,task['remaining']-elapsed)
            if checkpoint_for(record['id'],task['track'],task['difficulty'],False):task['resume']=record['id']
            package=read_json(RUNS/record['id']/f"track-{task['track']}.kartai.json",{})
            model=package.get('variants',{}).get(task['difficulty'],{});metrics=model.get('evaluation',{})
            if metrics and not metrics.get('cancelled'):
                key=f"{task['track']}:{task['difficulty']}:{task['stage']}";old=self.state['bests'].get(key)
                if not old or rank(metrics)>rank(old['metrics']):self.state['bests'][key]={'run':record['id'],'track':task['track'],'difficulty':task['difficulty'],'stage':task['stage'],'metrics':metrics}
            failed=status.get('status')=='failed' or (p.returncode!=0 and not record.get('stopRequested'))
            if failed:task['retries']+=1;self.event(f"Worker failed: {status.get('error','see worker log')[-500:]}")
            task['status']='blocked' if task['retries']>2 else 'done' if task['remaining']<2 else 'queued'
            if task['status']=='done' and task['stage']=='solo':
                best=self.state['bests'].get(f"{task['track']}:extreme:solo",{})
                if best.get('metrics',{}).get('finishRate',0)>=.95 and not any(t['track']==task['track'] and t['stage']=='race' for t in self.state['tasks']):self.add_task(task['track'],'extreme','race',3600)
            self.event(f"Saved slot {record['slot']+1}; task {task['status']}, {task['remaining']:.0f}s remaining")
    def queued(self):
        busy={(r['track'],r['difficulty']) for r in self.state['runs'] if r.get('active')}
        candidates=[t for t in self.state['tasks'] if t['status']=='queued' and (t['track'],t['difficulty']) not in busy]
        return sorted(candidates,key=lambda t:({'solo':0,'race':1,'challenger':2,'difficulty':3}[t['stage']],t['remaining']))
    def more_tasks(self):
        if any(t['status'] in ('queued','running') for t in self.state['tasks']):return
        # First provide one independent challenger per track, with weak tracks first.
        weak=sorted(range(8),key=lambda i:rank(self.state['bests'].get(f'{i}:extreme:solo',{}).get('metrics',{})))
        for track in weak:
            if not any(t['track']==track and t['stage']=='challenger' for t in self.state['tasks']):self.add_task(track,'extreme','challenger',1200,137)
        if self.queued():return
        # Additional difficulties only after Extreme coverage and racecraft tasks.
        if all(self.state['bests'].get(f'{i}:extreme:solo',{}).get('metrics',{}).get('finishRate',0)>=.95 for i in range(8)):
            for difficulty in ['hard','medium','easy','ultraeasy']:
                for track in range(8):
                    if not any(t['track']==track and t['difficulty']==difficulty for t in self.state['tasks']):self.add_task(track,difficulty,'difficulty',1200)
        if not self.queued():
            for track in weak:
                count=sum(t['track']==track and t['stage']=='challenger' for t in self.state['tasks'])
                if count<6:self.add_task(track,'extreme','challenger',1200,137 if count%2==0 else 42)
    def disk_used(self):
        total=0
        for record in self.state['runs']:
            for path in (RUNS/record['id']).rglob('*'):
                try:
                    if path.is_file():total+=path.stat().st_size
                except OSError:pass
        for path in CURRENT.rglob('*'):
            try:
                if path.is_file():total+=path.stat().st_size
            except OSError:pass
        return total/1024**3
    def status(self,resources,rate):
        active=[r for r in self.state['runs'] if r.get('active')]
        summary={k:self.state[k] for k in ['deadline','trainStop','validationStop','startedAt','phase','bests','events','validations']}
        summary.update(updatedAt=time.time(),active=active,activeCount=len(active),targetSlots=self.capacity.target,
            queuedCount=sum(t['status']=='queued' for t in self.state['tasks']),resources=resources,aggregateStepsPerSecond=rate,recordingsGiB=self.disk_used())
        write_json(CURRENT/'status.json',summary);self.save()
    def run(self):
        watchdog=subprocess.Popen([sys.executable,'-m','ml_training.campaign','--watchdog'],cwd=ROOT,creationflags=FLAGS,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.event(f'Independent deadline watchdog PID {watchdog.pid}')
        failed=False
        try:
            while time.time()<self.deadline:
                self.collect();now=time.time();action=read_json(CURRENT/'control.json',{}).get('action','run')
                active=[r for r in self.state['runs'] if r.get('active')]
                resources=self.monitor.sample([r['pid'] for r in active]);problem=pressure(resources)
                if source_fingerprint()[0]!=self.source_hash:problem='source-changed'
                if os.name=='nt':ctypes.windll.kernel32.SetThreadExecutionState(0x80000001 if resources.get('onMains') else 0x80000000)
                if self.disk_used()>=45:problem='recording-cap'
                self.history.append((now,{r['id']:r.get('steps',0) for r in active}))
                old=next((v for v in self.history if now-v[0]<=60),self.history[0]);elapsed=max(1,now-old[0])
                rate=sum(max(0,r.get('steps',0)-old[1].get(r['id'],r.get('steps',0))) for r in active)/elapsed
                self.state['phase']='paused' if action=='pause' or problem else 'training' if now<self.train_stop else 'validating'
                if action in ('stop','pause') or now>=self.train_stop or problem in ('unplugged','disk-reserve','recording-cap','source-changed'):
                    for r in active:self.stop(r,problem or (action if action in ('stop','pause') else 'training-cutoff'))
                elif problem:
                    self.pressure_count+=1
                    critical=problem in ('ram-pressure','shared-gpu-memory','vram-pressure')
                    if self.pressure_count>=(1 if critical else 2) and active and now-self.last_resource_stop>(5 if critical else 20):
                        self.stop(active[-1],problem);self.capacity.target=max(1,len(active)-1);self.capacity.changed=now;self.last_resource_stop=now
                else:
                    self.pressure_count=0
                    if now<self.train_stop:
                        if active and all(r.get('phase')=='learning' and not r.get('stopRequested') for r in active):
                            decision=self.capacity.decide(now,len(active),rate,resources)
                            if decision:self.event(f'Capacity {decision}; aggregate {rate:.0f} steps/s, target {self.capacity.target}')
                            if decision=='retract':self.stop(active[-1],'no-throughput-benefit')
                        if not any(r.get('stopRequested') for r in active):
                            self.more_tasks()
                            while len(active)<self.capacity.target and self.queued():
                                if len(active)>0 and not admission(resources):break
                                if any(r.get('phase') not in ['learning','evaluation','checkpoint-saved'] for r in active):break
                                task=self.queued()[0];slot=next(i for i in range(4) if i not in {r['slot'] for r in active});self.spawn(task,slot)
                                active=[r for r in self.state['runs'] if r.get('active')]
                self.status(resources,rate)
                if action=='stop' and not active:break
                if problem=='recording-cap' and not active:self.validate_all();break
                if now>=self.train_stop and not active:
                    self.validate_all();break
                time.sleep(5)
        except Exception as exc:
            failed=True;self.state['failure']=repr(exc);self.event('Controller failure: '+repr(exc));raise
        finally:
            for record in self.state['runs']:
                if record.get('active'):self.stop(record,'campaign-exit')
            # Saving normally takes seconds; the independent watchdog still owns the hard cutoff.
            end=min(self.deadline,time.time()+90)
            while time.time()<end and any(r.get('active') for r in self.state['runs']):self.collect();time.sleep(1)
            for record in self.state['runs']:
                if record.get('active'):terminate_tree(record['pid'],record['created']);record['active']=False
            self.state['phase']='failed' if failed else 'finished';self.status(self.monitor.sample(),0);self.monitor.close()
            if os.name=='nt':ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
    def validate_all(self):
        # Run final acceptance in isolated processes so a bad policy cannot hold
        # the campaign past the validation/deadline reserves.
        if source_fingerprint()[0]!=self.source_hash:self.event('Validation blocked because source changed');return
        keys=sorted(self.state['bests'],key=lambda k:('extreme' not in k,':race' not in k,k))
        for key in keys:
            if time.time()>=self.validation_stop or read_json(CURRENT/'control.json',{}).get('action')=='stop':break
            resource=self.monitor.sample()
            if pressure(resource) or self.disk_used()>=50:self.event('Final validation deferred: resource/recording guard');break
            best=self.state['bests'][key];run_id=best['run'];track=best['track'];difficulty=best['difficulty']
            token=key.replace(':','-');report=CURRENT/f'validation-{token}.json'
            log=(CURRENT/f'validation-{token}.log').open('w',encoding='utf-8')
            p=subprocess.Popen([sys.executable,'-m','ml_training.campaign_validation','--run',run_id,'--track',str(track),'--difficulty',difficulty,'--output',str(report)],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=FLAGS);log.close()
            record={**owned_record(p),'id':'validation-'+token,'active':True,'validation':True};self.state['validator']=record;self.save()
            end=min(time.time()+240,self.validation_stop)
            while p.poll() is None and time.time()<end and read_json(CURRENT/'control.json',{}).get('action')!='stop':time.sleep(1)
            if p.poll() is None:terminate_tree(p.pid,record['created'])
            record['active']=False
            result=read_json(report,{'approved':False,'reason':'validation incomplete; see log'})
            self.state['validations'][key]=result
            self.event(f'Validation {key}: '+('approved' if result.get('approved') else 'not approved'))
            self.status(resource,0)
        self.export_champions()

    def export_champions(self):
        packages={};champions={}
        for track in range(8):
            for difficulty in ['extreme','hard','medium','easy','ultraeasy']:
                rows=[r for r in self.state['validations'].values() if r.get('track')==track and r.get('difficulty')==difficulty]
                solo=self.state['validations'].get(f'{track}:{difficulty}:solo',{})
                eligible=[]
                for r in rows:
                    if not r.get('approved'):continue
                    baseline=solo.get('native',{}).get('modes',{})
                    modes=r.get('native',{}).get('modes',{})
                    if any(baseline.get(mode,{}).get('candidateMedian') and modes.get(mode,{}).get('candidateMedian',1e9)>baseline[mode]['candidateMedian']*1.03 for mode in ['ai','shootout']):
                        r['approved']=False;r.setdefault('reasons',[]).append('more than 3% slower than the solo candidate');continue
                    eligible.append(r)
                if not eligible:continue
                chosen=min(eligible,key=lambda r:(sum(x.get('contacts',0) for x in r['racecraft'].values()),sum(x['candidateMedian'] for x in r['native']['modes'].values())))
                source=read_json(RUNS/chosen['run']/f'track-{track}.kartai.json')
                if track not in packages:
                    packages[track]={**source,'variants':{},'name':TRACKS[track]+' · Approved campaign 2026-11-02','createdAt':int(time.time()*1000),'humanLevelClaimed':False,'bestPossibleClaimed':False}
                packages[track]['variants'][difficulty]=source['variants'][difficulty]
                champions[f'{track}:{difficulty}']={'sourceRun':chosen['run'],'validation':chosen}
        destination=ROOT/'ai-models/approved';destination.mkdir(parents=True,exist_ok=True)
        for track,package in packages.items():
            write_json(destination/f'track-{track}.kartai.json',package)
            exported=RUNS/uuid.uuid4().hex;write_json(exported/f'track-{track}.kartai.json',package)
        manifest={'deadline':self.deadline,'exportedAt':time.time(),'conditions':'dry / stock / medium tyres','champions':champions,'allResults':self.state['validations'],'note':'Best verified candidates found within this campaign budget. No automatic activation, git commit or push.'}
        write_json(destination/'campaign-2026-11-02.json',manifest);self.state['champions']={k:{'sourceRun':v['sourceRun']} for k,v in champions.items()};self.save()

def watchdog():
    state=read_json(CURRENT/'state.json',{})
    if not state:return
    deadline=state['deadline'];pid=state['managerPid'];created=state['managerCreated']
    while time.time()<deadline-60:
        current=read_json(CURRENT/'state.json',{})
        if current.get('managerPid')!=pid or abs(current.get('managerCreated',0)-created)>.1:return
        if current.get('phase')=='finished':return
        try:alive=psutil.Process(pid).is_running() and abs(psutil.Process(pid).create_time()-created)<.1
        except psutil.Error:alive=False
        if not alive:break
        time.sleep(min(10,max(.1,deadline-time.time())))
    current=read_json(CURRENT/'state.json',{})
    if current.get('managerPid')!=pid or abs(current.get('managerCreated',0)-created)>.1:return
    for r in current.get('runs',[]):
        if r.get('active'):terminate_tree(r['pid'],r['created'])
    validator=current.get('validator',{})
    if validator.get('active'):
        # Validation's command line is separate from the training worker.
        try:
            p=psutil.Process(validator['pid'])
            if abs(p.create_time()-validator['created'])<.1 and 'ml_training.campaign_validation' in ' '.join(p.cmdline()):
                for child in p.children(recursive=True):child.kill()
                p.kill()
        except psutil.Error:pass
    terminate_tree(pid,created)
    current['phase']='deadline-stopped' if time.time()>=deadline-60 else 'manager-failed'
    for r in current.get('runs',[]):r['active']=False
    write_json(CURRENT/'state.json',current)
    summary=read_json(CURRENT/'status.json',{});summary.update(phase=current['phase'],active=[],activeCount=0,updatedAt=time.time());write_json(CURRENT/'status.json',summary)
    write_json(CURRENT/'watchdog-result.json',{'stoppedAt':time.time(),'deadline':deadline,'reason':'deadline-or-manager-exit'})

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--deadline',default='2026-11-03T04:00:00+11:00');parser.add_argument('--worker');parser.add_argument('--watchdog',action='store_true');parser.add_argument('--validate-only',action='store_true')
    args=parser.parse_args()
    if args.worker:
        if len(args.worker)!=32 or any(c not in '0123456789abcdef' for c in args.worker):raise ValueError('Invalid owned run ID')
        run_worker(args.worker)
    elif args.watchdog:watchdog()
    else:
        deadline=parse_deadline(args.deadline)
        if time.time()>=deadline-3600 and not args.validate_only:raise ValueError('Training cutoff has already passed')
        if args.validate_only and time.time()>=deadline-900:raise ValueError('Validation cutoff has already passed')
        state=read_json(CURRENT/'state.json',{})
        if state.get('phase')!='finished' and state.get('managerPid'):
            try:
                p=psutil.Process(state['managerPid'])
                if p.is_running() and abs(p.create_time()-state['managerCreated'])<.1:raise RuntimeError('Campaign is already running')
            except psutil.NoSuchProcess:pass
        Campaign(deadline).run()

if __name__=='__main__':main()
