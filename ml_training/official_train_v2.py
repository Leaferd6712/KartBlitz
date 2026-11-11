"""Opt-in energy training and equal-budget gamma comparison, never a V1 resume."""
from __future__ import annotations
import argparse
import gzip
import json
import statistics
import time
import uuid
from pathlib import Path
import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from .official_environment_v2 import EnergyVecEnv
from .official_train import TrainingControl,export_policy,save_checkpoint,ROOT
from .trajectory_archive import write_record

RACE_LENGTHS=[1,2,3,5,8,10]
CHARGES=[.25,.5,1.]
GAMMAS=[.995,.9995]

def write_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,allow_nan=False,indent=2),encoding='utf-8')

def campaign_is_live():
    import psutil
    try:
        state=json.loads((ROOT/'ml_training/runs/campaign/current/state.json').read_text())
        process=psutil.Process(state['managerPid'])
        return process.is_running() and abs(process.create_time()-state['managerCreated'])<.1
    except (FileNotFoundError,psutil.NoSuchProcess):return False
    # In a restricted process session AccessDenied is not evidence of exit.
    except (OSError,ValueError,KeyError,psutil.Error):return True

def new_policy(env,config,policy_class=PPO):
    torch.set_num_threads(1)
    horizon=max(16,min(512,int(config.get('horizon',256))))
    rollout=horizon*env.num_envs;batch=min(int(config.get('batchSize',2048)),rollout)
    while rollout%batch:batch-=1
    model=policy_class('MlpPolicy',env,device=config.get('device','cpu'),learning_rate=float(config.get('learningRate',1e-4)),target_kl=config.get('targetKL'),
        n_steps=horizon,batch_size=batch,n_epochs=6,gamma=float(config['gamma']),gae_lambda=.95,ent_coef=.008,
        policy_kwargs={'net_arch':{'pi':[128,128],'vf':[128,128]},'activation_fn':torch.nn.Tanh,'log_std_init':-.5},seed=int(config.get('seed',42)),verbose=0)
    with torch.no_grad():model.policy.action_net.bias[1]=.5;model.policy.action_net.bias[2]=-.8
    return model

def warm_start(model,checkpoint,track_id,physics_hash):
    """Copy common V1 weights; zero new inputs; drop DRS; fresh optimiser."""
    checkpoint=Path(checkpoint);contract=json.loads((checkpoint.parent/'contract.json').read_text())
    if contract.get('physicsHash')!=physics_hash or contract.get('trackId')!=track_id:raise ValueError('Warm start track/physics mismatch')
    old=PPO.load(checkpoint,device='cpu')
    if (old.observation_space.shape,old.action_space.shape) not in [((48,),(5,)),((57,),(4,))]:raise ValueError('Expected a compatible V1 or V2 checkpoint')
    source=old.policy.state_dict();target=model.policy.state_dict()
    for key,value in target.items():
        previous=source.get(key)
        if previous is None:raise ValueError('Unsupported warm-start architecture: '+key)
        if value.shape==previous.shape:value.copy_(previous)
        elif key in ['mlp_extractor.policy_net.0.weight','mlp_extractor.value_net.0.weight']:
            if previous.shape[0]!=value.shape[0] or previous.shape[1]!=48:raise ValueError('Unsupported first layer')
            value.zero_();value[:,:48].copy_(previous)
        elif key in ['action_net.weight','action_net.bias','log_std']:value.copy_(previous[:4])
        else:raise ValueError('Unsupported warm-start tensor: '+key)
    model.policy.load_state_dict(target)
    # A new PPO instance owns a fresh optimiser, rollout buffer and timestep counter.
    return model

def evaluation_cases(smoke=False):
    if smoke:return [{'mode':'shootout','raceLaps':1,'energy':1.,'scenario':'solo','seed':81271},
                     {'mode':'ai','raceLaps':3,'energy':.5,'scenario':'passing','seed':81272}]
    cases=[]
    for seed in [81271,91517]:
        for energy in CHARGES:cases.append({'mode':'shootout','raceLaps':1,'energy':energy,'scenario':'solo','seed':seed})
        for i,laps in enumerate(RACE_LENGTHS):cases.append({'mode':'ai','raceLaps':laps,'energy':CHARGES[i%3],'scenario':'solo','seed':seed})
        for scenario in ['passing','defending','recovery','mixed']:
            cases.append({'mode':'ai','raceLaps':3,'energy':.5,'scenario':scenario,'seed':seed})
    return cases

