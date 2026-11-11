"""V3 taught driving through native Race physics. No promotion based on fit loss."""
from __future__ import annotations
import copy
import gzip
import json
import math
import random
import statistics
import time
from pathlib import Path
import numpy as np
import torch
from .official_environment_v2 import EnergyVecEnv
from .official_train import export_policy,save_checkpoint
from .official_train_v2 import new_policy,write_json,evaluate
from .trajectory_archive import write_record
from .specialist_quality import cases,clean,quality
from .independent_ppo import IndependentPPO,INITIALIZATION_LOCK

REVISION='v3-taught-specialists-3'

def driving_summary(row):return {k:v for k,v in row.items() if k not in ['miniSectors','cornerDiagnostics']}

def configuration(track,difficulty,specialist,seed=42,device='cuda'):
    return dict(trackId=track,difficulty=difficulty,specialist=specialist,revision=3,nativeRace=True,
        streamTrajectories=True,recordObservations=True,numEnvs=1,workers=1,seed=seed,device=device,
        gamma=.9995,trainingMode='shootout' if specialist=='shootout' else 'ai',mode='shootout' if specialist=='shootout' else 'ai',
        racecraft=False,randomization=False,lineGuidance=False,horizon=512,batchSize=512,
        learningRate=5e-5,targetKL=.015,episodeSeconds=0,initialLogStd=[-2.,-2.,-2.,-1.5])

def result_row(info,case,config):
    row={k:v for k,v in info.items() if k not in ['trajectory','terminal_observation','episode','rewardComponents']}
    row.update(case);row.update(trackId=config['trackId'],difficulty=config['difficulty'],specialist=config['specialist'],revision=REVISION)
    return row

def drive(env,case,config,*,model=None,teacher=False,beta=0.,rng=None,archive=None,labels=None,progress=None,control=None):
    env.configure(racecraft=case['scenario']!='solo',scenario=case['scenario'])
    obs=env.fixed_reset(case['mode'],**{k:v for k,v in case.items() if k!='mode'})
    while True:
        if control and not control.check():
            if archive:
                for batch in env.batches:
                    for partial in batch.call({'command':'partials'})['episodes']:
                        points=partial.pop('trajectory',[]);write_record(archive,{'result':partial},points)
            raise InterruptedError('Checkpointed stop requested')
        expert=env.expert_actions() if teacher or labels is not None else None
        if labels is not None:labels(obs[0].copy(),expert[0].copy())
        action=expert if teacher or beta and (rng or random).random()<beta else model.predict(obs,deterministic=True)[0]
        obs,rewards,done,infos=env.step(action)
        if progress:progress(env,infos[0])
        if done[0]:
            row=result_row(infos[0],case,config)
            if archive:
                env.recorded_attempts=getattr(env,'recorded_attempts',0)+1
                write_record(archive,{**row,'attempt':env.recorded_attempts},env.completed_trajectory)
            return row

def rank(rows,specialist):
    valid=[r for r in rows if clean(r,specialist)]
    return (len(valid),-sum(r.get('contacts',0) for r in rows),-sum(r['raceTime'] for r in valid))

