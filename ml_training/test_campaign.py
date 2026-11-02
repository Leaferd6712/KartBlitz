import datetime as dt
import tempfile
import os
import subprocess
import sys
import time
import uuid
import unittest
from unittest.mock import patch,Mock
from pathlib import Path
from .campaign import Capacity,parse_deadline,read_json,write_json,ROOT,RUNS,watchdog,FLAGS
from .campaign_resources import admission,pressure,terminate_tree,ResourceMonitor
from .campaign_validation import summarize

class CampaignTests(unittest.TestCase):
    def setUp(self):
        self.good={'onMains':True,'diskFreeGiB':100,'ramAvailableGiB':8,'ramPercent':65,'cpuPercent':99,
            'sharedGpuMiB':0,'gpuTempC':70,'gpuUtilPercent':60,'gpuTotalMiB':8151,'gpuUsedMiB':1800}
    def test_resources_use_approved_ceilings_without_cpu_utilization_target(self):
        self.assertTrue(admission(self.good));self.assertIsNone(pressure(self.good))
        self.assertFalse(admission({**self.good,'sharedGpuMiB':None}))
        self.assertFalse(admission({**self.good,'gpuUsedMiB':6800}))
        self.assertIsNone(pressure({**self.good,'gpuUsedMiB':6800,'ramPercent':92}))
        for changed,reason in [({'gpuUsedMiB':7200},'vram-pressure'),({'ramPercent':95},'ram-pressure'),({'sharedGpuMiB':65},'shared-gpu-memory'),({'onMains':False},'unplugged')]:
            self.assertEqual(pressure({**self.good,**changed}),reason)
        normal={**self.good,'sharedGpuMiB':78,'sharedGpuAllowanceMiB':96,'sharedGpuExcessMiB':0}
        self.assertTrue(admission(normal));self.assertIsNone(pressure(normal))
        self.assertEqual(pressure({**normal,'sharedGpuMiB':161,'sharedGpuExcessMiB':65}),'shared-gpu-memory')
    def test_add_then_retract_training_without_a_real_throughput_gain(self):
        c=Capacity();c.changed=0
        self.assertEqual(c.decide(121,1,2000,self.good),'add');self.assertEqual(c.target,2)
        self.assertIsNone(c.decide(130,2,4000,self.good))
        self.assertEqual(c.decide(242,2,2100,self.good),'retract');self.assertEqual(c.target,1)
        self.assertIsNone(c.decide(400,1,2000,self.good))
    def test_shared_gpu_counter_includes_windows_learner_children(self):
        monitor=ResourceMonitor.__new__(ResourceMonitor);monitor.shared=Mock();monitor.shared.sample.return_value=0
        child=Mock();child.pid=202;process=Mock();process.children.return_value=[child]
        with patch('ml_training.campaign_resources.psutil.Process',return_value=process),patch('ml_training.campaign_resources.subprocess.run',side_effect=OSError):
            monitor.sample([101])
        monitor.shared.sample.assert_called_once_with({101,202})
    def test_keep_parallel_jobs_only_after_ten_percent_gain(self):
        c=Capacity();c.changed=0;c.decide(121,1,2000,self.good)
        self.assertEqual(c.decide(242,2,2400,self.good),'keep');self.assertEqual(c.target,2)
    def test_absolute_deadline_is_sydney_tuesday_four_am(self):
        value=parse_deadline('2026-11-03T04:00:00+11:00')
        self.assertEqual(dt.datetime.fromtimestamp(value,dt.timezone.utc).isoformat(),'2026-11-02T17:00:00+00:00')
        with self.assertRaises(ValueError):parse_deadline('2026-11-03T04:00:00')
    def test_persistence_and_missing_results_never_imply_approval(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as d:
            p=Path(d)/'state.json';write_json(p,{'deadline':123,'active':[]});self.assertEqual(read_json(p)['deadline'],123)
            self.assertIsNone(read_json(Path(d)/'missing.json'))
        self.assertEqual(summarize([])['finishRate'],0)
    def test_status_write_retries_transient_windows_reader_lock(self):
        import os
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as d:
            target=Path(d)/'status.json';replace=os.replace;attempts=[]
            def locked_then_success(source,destination):
                attempts.append(1)
                if len(attempts)<3:raise PermissionError('Temporary reader lock')
                replace(source,destination)
            with patch('ml_training.campaign.os.replace',side_effect=locked_then_success):write_json(target,{'status':'running'})
            self.assertEqual(read_json(target)['status'],'running');self.assertEqual(len(attempts),3)
    def test_partial_attempts_keep_camera_and_energy_telemetry(self):
        from .official_environment import OfficialVecEnv
        records=[];env=OfficialVecEnv({'trackId':0,'numEnvs':2,'workers':1,'racecraft':True,'scenario':'passing','mode':'ai'},records.append)
        try:
            env.reset();env.step([[0,1,-1,1,1]]*2);env.archive_partials()
            self.assertEqual(len(records),2)
            for row in records:
                self.assertTrue(row['interrupted']);self.assertFalse(row['finished'])
                self.assertTrue(all(k in row['trajectory'][-1] for k in ['ersCharge','ersActive','drsActive','drsAvailable','drsInZone','lapTime','x','y','a']))
                self.assertIn('workerBatch',row);self.assertIn('environment',row)
        finally:env.close()
    def test_watchdog_closes_owned_jobs_before_the_absolute_deadline(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'ml_training/runs') as d:
            path=Path(d);deadline=time.time()+20
            write_json(path/'state.json',{'deadline':deadline,'managerPid':100,'managerCreated':1,'phase':'training','runs':[{'pid':101,'created':2,'active':True}]})
            with patch('ml_training.campaign.CURRENT',path),patch('ml_training.campaign.terminate_tree') as kill:
                watchdog()
            self.assertEqual(kill.call_count,2)
            self.assertEqual(read_json(path/'state.json')['phase'],'deadline-stopped')
            self.assertLess(read_json(path/'watchdog-result.json')['stoppedAt'],deadline)
    def test_stale_watchdog_cannot_stop_a_restarted_campaign(self):
        old={'deadline':time.time()+20,'managerPid':100,'managerCreated':1,'phase':'training'}
        new={**old,'managerPid':200,'managerCreated':2}
        with patch('ml_training.campaign.read_json',side_effect=[old,new]),patch('ml_training.campaign.terminate_tree') as kill:
            watchdog()
        kill.assert_not_called()
    def test_manager_cleanup_preserves_browser_and_independent_watchdog(self):
        def process(pid,args):
            p=Mock();p.pid=pid;p.cmdline.return_value=args;p.children.return_value=[];p.create_time.return_value=1;return p
        parent=process(100,['python','-m','ml_training.campaign']);worker=process(101,['python','-m','ml_training.campaign','--worker','abc'])
        node=process(102,['node','official-worker.mjs']);worker.children.return_value=[node]
        browser=process(103,['msedge.exe','--new-window','campaign.html']);watch=process(104,['python','-m','ml_training.campaign','--watchdog'])
        parent.children.return_value=[worker,node,browser,watch]
        with patch('ml_training.campaign_resources.psutil.Process',return_value=parent),patch('ml_training.campaign_resources.psutil.wait_procs',return_value=([],[])):
            terminate_tree(100,1)
        parent.terminate.assert_called_once();worker.terminate.assert_called_once();node.terminate.assert_called_once()
        browser.terminate.assert_not_called();watch.terminate.assert_not_called()
    def test_isolated_job_saves_checkpoint_on_external_stop(self):
        import psutil
        run_id=uuid.uuid4().hex;directory=RUNS/run_id;directory.mkdir(parents=True)
        config={'trackIds':[0],'allDifficulties':False,'difficulty':'extreme','runName':'Campaign control smoke test',
            'testOnly':True,'device':'cpu','preparedCore':True,'budgetMode':'time','durationSeconds':20,'numEnvs':2,'workers':1,'horizon':16,
            'episodeSeconds':.2,'evaluationEpisodes':1,'recordPartials':True,'hardwareTelemetry':False,'racecraft':True}
        write_json(directory/'campaign-spec.json',{'config':config,'track':0,'difficulty':'extreme','slot':0,
            'managerPid':os.getpid(),'managerCreated':psutil.Process().create_time(),'trainStop':time.time()+60})
        log=(directory/'smoke.log').open('w')
        process=subprocess.Popen([sys.executable,'-m','ml_training.campaign','--worker',run_id],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,creationflags=FLAGS);log.close()
        try:
            end=time.time()+40
            while time.time()<end and process.poll() is None:
                status=read_json(directory/'campaign-status.json',{})
                if status.get('completedSteps',0)>64:break
                time.sleep(.2)
            write_json(directory/'campaign-control.json',{'action':'stop'})
            process.wait(timeout=20)
            status=read_json(directory/'campaign-status.json',{})
            self.assertEqual(process.returncode,0,(directory/'smoke.log').read_text())
            self.assertEqual(status['status'],'cancelled');self.assertGreater(status['completedSteps'],0)
            self.assertTrue((directory/'track-0/extreme/last.zip').exists())
            self.assertTrue((directory/'attempt-index.jsonl').exists())
        finally:
            if process.poll() is None:process.kill();process.wait()
            # Test artifacts remain explicitly named and never replace a real run.

if __name__=='__main__':unittest.main()
