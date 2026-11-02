import unittest
import tempfile
from pathlib import Path
import numpy as np
import torch
from stable_baselines3 import PPO
from .official_environment_v2 import EnergyVecEnv
from .official_train_v2 import new_policy
from .official_train import ROOT, save_checkpoint
from .race_rehearsal import RehearsalPPO
from .race_rnd import retains_shootout, select_retaining_seed


class RehearsalTests(unittest.TestCase):
    def test_race_improvement_cannot_silently_replace_a_faster_shootout_seed(self):
        row={'case':0,'seed':1,'startingCharge':1,'mode':'shootout','finished':True,'validLap':True,'offTrackRate':0,'contacts':0,'racePosition':1,'raceTime':24}
        baseline={'cancelled':False,'cases':[row]}
        slower={'cancelled':False,'cases':[{**row,'raceTime':24.06}]}
        self.assertFalse(retains_shootout(slower,baseline))
        self.assertFalse(retains_shootout({'cases':[]},baseline))
        faster={'cases':[{**row,'raceTime':23.9}]}
        self.assertTrue(retains_shootout(faster,baseline))
        chosen,rejected=select_retaining_seed('seed',baseline,[('challenger',slower,'test-arm')])
        self.assertEqual(chosen[0],'seed');self.assertEqual(len(rejected),1)
    def test_rehearsal_restores_teacher_actor_without_changing_critic_or_source(self):
        env = EnergyVecEnv({'trackId': 0, 'numEnvs': 1, 'workers': 1})
        try:
            model = new_policy(env, {'gamma': .9995}, policy_class=RehearsalPPO)
            obs = np.random.default_rng(7).normal(size=(256, 57)).astype(np.float32)
            with torch.no_grad():
                data = torch.as_tensor(obs)
                targets = model.policy.action_net(model.policy.mlp_extractor.forward_actor(model.policy.extract_features(data))).numpy().copy()
            model.attach_teacher(obs, targets, updates=60, learning_rate=.002)
            with torch.no_grad(): model.policy.action_net.bias.add_(.25)
            before = float(model.teacher_error().detach())
            critic = {key: value.clone() for key, value in model.policy.state_dict().items() if 'value' in key}
            model.rehearse()
            self.assertLess(float(model.teacher_error().detach()), before * .2)
            for key, value in critic.items(): self.assertTrue(torch.equal(value, model.policy.state_dict()[key]))
            np.testing.assert_array_equal(targets, model._teacher_targets.numpy())
            with tempfile.TemporaryDirectory(dir=ROOT / 'ml_training/runs') as directory:
                path = Path(directory) / 'rehearsal.zip'; save_checkpoint(model, path)
                plain = PPO.load(path, device='cpu')
                np.testing.assert_allclose(model.predict(obs, deterministic=True)[0], plain.predict(obs, deterministic=True)[0], atol=1e-7)
                self.assertFalse(hasattr(plain, '_teacher_obs'))
        finally: env.close()

    def test_real_ppo_update_with_rehearsal_stays_checkpoint_compatible(self):
        env = EnergyVecEnv({'trackId': 0, 'numEnvs': 2, 'workers': 1, 'episodeSeconds': .1})
        try:
            model = new_policy(env, {'gamma': .9995, 'horizon': 16, 'batchSize': 32}, policy_class=RehearsalPPO)
            obs = env.reset()
            with torch.no_grad():
                tensor = torch.as_tensor(obs)
                targets = model.policy.action_net(model.policy.mlp_extractor.forward_actor(model.policy.extract_features(tensor))).numpy()
            model.attach_teacher(obs, targets)
            model.learn(32); self.assertEqual(model.num_timesteps, 32)
            self.assertTrue(np.isfinite(model.predict(obs, deterministic=True)[0]).all())
        finally: env.close()


if __name__ == '__main__': unittest.main()
