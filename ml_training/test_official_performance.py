import types
import unittest
from unittest.mock import patch
from .official_performance import learning_parameters,benchmark_choice,PhaseTimer,HardwareSampler,TrainingBudget

class PerformanceTests(unittest.TestCase):
    def test_time_budget_splits_remaining_time_across_stages(self):
        now=[0.];budget=TrainingBudget({'budgetMode':'time','durationSeconds':7200},lambda:now[0])
        self.assertEqual(budget.stage_deadline(.5,1),3600)
        now[0]=3600;self.assertEqual(budget.stage_deadline(.125,.5),4500)
        now[0]=7300;self.assertEqual(budget.fields()['timeRemainingSeconds'],0)
        self.assertIsNone(TrainingBudget({},lambda:0).stage_deadline(1,1))
        for value in [0,-1,float('nan'),float('inf'),86401]:
            with self.assertRaises(ValueError):TrainingBudget({'budgetMode':'time','durationSeconds':value})

    def test_benchmark_keeps_explicit_device_preference_and_auto_uses_fastest(self):
        rows=[dict(device=d,numEnvs=n,workers=8,horizon=128,batchSize=b,epochs=6,stepsPerSecond=s) for d,n,b,s in [('cpu',128,2048,9000),('cuda',16,256,2000),('cuda',128,2048,8800)]]
        self.assertEqual(benchmark_choice(rows,'cuda')['numEnvs'],128)
        self.assertEqual(benchmark_choice(rows,'cuda')['device'],'cuda')
        self.assertEqual(benchmark_choice(rows,'auto')['device'],'cpu')
        self.assertEqual(benchmark_choice(rows[:1],'cuda')['device'],'cpu')
        self.assertIsNone(benchmark_choice([],'auto'))

    def test_larger_batches_are_bounded_and_divide_the_rollout(self):
        sizes=learning_parameters({},128)
        self.assertEqual(sizes,{'horizon':128,'batchSize':2048,'rolloutSize':16384,'epochs':6})
        for config,count in [({'batchSize':997},64),({'horizon':17,'batchSize':2},1),({'horizon':512,'batchSize':999999,'epochs':1000},128)]:
            row=learning_parameters(config,count)
            self.assertGreater(row['batchSize'],1);self.assertEqual(row['rolloutSize']%row['batchSize'],0)
            self.assertLessEqual(row['batchSize'],16384);self.assertLessEqual(row['epochs'],16)

    def test_phase_timer_reports_actual_elapsed_work_and_freezes_after_finish(self):
        clock=[0.]
        with patch('ml_training.official_performance.time.monotonic',side_effect=lambda:clock[0]):
            timer=PhaseTimer();timer.begin_rollout();clock[0]=2;timer.end_rollout();clock[0]=3;timer.begin_rollout();clock[0]=4;timer.finish()
            row=timer.snapshot(100);clock[0]=100
            self.assertEqual(row['collectionSeconds'],3);self.assertEqual(row['updateSeconds'],1)
            self.assertEqual(row['stepsPerSecond'],25);self.assertEqual(row['phase'],'finished')
            self.assertEqual(timer.snapshot(100)['stepsPerSecond'],25)

    def test_gpu_telemetry_is_read_from_nvidia_smi_without_allocating_cuda_memory(self):
        sampler=HardwareSampler()
        def query(*args,**kwargs):
            sampler.stop_event.set();return types.SimpleNamespace(returncode=0,stdout='8151, 900, 25\n')
        with patch('ml_training.official_performance.subprocess.run',side_effect=query):sampler._run()
        row=sampler.summary(0,'cpu');self.assertEqual(row['gpuUtilizationPercent'],25);self.assertEqual(row['gpuMemoryUsedMiB'],900)
        self.assertNotIn('torchAllocatedMiB',row);self.assertEqual(row['meanGpuUtilizationPercent'],25)

if __name__=='__main__':unittest.main()
