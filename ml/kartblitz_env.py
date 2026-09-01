"""Gymnasium environment wrapping KartBlitz Node sim server."""
from __future__ import annotations

import numpy as np
import gymnasium as gym
from gymnasium import spaces

from util import SimClient

N_OBS = 10
N_ACT = 9


class KartBlitzEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, track_id: int = 0, seconds: float = 18.0, server_url: str | None = None):
        super().__init__()
        self.client = SimClient(server_url) if server_url else SimClient()
        self.track_id = track_id
        self.seconds = seconds
        self.observation_space = spaces.Box(low=-2.0, high=2.0, shape=(N_OBS,), dtype=np.float32)
        self.action_space = spaces.Discrete(N_ACT)
        self._last_info = {}

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        out = self.client.reset(self.track_id, self.seconds)
        obs = np.array(out["obs"], dtype=np.float32)
        self._last_info = {"totalLen": out.get("totalLen"), "maxSteps": out.get("maxSteps")}
        return obs, self._last_info

    def step(self, action):
        out = self.client.step(int(action))
        obs = np.array(out["obs"], dtype=np.float32)
        reward = float(out["reward"])
        terminated = bool(out["done"])
        truncated = False
        info = out.get("info") or {}
        self._last_info = info
        return obs, reward, terminated, truncated, info