def summarize(rows):
    result={}
    for mode in ['shootout','ai']:
        group=[r for r in rows if r['mode']==mode];finished=[r for r in group if r['finished']]
        result[mode]={'cases':len(group),'finishRate':len(finished)/max(1,len(group)),
            'medianSecondsPerLap':statistics.median(r['raceTime']/r['raceLaps'] for r in finished) if finished else None,
            'meanPosition':statistics.mean(r['racePosition'] for r in finished) if finished else None,
            'contacts':sum(r['contacts'] for r in group),'meanOffTrackRate':statistics.mean(r['offTrackRate'] for r in group) if group else 1}
    return result

def result_rank(report):
    rows=report['cases'];finished=[r for r in rows if r['finished']]
    # Reject unsafe cases before comparing race position and whole-race pace.
    clean=sum(r['finished'] and r['offTrackRate']<.01 and not r.get('defensiveCorrections',0) for r in rows)
    return (len(finished),clean,-sum(r['racePosition'] for r in finished),-sum(r['raceTime'] for r in finished),-sum(r['contacts'] for r in rows))

def choose_result(results):
    def quality(item):
        rows=item[1]['cases'];finished=[r for r in rows if r['finished']]
        return (len(finished),sum(r['offTrackRate']<.01 for r in finished),-sum(r['contacts'] for r in rows),-sum(r['racePosition'] for r in finished))
    best=max(quality(item) for item in results);eligible=[item for item in results if quality(item)==best]
    seconds=lambda item:sum(r['raceTime'] or 0 for r in item[1]['cases'])
    fastest=min(eligible,key=seconds)
    tied=[item for item in eligible if seconds(item)<=seconds(fastest)+.05 and all((a['raceTime'] or 0)<=(b['raceTime'] or 0)+.05 for a,b in zip(item[1]['cases'],fastest[1]['cases']))]
    return max(tied,key=lambda item:sum(r.get('styleScore',0) for r in item[1]['cases']))

def evaluate(model,config,directory,control=None,smoke=False,cases_override=None):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True);rows=[]
    def finish(cancelled):
        result={'cancelled':cancelled,'cases':rows,'summary':summarize(rows)};write_json(directory/'report.json',result);return result
    if config.get('nativeRace'):config={**config,'streamTrajectories':True}
    if (directory/'attempts.jsonl.gz').exists():raise ValueError('Evaluation output already exists; use a new immutable directory')
    cfg={**config,'lineGuidance':False,'numEnvs':1,'workers':1,'randomization':False}
    env=EnergyVecEnv(cfg)
    try:
        for case_id,case in enumerate(evaluation_cases(smoke) if cases_override is None else cases_override):
            if control and not control.check():return finish(True)
            env.configure(racecraft=case['scenario']!='solo',scenario=case['scenario'])
            obs=env.fixed_reset(case['mode'],raceLaps=case['raceLaps'],energy=case['energy'],seed=case['seed'],scenario=case['scenario'],lateralOffset=case.get('lateralOffset',0),headingOffset=case.get('headingOffset',0))
            while True:
                if control and not control.check():return finish(True)
                action,_=model.predict(obs,deterministic=True);obs,_,done,infos=env.step(action)
                if done[0]:
                    row={k:v for k,v in infos[0].items() if k not in ['terminal_observation','episode','rewardComponents','trajectory']}
                    row.update(case);row.update(case=case_id,startingCharge=case['energy'])
                    write_record(directory/'attempts.jsonl.gz',{'result':row},env.completed_trajectory,index=False)
                    rows.append({k:v for k,v in row.items() if k not in ['miniSectors','cornerDiagnostics']} if config.get('revision')==3 else row);break
    finally:env.close()
    return finish(False)

