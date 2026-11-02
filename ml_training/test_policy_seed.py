import json
import subprocess
import unittest
import numpy as np
import torch
from .official_environment_v2 import EnergyVecEnv
from .official_train_v2 import new_policy
from .official_train import export_policy, ROOT
from .policy_seed import import_actor


class PolicySeedTests(unittest.TestCase):
    def test_exact_actor_copy_and_fresh_critic_optimizer(self):
        env = EnergyVecEnv({'trackId': 0, 'numEnvs': 1, 'workers': 1})
        try:
            source = new_policy(env, {'gamma': .9995, 'seed': 91})
            with torch.no_grad():
                source.policy.action_net.bias.add_(.12)
            pack = {'format': 'kartblitz-official-track-v2', 'observationVersion': 2, 'actionCount': 4, 'trackId': 0,
                'physicsHash': env.physics_hash, 'trackFingerprint': env.metadata['tracks'][0]['fingerprint'],
                'observationNames': env.metadata['observationNames'], 'actionNames': env.metadata['actionNames'],
                'variants': {'extreme': {'policy': export_policy(source)}}}
            target = new_policy(env, {'gamma': .9995, 'seed': 42})
            critic = {key: value.clone() for key, value in target.policy.state_dict().items() if 'value' in key}
            import_actor(target, pack, env.metadata, 'extreme')
            data = np.random.default_rng(7).normal(size=(8, 57)).astype(np.float32)
            np.testing.assert_allclose(source.predict(data, deterministic=True)[0], target.predict(data, deterministic=True)[0], atol=1e-7)
            self.assertEqual(target.num_timesteps, 0); self.assertEqual(len(target.policy.optimizer.state), 0)
            for key, value in critic.items():
                self.assertTrue(torch.equal(value, target.policy.state_dict()[key]))
            command = "import {forward} from './sim/official-policy.mjs';let data='';for await(const chunk of process.stdin)data+=chunk;const p=JSON.parse(data);console.log(JSON.stringify(p.obs.map(o=>forward(p.policy,o))));"
            result = subprocess.run(['node', '--input-type=module', '-e', command], cwd=ROOT,
                input=json.dumps({'policy': pack['variants']['extreme']['policy'], 'obs': data.tolist()}), capture_output=True, text=True, check=True)
            np.testing.assert_allclose(target.predict(data, deterministic=True)[0], json.loads(result.stdout), atol=1e-6)
            with self.assertRaisesRegex(ValueError, 'contract'):
                import_actor(target, {**pack, 'physicsHash': 'old'}, env.metadata, 'extreme')
            with self.assertRaisesRegex(ValueError, 'geometry'):
                import_actor(target, {**pack, 'trackFingerprint': 'old'}, env.metadata, 'extreme')
        finally:
            env.close()


if __name__ == '__main__':
    unittest.main()
