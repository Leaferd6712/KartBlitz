"""Load human demo JSON files for Behavior Cloning."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

N_OBS = 10


def load_demo_frames(demo_dir: str | Path):
    demo_dir = Path(demo_dir)
    obs_list = []
    act_list = []
    for path in sorted(demo_dir.glob("*.json")):
        with open(path, encoding="utf-8") as f:
            demo = json.load(f)
        for frame in demo.get("frames", []):
            if "obs" not in frame or "action" not in frame:
                continue
            obs_list.append(frame["obs"])
            act_list.append(frame["action"])
    if not obs_list:
        raise FileNotFoundError(f"No demo frames in {demo_dir}")
    return np.array(obs_list, dtype=np.float32), np.array(act_list, dtype=np.int64)


class DemoDataset(Dataset):
    def __init__(self, obs: np.ndarray, actions: np.ndarray):
        self.obs = torch.from_numpy(obs)
        self.actions = torch.from_numpy(actions)

    def __len__(self):
        return len(self.obs)

    def __getitem__(self, idx):
        return self.obs[idx], self.actions[idx]