def calibrate_teacher(config,directory,control=None,progress=None):
    """Try both existing teachers with conservative braking before collecting data."""
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    ready=directory/'teacher.json'
    if ready.exists():return json.loads(ready.read_text(encoding='utf-8'))
    env=EnergyVecEnv(config);trials=[];winner=None;winner_time=float('inf')
    try:
        # Parameters have 12 spatial knots each for line, speed and battery.
        pace={'extreme':1.,'hard':.9,'medium':.76,'easy':.62,'ultraeasy':.5}[config['difficulty']]
        probes=[dict(teacherSource='legacy',teacherSpeedScale=pace)]
        for classic in [False,True]:
            for speed in [.5,.65,.8,.4]:
                # Read geometry-derived outside/apex offsets from the fixed profile.
                profile=env.batches[0].call({'command':'profile'})['profile']
                limit=max(1,profile['width']/2-24);ref=profile['reference']
                offsets=[ref[int(i/12*len(ref))]['offset']/limit if classic else 0 for i in range(12)]
                probes.append(dict(teacherSource='planner',teacherParameters=offsets+[speed]*12+[-1]*12+[160,.55,.16,3.2],teacherSpeedScale=pace))
        pilot=cases(config['specialist'],3,'training',seed=11)
        for trial_id,probe in enumerate(probes):
            env.configure(**probe);rows=[]
            for case_index,case in enumerate(pilot):
                case={**case,'raceLaps':1,'scenario':'solo','energy':[.25,.5,1.][case_index]}
                row=drive(env,case,config,teacher=True,archive=directory/f'probe-{trial_id}.jsonl.gz',control=control,progress=progress)
                rows.append(row)
                if row['offTrackRate']>0 or not clean(row,config['specialist']) or row['contacts']:break
            trials.append(dict(probe=probe,cases=rows))
            if len(rows)==3 and all(clean(r,config['specialist']) and r['offTrackRate']==0 and r['contacts']==0 for r in rows):
                elapsed=sum(r['raceTime'] for r in rows)
                if elapsed<winner_time:winner=probe;winner_time=elapsed
        write_json(directory/'calibration.json',{'trials':trials,'passed':winner is not None})
        if winner is None:raise RuntimeError('Neither native teacher completed this track cleanly. Reference/braking repair required; RL was not started.')
        env.configure(**winner)
        # Freeze timing baselines from subsequent accepted demonstrations.
        profile=env.batches[0].call({'command':'profile'})['profile']
        if winner.get('teacherParameters'):
            drive(env,pilot[0]|{'raceLaps':1,'scenario':'solo'},config,teacher=True,control=control)
            profile=env.batches[0].call({'command':'teacher-plan'})['plan']['profile']
        result={'revision':REVISION,'teacher':winner,'profile':profile,'calibrationCost':{'decisions':sum(r.get('decisions',0) for t in trials for r in t['cases']),'episodes':sum(len(t['cases']) for t in trials)},'note':'Accepted only after native, contact-free, zero-off-track completed demonstrations. Teacher cost is separate from RL budget.'}
        write_json(ready,result);return result
    finally:env.close()

class BalancedExamples:
    """Bounded stratified reservoir; on-disk recordings retain every original point."""
    def __init__(self,seed=42,per_group=30000):self.rng=random.Random(seed);self.groups=[[],[],[]];self.seen=[0]*3;self.limit=per_group
    def add(self,obs,action):
        group=0 if action[2]>-.7 else 1 if abs(action[0])>.15 else 2
        self.seen[group]+=1;rows=self.groups[group];pair=(np.asarray(obs,dtype=np.float32),np.asarray(action,dtype=np.float32))
        if len(rows)<self.limit:rows.append(pair)
        else:
            j=self.rng.randrange(self.seen[group])
            if j<len(rows):rows[j]=pair
    def arrays(self):
        present=[g for g in self.groups if g]
        if not present:raise ValueError('No examples')
        n=min(self.limit,max(map(len,present)));rows=[self.rng.choice(g) for g in present for _ in range(n)]
        return np.asarray([r[0] for r in rows]),np.asarray([r[1] for r in rows])

def clone_balanced(model,examples,seed,seconds=90):
    from .pace_distill import clone_actor
    obs,actions=examples.arrays()
    with INITIALIZATION_LOCK:
        return clone_actor(model,obs,actions,epochs=160,seconds=seconds,seed=seed)

def collect_demonstrations(config,teacher,directory,control=None,progress=None,count=36):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True);examples=BalancedExamples(config['seed']);baselines=[];rows=[]
    env=EnergyVecEnv({**config,**teacher['teacher'],'lineProfile':teacher['profile'],'recordObservations':True})
    try:
        # Demonstration seeds and states are disjoint from selection and final banks.
        for i,case in enumerate(cases(config['specialist'],count,'training',config['seed'])):
            case={**case,'scenario':'solo'}
            row=drive(env,case,config,teacher=True,archive=directory/'teacher-attempts.jsonl.gz',control=control,progress=progress)
            accepted=clean(row,config['specialist']) and row['contacts']==0 and row['offTrackRate']==0
            row['acceptedDemonstration']=accepted;rows.append(row)
            if not accepted:continue
            # Only successful clean episodes become cloning data. Failed-state
            # correction labels are saved to their own archive in DAgger.
            for p in env.completed_trajectory:
                if p.get('rawAction') is not None:examples.add(p['observation'],p['rawAction'])
            baselines.extend(w for w in row.get('miniSectors',{}).get('windows',[]) if w.get('valid') and not w.get('partial'))
        write_json(directory/'demonstrations.json',{'cases':rows,'accepted':sum(r['acceptedDemonstration'] for r in rows),'sampleCounts':examples.seen})
        if not any(r['acceptedDemonstration'] for r in rows):raise RuntimeError('Teacher produced no valid demonstrations; no student trained')
        profile=copy.deepcopy(teacher['profile']);profile['baselines']=teacher['profile'].get('baselines') or baselines;profile['calibration']={'complete':True,'native':True,'revision':REVISION};write_json(directory/'reference-profile.json',profile)
        return examples,profile,env.metadata
    finally:env.close()