def train_arm(config,directory,control=None,*,model_factory=None,progress=None,episode_progress=None):
    learner=PPO
    if config.get('revision')==3:
        from .independent_ppo import IndependentPPO
        learner=IndependentPPO
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True);config=dict(config);control=control or TrainingControl();attempts=0
    if config.get('nativeRace'):config.setdefault('streamTrajectories',True)
    if config.get('lineProfilePath'):config['lineProfile']=json.loads(Path(config['lineProfilePath']).read_text())
    if config.get('lineProfile'):write_json(directory/'reference-profile.json',config['lineProfile'])
    def record(info):
        nonlocal attempts
        attempts+=1;points=info.get('trajectory',[])
        row={k:v for k,v in info.items() if k not in ['terminal_observation','trajectory','episode']}
        row.update(attempt=attempts,trackId=config['trackId'],difficulty=config['difficulty'],modelGeneration=2,
            environmentVersion=env.metadata.get('environmentVersion',6),policyStep=model.num_timesteps,recordedAt=time.time(),points=points)
        write_record(directory/'attempts.jsonl.gz',{k:v for k,v in row.items() if k!='points'},points)
        if episode_progress:episode_progress({k:v for k,v in row.items() if k!='points'})
    env=EnergyVecEnv({**config,'mode':config.get('trainingMode','mixed'),'racecraft':config.get('racecraft',True)},record)
    if not config.get('lineProfile'):write_json(directory/'reference-profile.json',env.batches[0].call({'command':'profile'})['profile'])
    try:
        if config.get('cudaMemoryFraction') and str(config.get('device','cpu')).startswith('cuda'):
            torch.cuda.set_per_process_memory_fraction(float(config['cudaMemoryFraction']))
        model=learner.load(config['resumeCheckpoint'],env=env,device=config.get('device','cpu')) if config.get('resumeCheckpoint') else (model_factory or new_policy)(env,config)
        if config.get('resumeCheckpoint'):
            model.batch_size=min(int(config.get('batchSize',model.batch_size)),model.n_steps*env.num_envs)
        if config.get('warmStart'):warm_start(model,config['warmStart'],config['trackId'],env.physics_hash)
        if config.get('seedPackage') and not config.get('resumeCheckpoint'):
            from .policy_seed import import_actor
            seed_pack=json.loads(Path(config['seedPackage']).read_text(encoding='utf-8'))
            source=config.get('seedDifficulty',config['difficulty'])
            seed_pack['variants'][config['difficulty']]=seed_pack['variants'][source]
            import_actor(model,seed_pack,env.metadata,config['difficulty'])
        if config.get('initialLogStd') and not config.get('resumeCheckpoint'):
            with torch.no_grad():model.policy.log_std.copy_(torch.tensor(config['initialLogStd'],device=model.device))
        model.set_random_seed(int(config.get('seed',42)))
        started=control.active_time();last_save=[started];last_step=[0];seconds=config.get('seconds')
        # Checkpoint selection uses different seeds from final held-out evaluation.
        selection_cases=[{'mode':'shootout','raceLaps':1,'energy':charge,'scenario':'solo','seed':27411+i} for i,charge in enumerate([.25,1.])]+[
            {'mode':'ai','raceLaps':3,'energy':.5,'scenario':scenario,'seed':38413+i} for i,scenario in enumerate(['solo','passing'])]
        if config.get('selectionCases'):selection_cases=config['selectionCases']
        select_enabled=config.get('bestCheckpoint',float(seconds or 0)>=60 or int(config.get('steps',0))>=65536)
        selection={'report':None,'step':None,'checkedAt':started}
        def select_checkpoint():
            if not select_enabled or not control.check():return
            report=evaluate(model,config,directory/'checkpoint-selection'/(str(model.num_timesteps)+'-'+uuid.uuid4().hex[:8]),control,cases_override=selection_cases)
            selection['checkedAt']=control.active_time()
            if report['cancelled']:return
            if selection['report'] is None or choose_result([('current',report),('best',selection['report'])])[0]=='current':
                selection['report']=report;selection['step']=model.num_timesteps;save_checkpoint(model,directory/'best.zip')
                write_json(directory/'checkpoint-selection.json',{'selectedStep':selection['step'],'selectionCases':selection_cases,'report':report,'note':'Selection cases are excluded from final held-out evaluation.'})
        select_checkpoint()
        write_json(directory/'contract.json',{'modelGeneration':2,'physicsHash':env.physics_hash,'trackId':config['trackId'],'observationNames':env.metadata['observationNames'],'actionNames':env.metadata['actionNames'],'config':config})
        class Progress(BaseCallback):
            def _on_rollout_start(self):
                if control.active_time()-selection['checkedAt']>=float(config.get('selectionIntervalSeconds',120)):select_checkpoint()
            def _on_step(self):
                if not control.check():return False
                elapsed=control.active_time()-started
                if progress:progress(model,env,attempts,elapsed)
                if self.num_timesteps-last_step[0]>=8192:
                    last_step[0]=self.num_timesteps;write_json(directory/'status.json',{'phase':'learning','steps':self.num_timesteps,'attempts':attempts,'elapsedSeconds':elapsed,'gamma':config['gamma']})
                if control.active_time()-last_save[0]>=120:
                    save_checkpoint(self.model,directory/'last.zip');last_save[0]=control.active_time()
                return seconds is None or elapsed<float(seconds)
        try:model.learn(total_timesteps=int(config.get('steps',10**12)),callback=Progress(),reset_num_timesteps=not bool(config.get('resumeCheckpoint')))
        finally:
            try:env.archive_partials()
            finally:save_checkpoint(model,directory/'last.zip')
        trained_steps=model.num_timesteps
        select_checkpoint()
        if selection['step'] is not None:
            model=learner.load(directory/'best.zip',device=config.get('device','cpu'))
        pack={'format':'kartblitz-official-track-v2','modelGeneration':2,'name':f"V2 · {env.metadata['tracks'][config['trackId']]['name']} · gamma {config['gamma']}",
            'trackId':config['trackId'],'physicsHash':env.physics_hash,'trackFingerprint':env.metadata['tracks'][config['trackId']]['fingerprint'],
            'observationVersion':2,'observationCount':len(env.metadata['observationNames']),'observationNames':env.metadata['observationNames'],
            'actionCount':4,'actionNames':env.metadata['actionNames'],'decisionHz':20,'environmentVersion':env.metadata.get('environmentVersion',6),'createdAt':int(time.time()*1000),
            'variants':{config['difficulty']:{'id':uuid.uuid4().hex,'policy':export_policy(model),'training':{'algorithm':config.get('algorithm','PPO'),'gamma':config['gamma'],'steps':trained_steps,'selectedPolicyStep':model.num_timesteps,'bestCheckpointSelection':bool(select_enabled),'specialist':config.get('specialist'),'racecraft':config.get('racecraft',True),'traffic':config.get('scenario','mixed 0–3') if config.get('racecraft',True) else 'solo','warmStart':bool(config.get('warmStart')),
                'lineGuidance':config.get('lineGuidance',True),'sharedLearnerProcess':bool(config.get('sharedLearner')),'seedReproducibility':'Independent policy exploration, rollout sampling and simulator RNGs.' if config.get('revision')==3 else 'Independent simulator seeds; concurrent learners share the PyTorch exploration RNG.' if config.get('sharedLearner') else 'Separate learner process','rewardVersion':'v3-taught-corner-1' if config.get('revision')==3 else 'v2-native-line-1' if config.get('nativeRace') else 'v2-line-1','profileHash':env.metadata.get('profileHash')}}}}
        pack['name']+=' · '+('guided' if config.get('lineGuidance',True) else 'unguided')
        write_json(directory/f"track-{config['trackId']}.kartai.json",pack)
    finally:env.close()
    report=evaluate(model,config,directory/'evaluation',control,config.get('smokeEvaluation',False),cases_override=config.get('evaluationCases'))
    pack['variants'][config['difficulty']]['evaluation']={'cancelled':report['cancelled'],'finishRate':sum(r['finished'] for r in report['cases'])/max(1,len(report['cases'])),
        'medianLapTime':report['summary']['shootout']['medianSecondsPerLap'],'perMode':report['summary'],'episodes':report['cases']}
    write_json(directory/f"track-{config['trackId']}.kartai.json",pack)
    write_json(directory/'status.json',{'phase':'saved','steps':trained_steps,'selectedPolicyStep':model.num_timesteps,'attempts':attempts,'elapsedSeconds':control.active_time()-started})
    return pack,report

