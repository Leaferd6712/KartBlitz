from __future__ import annotations

import math
import unittest

from .environment import OBSERVATION_NAMES, KartTrackEnv, expert_action, load_tracks
from .train import split_training_budget


class EnvironmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tracks = load_tracks()

    def test_all_tracks_produce_contract_observations(self):
        self.assertGreaterEqual(len(self.tracks), 8)
        for track_id in range(len(self.tracks)):
            env = KartTrackEnv(self.tracks, seed=track_id)
            observation = env.reset(track_id, random_start=False)
            self.assertEqual(len(observation), len(OBSERVATION_NAMES))
            self.assertTrue(all(math.isfinite(value) for value in observation))

    def test_continuous_actions_step_safely(self):
        env = KartTrackEnv(self.tracks, seed=7)
        for action in ([-1, -1, -1], [0, 1, -1], [1, -1, 1], [.35, .8, -.8]):
            observation, reward, done, info = env.step(action)
            self.assertEqual(len(observation), 24)
            self.assertTrue(math.isfinite(reward))
            self.assertIsInstance(done, bool)
            self.assertIn("track", info)

    def test_teacher_action_is_bounded(self):
        env = KartTrackEnv(self.tracks, seed=9)
        action = expert_action(env.reset(0, random_start=False))
        self.assertEqual(len(action), 3)
        self.assertTrue(all(-1 <= value <= 1 for value in action))

    def test_training_budget_is_ten_percent_imitation_and_ninety_percent_rl(self):
        total, imitation, reinforcement = split_training_budget(3_000_000)
        self.assertEqual((total, imitation, reinforcement), (3_000_000, 300_000, 2_700_000))
        self.assertEqual(imitation + reinforcement, total)


if __name__ == "__main__":
    unittest.main()
