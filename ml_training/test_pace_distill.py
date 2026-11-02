import gzip
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from .official_environment_v2 import EnergyVecEnv
from .official_train_v2 import new_policy
from .official_train import ROOT
from .pace_distill import load_examples, clone_actor
from .pace_dagger import Coach, quality
import subprocess


class PaceDistillTests(unittest.TestCase):
    def test_coach_labels_the_actual_visited_state_and_keeps_charge(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'ml_training/runs') as folder:
            plan = Path(folder) / 'plan.json'
            code = "import fs from 'node:fs';import {officialTracks} from './ml_training/official-worker-v2.mjs';import {makePlan,initialParameters} from './sim/pace-planner.mjs';fs.writeFileSync(process.argv[1],JSON.stringify(makePlan(officialTracks[0],initialParameters(officialTracks[0]))));"
            subprocess.run(['node', '--input-type=module', '-e', code, str(plan)], cwd=ROOT, check=True, capture_output=True)
            coach = Coach(plan)
            try:
                first = coach.call({'command': 'reset', 'case': {'mode': 'ai', 'raceLaps': 3, 'energy': .25, 'seed': 12, 'lateralOffset': 6, 'headingOffset': .025}})
                self.assertEqual(len(first['observation']), 57); self.assertEqual(len(first['expert']), 4)
                self.assertAlmostEqual(first['observation'][12], .25)
                second = coach.call({'command': 'step', 'action': first['expert']})
                self.assertFalse(second['done']); self.assertEqual(second['result']['raceLaps'], 3)
                self.assertEqual(len(second['expert']), 4)
                recording = coach.call({'command': 'recording'})['points']
                self.assertGreater(recording[-1]['t'], 0); self.assertIn('drsActive', recording[-1]); self.assertIn('ersCharge', recording[-1])
            finally:
                coach.close()
        bad = {'finished': False, 'validLap': False, 'offTrackRate': .1, 'contacts': 0, 'raceTime': 1}
        good = {**bad, 'finished': True, 'validLap': True, 'offTrackRate': 0, 'raceTime': 30}
        self.assertGreater(quality([good]), quality([bad]))
    def test_contract_quality_holdout_and_dimensions(self):
        env = EnergyVecEnv({'trackId': 0, 'numEnvs': 1, 'workers': 1})
        try:
            metadata = env.metadata
            data = {'format': 'kartblitz-pace-demonstrations-v1', 'trackId': 0, 'difficulty': 'extreme',
                'physicsHash': metadata['physicsHash'], 'trackFingerprint': metadata['tracks'][0]['fingerprint'],
                'observationNames': metadata['observationNames'], 'actionNames': metadata['actionNames'],
                'provenance': {'holdoutSeeds': [99]}, 'episodes': [{'trackId': 0, 'difficulty': 'extreme', 'seed': 42,
                    'result': {'finished': True, 'validLap': True, 'raceTime': 20, 'offTrackRate': 0, 'contacts': 0},
                    'pairs': [{'observation': [0.] * 57, 'action': [0., 1., -1., -1.]}]}]}
            with tempfile.TemporaryDirectory(dir=ROOT / 'ml_training/runs') as folder:
                path = Path(folder) / 'examples.json.gz'
                def load(value):
                    with gzip.open(path, 'wt', encoding='utf-8') as stream:
                        json.dump(value, stream)
                    return load_examples(path, metadata, 0)
                _, obs, actions, groups = load(data)
                self.assertEqual(obs.shape, (1, 57)); self.assertEqual(actions.shape, (1, 4))
                self.assertEqual(groups.tolist(), [0])
                with self.assertRaisesRegex(ValueError, 'contract'):
                    load({**data, 'physicsHash': 'wrong'})
                data['episodes'][0]['seed'] = 99
                with self.assertRaisesRegex(ValueError, 'Held-out'):
                    load(data)
                data['episodes'][0]['seed'] = 42
                data['episodes'][0]['result']['offTrackRate'] = .01
                with self.assertRaisesRegex(ValueError, 'clean'):
                    load(data)
                data['episodes'][0]['result']['offTrackRate'] = 0
                data['episodes'][0]['pairs'][0]['action'] = [0.] * 5
                with self.assertRaisesRegex(ValueError, 'dimensions'):
                    load(data)
        finally:
            env.close()

    def test_fit_can_learn_braking_without_touching_critic_or_ppo_optimizer(self):
        env = EnergyVecEnv({'trackId': 0, 'numEnvs': 1, 'workers': 1})
        try:
            model = new_policy(env, {'gamma': .9995})
            critic_before = {key: value.clone() for key, value in model.policy.state_dict().items() if 'value' in key}
            obs = np.random.default_rng(4).normal(size=(256, 57)).astype(np.float32)
            actions = np.tile([.1, -.5, .8, -1.], (256, 1)).astype(np.float32)
            result = clone_actor(model, obs, actions, epochs=180, seconds=10)
            self.assertLess(result['finalFitLoss'], result['initialFitLoss'] * .25)
            self.assertEqual(model.num_timesteps, 0); self.assertEqual(len(model.policy.optimizer.state), 0)
            for key, value in critic_before.items():
                self.assertTrue(torch.equal(value, model.policy.state_dict()[key]))
            actual, _ = model.predict(obs, deterministic=True)
            self.assertGreater(actual[:, 2].mean(), 0)
        finally:
            env.close()


if __name__ == '__main__':
    unittest.main()
