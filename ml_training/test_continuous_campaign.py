import copy
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from .continuous_campaign import acceptance,cases,schedule,count_attempts,scheduler_update_is_safe,can_start,current_difficulty,DIFFICULTIES

def fixture():
    rows=[]
    for seed in [1000001,2000003]:
        conditions=[('shootout',1,e,'solo') for e in [.25,.5,1]]+ [('ai',l,[.25,.5,1][i%3],'solo') for i,l in enumerate([1,2,3,5,8,10])]+ [('ai',3,.5,s) for s in ['passing','defending','recovery','mixed']]
        for mode,laps,energy,scenario in conditions:
            for arm,seconds in [('Legacy',30),('Research seed',29),('V2',28)]:
                rows.append(dict(seed=seed,mode=mode,raceLaps=laps,energy=energy,scenario=scenario,arm=arm,finished=True,valid=True,offTrackRate=0,raceTime=seconds*laps,racePosition=1,contacts=1 if scenario=='recovery' else 0,recoveryTime=2,defensiveReversalFlags=0,spectatorIntrusionTicks=0,measuredOpponentCount=0 if scenario=='solo' else 2))
    return dict(candidateSha256='expected',evaluationVersion=2,defenseMetric='lane-deviation-review-proxy-v1',cases=rows)

class CampaignTests(unittest.TestCase):
    def test_only_full_matched_clean_improvements_pass(self):
        report=fixture();self.assertTrue(acceptance(report,'expected',True)['approved'])
        for key,value in [('finished',False),('valid',False),('offTrackRate',.02),('raceTime',None),('raceTime',float('nan')),('defensiveReversalFlags',1),('contacts',5),('spectatorIntrusionTicks',1)]:
            altered=copy.deepcopy(report);next(r for r in altered['cases'] if r['arm']=='V2')[key]=value
            self.assertFalse(acceptance(altered,'expected',True)['approved'],key)
    def test_missing_cases_baseline_and_changed_candidate_fail(self):
        for arm in ['V2','Legacy','Research seed']:
            report=fixture();report['cases'].remove(next(r for r in report['cases'] if r['arm']==arm))
            self.assertFalse(acceptance(report,'expected',True)['approved'])
        self.assertFalse(acceptance(fixture(),'wrong',True)['approved'])
    def test_no_pace_tradeoff_can_replace_incumbent(self):
        report=fixture()
        for row in report['cases']:
            if row['arm']=='V2' and row['mode']=='shootout':row['raceTime']=29.1
        self.assertFalse(acceptance(report,'expected',True)['approved'])
    def test_repeated_conditions_cannot_fill_missing_coverage(self):
        report=fixture();rows=[r for r in report['cases'] if r['arm']=='V2'];rows[-1].update(rows[-2])
        self.assertFalse(acceptance(report,'expected',True)['approved'])
    def test_scheduler_covers_all_difficulties_without_starvation(self):
        tasks=[dict(priority=i,turns=0,status='queued') for i in range(40)];seen=[]
        for _ in range(80):
            chosen=schedule(tasks)[0];seen.append(chosen['priority']);chosen['turns']+=1
        self.assertEqual(seen[:40],list(range(40)));self.assertEqual(seen[40:],list(range(40)))
    def test_difficulty_first_waits_for_every_extreme_then_resumes_hard(self):
        tasks=[dict(track=t,difficulty=d,priority=i*8+t,turns=0,status='queued',ready=False,attempts=123) for i,d in enumerate(DIFFICULTIES) for t in range(8)]
        self.assertEqual(current_difficulty(tasks),'extreme')
        self.assertEqual({t['difficulty'] for t in schedule(tasks,DIFFICULTIES)},{'extreme'})
        for t in tasks[:7]:t.update(ready=True,status='done')
        tasks[7].update(status='retry-wait',retryAfter=10**20)
        self.assertEqual(schedule(tasks,DIFFICULTIES),[],'A delayed Extreme task must not release Hard early')
        tasks[7].update(ready=True,status='done')
        self.assertEqual(current_difficulty(tasks),'hard')
        self.assertEqual({t['difficulty'] for t in schedule(tasks,DIFFICULTIES)},{'hard'})
        self.assertEqual(tasks[8]['attempts'],123,'Changing schedule must preserve saved Hard counters')
    def test_attempt_ledger_is_incremental_and_excludes_partial_records(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'attempt-index.jsonl';r={}
            path.write_bytes(b'{"mode":"shootout","finished":true}\n{"mode":"ai","finished":false}\n{"interrupted":true,"mode":"ai"}\n{"mode":')
            count_attempts(folder,r);self.assertEqual(r['countedAttempts'],2);self.assertEqual(r['countedRaces'],1);self.assertEqual(r['countedValid'],1)
            count_attempts(folder,r);self.assertEqual(r['countedAttempts'],2)
            with path.open('ab') as f:f.write(b'"ai","finished":true}\n')
            count_attempts(folder,r);self.assertEqual(r['countedAttempts'],3);self.assertEqual(r['countedRaces'],2)
    def test_targets_do_not_starve_untrained_models_and_faults_retry(self):
        tasks=[dict(priority=0,turns=0,status='queued',targetReached=True),dict(priority=1,turns=5,status='queued',targetReached=False),dict(priority=2,turns=0,status='retry-wait',retryAfter=10**20)]
        self.assertEqual([t['priority'] for t in schedule(tasks)],[1,0]);tasks[2]['retryAfter']=0;self.assertEqual(schedule(tasks)[0]['priority'],2)
    def test_scheduler_migration_refuses_physics_or_control_changes(self):
        original={'index.html':'same','ml_training/continuous_campaign.py':'old'}
        self.assertTrue(scheduler_update_is_safe(original,{**original,'ml_training/continuous_campaign.py':'new'})[0])
        self.assertFalse(scheduler_update_is_safe(original,{**original,'index.html':'different'})[0])
    def test_admission_respects_emergency_limits(self):
        row=dict(onMains=True,diskFreeGiB=50,ramAvailableGiB=3,ramPercent=85,gpuTempC=65,gpuUsedMiB=1000,sharedGpuMiB=78,sharedGpuExcessMiB=0)
        self.assertTrue(can_start(row));self.assertFalse(can_start({**row,'ramPercent':95}));self.assertFalse(can_start({**row,'onMains':False}))
    def test_selection_and_final_checks_are_disjoint_and_include_long_races(self):
        a,b=cases('mixed',True),cases('mixed',False)
        self.assertFalse({r['seed'] for r in a}&{r['seed'] for r in b})
        self.assertTrue(any(r['raceLaps']==10 for r in a));self.assertTrue(all(r['mode']=='shootout' for r in cases('solo')))
    def test_promotion_keeps_other_difficulties_and_old_weight_files(self):
        from . import continuous_campaign as module
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);active=root/'ai-models/active.json';path=root/'candidate.json'
            campaign=object.__new__(module.ContinuousCampaign);campaign.state={'promotions':{}};campaign.event=lambda message:None
            pack={'trackId':0,'physicsHash':'physics','trackFingerprint':'track','variants':{'extreme':{'policy':'fast'}}}
            module.write_json(path,pack)
            with patch.object(module,'ROOT',root),patch.object(module,'ACTIVE',active):
                campaign.promote({'track':0,'difficulty':'extreme'},path,{'approved':True})
                first=module.read_json(active);old=root/first['tracks']['0']['path']
                pack['variants']={'hard':{'policy':'hard'}};module.write_json(path,pack)
                campaign.promote({'track':0,'difficulty':'hard'},path,{'approved':True})
                current=module.read_json(active);merged=module.read_json(root/current['tracks']['0']['path'])
                self.assertEqual(merged['variants'],{'extreme':{'policy':'fast'},'hard':{'policy':'hard'}})
                self.assertTrue(old.exists());self.assertEqual(current['revision'],2)

