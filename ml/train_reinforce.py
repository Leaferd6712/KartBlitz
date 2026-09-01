"""REINFORCE trainer (PyTorch MLP) via Node sim server."""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.distributions import Categorical
from torch.utils.tensorboard import SummaryWriter

from kartblitz_env import KartBlitzEnv, N_ACT, N_OBS

ROOT = Path(__file__).resolve().parent.parent


class PolicyMLP(nn.Module):
    def __init__(self, hidden: int = 128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(N_OBS, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, N_ACT),
        )

    def forward(self, x):
        return self.net(x)


def parse_args():
    p = argparse.ArgumentParser(description="KartBlitz REINFORCE (PyTorch)")
    p.add_argument("--track", type=int, default=0)
    p.add_argument("--episodes", type=int, default=500)
    p.add_argument("--seconds", type=float, default=18.0)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--gamma", type=float, default=0.992)
    p.add_argument("--entropy", type=float, default=0.01)
    p.add_argument("--hidden", type=int, default=128)
    p.add_argument("--out", default="sim/rl/models/reinforce_best.pt")
    p.add_argument("--logdir", default="ml/runs/reinforce")
    return p.parse_args()


def main():
    args = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device} — ensure npm run ml:env is running")

    env = KartBlitzEnv(track_id=args.track, seconds=args.seconds)
    model = PolicyMLP(args.hidden).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    writer = SummaryWriter(args.logdir)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    baseline = 0.0
    best_reward = -1e9

    for ep in range(1, args.episodes + 1):
        obs, _ = env.reset()
        log_probs = []
        rewards = []
        entropies = []

        done = False
        while not done:
            obs_t = torch.tensor(obs, dtype=torch.float32, device=device)
            logits = model(obs_t)
            dist = Categorical(logits=logits)
            action = dist.sample()
            log_probs.append(dist.log_prob(action))
            entropies.append(dist.entropy())

            obs, reward, terminated, truncated, info = env.step(action.item())
            rewards.append(reward)
            done = terminated or truncated

        returns = []
        G = 0.0
        for r in reversed(rewards):
            G = r + args.gamma * G
            returns.insert(0, G)

        returns_t = torch.tensor(returns, dtype=torch.float32, device=device)
        baseline = 0.97 * baseline + 0.03 * returns_t.mean().item()
        adv = returns_t - baseline

        log_probs_t = torch.stack(log_probs)
        ent_t = torch.stack(entropies)
        loss = -(log_probs_t * adv.detach()).mean() - args.entropy * ent_t.mean()

        opt.zero_grad()
        loss.backward()
        opt.step()

        ep_reward = sum(rewards)
        prog = info.get("progress", 0)
        writer.add_scalar("episode/reward", ep_reward, ep)
        writer.add_scalar("episode/progress", prog, ep)

        if ep_reward > best_reward:
            best_reward = ep_reward
            torch.save(
                {"type": "mlp", "hidden": args.hidden, "state_dict": model.state_dict(), "reward": ep_reward},
                out_path,
            )

        if ep % 20 == 0:
            print(f"ep {ep:4d}  R {ep_reward:8.1f}  prog {prog:.0f}  loss {loss.item():.4f}")

    writer.close()
    print(f"Best reward {best_reward:.1f} → {out_path}")


if __name__ == "__main__":
    main()
