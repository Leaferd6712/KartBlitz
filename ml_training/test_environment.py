from __future__ import annotations

import math
import unittest

from .environment import ACTIONS, OBSERVATION_NAMES, KartTrackEnv, load_tracks


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

    def test_every_action_steps_safely(self):
        env = KartTrackEnv(self.tracks, seed=7)
        for action in range(len(ACTIONS)):
            observation, reward, done, info = env.step(action)
            self.assertEqual(len(observation), 14)
            self.assertTrue(math.isfinite(reward))
            self.assertIsInstance(done, bool)
            self.assertIn("track", info)


if __name__ == "__main__":
    unittest.main()