class NativeLearningTests(unittest.TestCase):
    def test_independent_learners_update_concurrently_in_one_process(self):
        from concurrent.futures import ThreadPoolExecutor
        from .official_train_v2 import train_arm
        from .official_train import ROOT
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as folder:
            root=Path(folder)
            def run(seed):
                cfg={'trackId':0,'difficulty':'extreme','gamma':.9995,'horizon':16,'steps':16,'numEnvs':1,'workers':1,'device':'cpu','nativeRace':True,'trainingMode':'shootout','racecraft':False,'episodeSeconds':.12,'smokeEvaluation':True,'bestCheckpoint':False,'sharedLearner':True,'seed':seed}
                return train_arm(cfg,root/str(seed))[0]
            with ThreadPoolExecutor(max_workers=2) as pool:packages=list(pool.map(run,[11,29]))
            self.assertNotEqual(packages[0]['variants']['extreme']['id'],packages[1]['variants']['extreme']['id'])
            for seed,pack in zip([11,29],packages):
                self.assertEqual(pack['variants']['extreme']['training']['steps'],16)
                self.assertTrue(pack['variants']['extreme']['training']['sharedLearnerProcess']);self.assertTrue((root/str(seed)/'last.zip').exists())
    def test_native_cpu_update_checkpoint_resume_and_archive(self):
        from .official_train_v2 import train_arm
        from .official_train import ROOT
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as folder:
            root=Path(folder);progress=[]
            cfg={'trackId':0,'difficulty':'extreme','gamma':.9995,'horizon':16,'steps':32,'numEnvs':2,'workers':1,'device':'cpu','nativeRace':True,'trainingMode':'shootout','racecraft':False,'episodeSeconds':.12,'smokeEvaluation':True,'bestCheckpoint':False}
            pack,_=train_arm(cfg,root/'first',progress=lambda model,env,attempts,elapsed:progress.append(model.num_timesteps))
            self.assertEqual(pack['environmentVersion'],7);self.assertTrue(progress)
            cfg['resumeCheckpoint']=str(root/'first/last.zip')
            cfg['numEnvs']=1;cfg['steps']=16
            resumed,_=train_arm(cfg,root/'second')
            self.assertEqual(resumed['variants']['extreme']['training']['steps'],48)
            import gzip,json
            row=json.loads(next(gzip.open(root/'first/attempts.jsonl.gz','rt',encoding='utf-8')))
            self.assertEqual(row['environmentVersion'],7);self.assertIn('ersCharge',row['points'][-1]);self.assertTrue((root/'second/last.zip').exists())

if __name__=='__main__':unittest.main()