def main():
    parser=argparse.ArgumentParser(description='V2 only: equal-budget energy experiments; refuses to interrupt a live V1 campaign.')
    parser.add_argument('--track',type=int,required=True,choices=range(8));parser.add_argument('--difficulty',default='extreme',choices=['extreme','hard','medium','easy','ultraeasy'])
    parser.add_argument('--seconds',type=float,default=7200);parser.add_argument('--device',default='cpu',choices=['cpu','cuda']);parser.add_argument('--warm-start');parser.add_argument('--v1-package')
    parser.add_argument('--cars',type=int,default=16);parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--line-profile',help='Reuse a frozen, calibrated per-track reference profile')
    args=parser.parse_args()
    if campaign_is_live():parser.error('V1 campaign is still running. V2 was not started. Wait for it to finish.')
    if not 60<=args.seconds<=86400:parser.error('Choose 60–86400 total training seconds, shared equally across gamma/guidance arms. Calibration/evaluation take extra time.')
    directory=ROOT/'ml_training/runs/energy-v2'/uuid.uuid4().hex;directory.mkdir(parents=True)
    control=TrainingControl()
    import signal
    def stop(*_):control.cancelled.set();control.running.set()
    signal.signal(signal.SIGINT,stop);signal.signal(signal.SIGTERM,stop)
    import subprocess
    profile_path=Path(args.line_profile).resolve() if args.line_profile else directory/'reference-profile.json'
    if not args.line_profile:subprocess.run(['node','scripts/ai-training/build-racing-line.mjs','--track',str(args.track),'--difficulty',args.difficulty,'--output',str(profile_path)],cwd=ROOT,check=True,timeout=900)
    profile=json.loads(profile_path.read_text())
    if not profile.get('calibration',{}).get('complete') or profile['calibration'].get('smoke'):parser.error('Reference must pass full real-physics calibration; inspect its calibration recordings.')
    configs=[];results=[]
    for gamma,guided in [(gamma,guided) for gamma in GAMMAS for guided in [False,True]]:
        if control.cancelled.is_set():break
        config={'trackId':args.track,'difficulty':args.difficulty,'gamma':gamma,'seed':42,'seconds':args.seconds/4,
            'lineGuidance':guided,'lineProfilePath':str(profile_path),'device':args.device,'numEnvs':args.cars,'workers':args.workers,'warmStart':args.warm_start}
        arm=directory/(str(gamma)+('-guided' if guided else '-unguided'));pack,report=train_arm(config,arm,control);configs.append(config);results.append((pack,report,arm))
    if control.cancelled.is_set():
        write_json(directory/'acceptance.json',{'approved':False,'reason':'Stopped; checkpoints and recordings saved'});print(str(directory));return
    winner=choose_result(results);unguided=choose_result([r for r in results if not r[0]['variants'][args.difficulty]['training']['lineGuidance']]);write_json(directory/'comparison.json',{'configs':configs,'winnerGamma':winner[0]['variants'][args.difficulty]['training']['gamma'],'winnerGuided':winner[0]['variants'][args.difficulty]['training']['lineGuidance'],'reports':[r[1] for r in results]})
    # Native comparison is mandatory for promotion. Its reports/recordings never auto-activate.
    import subprocess
    command=['node','scripts/ai-training/energy-browser-check.mjs',str(winner[2]/f'track-{args.track}.kartai.json'),args.difficulty,str(directory/'native.json'),'--profile',str(profile_path),'--unguided',str(unguided[2]/f'track-{args.track}.kartai.json')]
    if args.v1_package:command.extend(['--v1',args.v1_package])
    subprocess.run(command,cwd=ROOT,check=True,timeout=900)
    native=json.loads((directory/'native.json').read_text());approved=native.get('approved',False) and not winner[1]['cancelled']
    write_json(directory/'acceptance.json',{'approved':approved,'native':native,'candidate':str(winner[2]),'note':'Manual import/activation only. No change to V1, no git commit.'})
    if approved:
        write_json(ROOT/f'ai-models/approved/v2/track-{args.track}-{args.difficulty}.kartai.json',winner[0])
        write_json(ROOT/f'ai-models/approved/v2/track-{args.track}-{args.difficulty}-validation.json',{'native':native,'comparison':str(directory/'comparison.json')})
        write_json(ROOT/'ml_training/runs/official'/uuid.uuid4().hex/f'track-{args.track}.kartai.json',winner[0])
    print(json.dumps({'run':str(directory),'approved':approved,'candidate':str(winner[2])}),flush=True)

if __name__=='__main__':main()