def critic_warmup(model,config,control=None,steps=2048):
    """Frozen actor, separate environment; fit returns before PPO starts."""
    actor=list(model.policy.mlp_extractor.policy_net.parameters())+list(model.policy.action_net.parameters())+[model.policy.log_std]
    before=[p.detach().clone() for p in actor]
    params=list(model.policy.mlp_extractor.value_net.parameters())+list(model.policy.value_net.parameters())
    optimizer=torch.optim.Adam(params,lr=3e-4);obs_rows=[];rewards=[];dones=[]
    env=EnergyVecEnv({**config,'recordObservations':False})
    try:
        obs=env.reset()
        for _ in range(steps):
            if control and not control.check():raise InterruptedError()
            obs_rows.append(obs[0].copy());action,_=model.predict(obs,deterministic=True);obs,reward,done,_=env.step(action);rewards.append(float(reward[0]));dones.append(bool(done[0]))
        with torch.no_grad():value=float(model.policy.predict_values(torch.as_tensor(obs,device=model.device)).item())
        targets=[]
        for reward,done in zip(reversed(rewards),reversed(dones)):
            value=reward+config['gamma']*value*(not done);targets.append(value)
        x=torch.as_tensor(np.asarray(obs_rows),device=model.device);y=torch.as_tensor(list(reversed(targets)),device=model.device,dtype=torch.float32)
        for _ in range(12):
            for ids in torch.randperm(len(x),device=model.device).split(256):
                loss=torch.nn.functional.mse_loss(model.policy.predict_values(x[ids]).flatten(),y[ids]);optimizer.zero_grad();loss.backward();torch.nn.utils.clip_grad_norm_(params,1.);optimizer.step()
        if any(not torch.equal(a,p) for a,p in zip(before,actor)):raise RuntimeError('Critic warmup changed actor')
        # Changed objectives never inherit a PPO optimizer's momentum.
        model.policy.optimizer=model.policy.optimizer_class(model.policy.parameters(),lr=config.get('learningRate',5e-5),**model.policy.optimizer_kwargs)
        return {'decisions':steps,'actorUnchanged':True,'freshPpoOptimizer':True}
    finally:env.close()

def taught_seed(config,teacher,directory,control=None,progress=None):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    if (directory/'ready.json').exists():return json.loads((directory/'ready.json').read_text(encoding='utf-8'))
    examples,profile,metadata=collect_demonstrations(config,teacher,directory,control,progress)
    cfg={**config,**teacher['teacher'],'lineProfile':profile,'lineGuidance':True}
    env=EnergyVecEnv(cfg)
    try:
        model=new_policy(env,cfg,policy_class=IndependentPPO)
        if cfg.get('seedPackage'):
            from .policy_seed import import_actor
            import_actor(model,json.loads(Path(cfg['seedPackage']).read_text(encoding='utf-8')),metadata,cfg['difficulty'])
        with torch.no_grad():model.policy.log_std.fill_(-2.)
        selection=cases(config['specialist'],12,'selection',config['seed'])
        # Traffic comes only after a 100-case solo gate. This first fit is driving school.
        selection=[c|{'scenario':'solo'} for c in selection]
        def score(label):return [driving_summary(drive(env,c,cfg,model=model,archive=directory/f'{label}.jsonl.gz',control=control,progress=progress)) for c in selection]
        prior=score('selection-saved-actor') if cfg.get('seedPackage') else None
        prior_state=copy.deepcopy(model.policy.state_dict()) if prior else None
        fits=[clone_balanced(model,examples,config['seed'])];corrections=[]
        save_checkpoint(model,directory/'imitation-latest.zip')
        best_rows=score('selection-initial');best_state=copy.deepcopy(model.policy.state_dict())
        if prior and rank(prior,config['specialist'])>rank(best_rows,config['specialist']):best_rows=prior;best_state=prior_state
        for round_id,beta in enumerate([.5,.2,0.]):
            rng=random.Random(config['seed']+round_id);extra=BalancedExamples(config['seed']+round_id)
            for c in cases(config['specialist'],6,'training',config['seed']+100+round_id):
                drive(env,c|{'scenario':'solo'},cfg,model=model,beta=beta,rng=rng,labels=extra.add,archive=directory/f'corrections-{round_id}.jsonl.gz',control=control,progress=progress)
            for group in extra.groups:
                for observation,action in group:examples.add(observation,action)
            fits.append(clone_balanced(model,examples,config['seed']+round_id+1));rows=score(f'selection-{round_id}')
            if rank(rows,config['specialist'])>rank(best_rows,config['specialist']):best_rows=rows;best_state=copy.deepcopy(model.policy.state_dict())
            corrections.append({'round':round_id+1,'beta':beta,'labels':extra.seen,'selection':rows})
            save_checkpoint(model,directory/'imitation-latest.zip');write_json(directory/'imitation-progress.json',{'rounds':round_id+1,'fits':fits,'corrections':corrections})
        model.policy.load_state_dict(best_state)
        warmup=critic_warmup(model,cfg,control)
        save_checkpoint(model,directory/'student.zip')
        result={'checkpoint':str((directory/'student.zip').resolve()),'profile':str((directory/'reference-profile.json').resolve()),'fits':fits,'correctiveRounds':corrections,'criticWarmup':warmup,'selection':best_rows,'revision':REVISION}
        write_json(directory/'ready.json',result);return result
    finally:env.close()

def solo_selection(model,config,directory,control=None):
    sample=[c|{'scenario':'solo','raceLaps':1} for c in cases(config['specialist'],100,'selection',config['seed'])]
    report=evaluate(model,config,directory,control,cases_override=sample)
    gate=quality(report['cases'],config['specialist'],100);write_json(Path(directory)/'gate.json',gate);return gate

def corrective_refresh(config,teacher,checkpoint,directory,control=None,progress=None):
    """Review a struggling taught actor on new training states, never final cases."""
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True);cfg={**config,**teacher['teacher']};env=EnergyVecEnv(cfg)
    try:
        model=IndependentPPO.load(checkpoint,env=env,device=config['device']);model.num_timesteps=int(config.get('completedDecisions',model.num_timesteps));saved=copy.deepcopy(model.policy.state_dict());data=BalancedExamples(config['seed']+123)
        sample=cases(config['specialist'],6,'selection',config['seed']+400)
        def score(name):return [driving_summary(drive(env,c,cfg,model=model,archive=directory/(name+'.jsonl.gz'),control=control,progress=progress)) for c in sample]
        before=score('before');corrections=cases(config['specialist'],6,'training',config['seed']+500)
        for case in corrections:
            drive(env,case,cfg,model=model,labels=data.add,archive=directory/'failed-state-corrections.jsonl.gz',control=control,progress=progress)
        for case in cases(config['specialist'],3,'training',config['seed']+600):
            row=drive(env,case|{'scenario':'solo','raceLaps':1},cfg,teacher=True,archive=directory/'clean-rehearsal.jsonl.gz',control=control,progress=progress)
            if clean(row,config['specialist']) and row['offTrackRate']==0 and row['contacts']==0:
                for p in env.completed_trajectory:
                    if p.get('rawAction') is not None:data.add(p['observation'],p['rawAction'])
        fit=clone_balanced(model,data,config['seed']+123,seconds=45);after=score('after');accepted=rank(after,config['specialist'])>rank(before,config['specialist'])
        if not accepted:model.policy.load_state_dict(saved)
        else:
            fresh=new_policy(env,cfg,policy_class=IndependentPPO)
            model.policy.mlp_extractor.value_net.load_state_dict(fresh.policy.mlp_extractor.value_net.state_dict());model.policy.value_net.load_state_dict(fresh.policy.value_net.state_dict());del fresh
            critic_warmup(model,cfg,control,steps=1024)
        save_checkpoint(model,directory/'corrected.zip')
        result={'accepted':accepted,'before':before,'after':after,'fit':fit,'sampleCounts':data.seen,'rlDecisions':0,'checkpoint':str((directory/'corrected.zip').resolve()),'note':'Additional imitation cost; original equal RL budgets are unchanged. Rejected corrections restore all actor weights.'}
        write_json(directory/'review.json',result);return result
    finally:env.close()

def package(config,metadata,model):
    return dict(format='kartblitz-official-track-v2',modelGeneration=2,name='V3 specialist candidate',trackId=config['trackId'],physicsHash=metadata['physicsHash'],trackFingerprint=metadata['tracks'][config['trackId']]['fingerprint'],observationVersion=2,observationCount=57,observationNames=metadata['observationNames'],actionCount=4,actionNames=metadata['actionNames'],decisionHz=20,environmentVersion=8,createdAt=int(time.time()*1000),variants={config['difficulty']:{'id':__import__('uuid').uuid4().hex,'policy':export_policy(model)}})
