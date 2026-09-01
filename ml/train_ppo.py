"""PPO trainer for KartBlitz via Node sim server."""
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


class ActorCritic(nn.Module):
    def __init__(self, hidden: int = 128):
        super().__init__()
        self.body = nn.Sequential(
            nn.Linear(N_OBS, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
        )
        self.pi = nn.Linear(hidden, N_ACT)
        self.v = nn.Linear(hidden, 1)

    def forward(self, x):
        h = self.body(x)
        return self.pi(h), self.v(h).squeeze(-1)


def parse_args():
    p = argparse.ArgumentParser(description="KartBlitz PPO")
    p.add_argument("--track", type=int, default=0)
    p.add_argument("--steps", type=int, default=300_000)
    p.add_argument("--seconds", type=float, default=18.0)
    p.add_argument("--rollout", type=int, default=512)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--gamma", type=float, default=0.99)
    p.add_argument("--gae-lam", type=float, default=0.95)
    p.add_argument("--clip", type=float, default=0.2)
    p.add_argument("--hidden", type=int, default=128)
    p.add_argument("--out", default="sim/rl/models/ppo_best.pt")
    p.add_argument("--logdir", default="ml/runs/ppo")
    return p.parse_args()


def compute_gae(rewards, values, dones, gamma, lam):
    adv = []
    gae = 0.0
    next_val = 0.0
    for t in reversed(range(len(rewards))):
        mask = 1.0 - dones[t]
        delta = rewards[t] + gamma * next_val * mask - values[t]
        gae = delta + gamma * lam * mask * gae
        adv.insert(0, gae)
        next_val = values[t]
    return adv


def main():
    args = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device} — ensure npm run ml:env is running")

    env = KartBlitzEnv(track_id=args.track, seconds=args.seconds)
    model = ActorCritic(args.hidden).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    writer = SummaryWriter(args.logdir)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    obs, _ = env.reset()
    obs = torch.tensor(obs, dtype=torch.float32, device=device)
    total_steps = 0
    ep_reward = 0.0
    ep_count = 0
    best_prog = 0.0

    while total_steps < args.steps:
        obs_buf, act_buf, logp_buf, rew_buf, val_buf, done_buf = [], [], [], [], [], []

        for _ in range(args.rollout):
            with torch.no_grad():
                logits, value = model(obs)
                dist = Categorical(logits=logits)
                action = dist.sample()
                logp = dist.log_prob(action)

            next_obs, reward, terminated, truncated, info = env.step(action.item())
            done = terminated or truncated

            obs_buf.append(obs.cpu().numpy())
            act_buf.append(action.item())
            logp_buf.append(logp.item())
            rew_buf.append(reward)
            val_buf.append(value.item())
            done_buf.append(float(done))

            ep_reward += reward
            total_steps += 1
            obs = torch.tensor(next_obs, dtype=torch.float32, device=device)

            if done:
                writer.add_scalar("episode/reward", ep_reward, ep_count)
                if info.get("progress", 0) > best_prog:
                    best_prog = info["progress"]
                    torch.save(
                        {
                            "type": "mlp",
                            "hidden": args.hidden,
                            "actor_critic": True,
                            "state_dict": model.state_dict(),
                            "progress": best_prog,
                        },
                        out_path,
                    )
                ep_reward = 0.0
                ep_count += 1
                next_obs, _ = env.reset()
                obs = torch.tensor(next_obs, dtype=torch.float32, device=device)

        adv = compute_gae(rew_buf, val_buf, done_buf, args.gamma, args.gae_lam)
        adv_t = torch.tensor(adv, dtype=torch.float32, device=device)
        adv_t = (adv_t - adv_t.mean()) / (adv_t.std() + 1e-8)
        ret_t = adv_t + torch.tensor(val_buf, dtype=torch.float32, device=device)

        obs_t = torch.tensor(np.array(obs_buf), dtype=torch.float32, device=device)
        act_t = torch.tensor(act_buf, dtype=torch.long, device=device)
        old_logp_t = torch.tensor(logp_buf, dtype=torch.float32, device=device)

        for _ in range(args.epochs):
            logits, values = model(obs_t)
            dist = Categorical(logits=logits)
            logp = dist.log_prob(act_t)
            ratio = torch.exp(logp - old_logp_t)
            surr1 = ratio * adv_t
            surr2 = torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * adv_t
            pi_loss = -torch.min(surr1, surr2).mean()
            v_loss = F.mse_loss(values, ret_t) if hasattr(torch.nn.functional, "mse_loss") else ((values - ret_t) ** 2).mean()
            loss = pi_loss + 0.5 * v_loss

            opt.zero_grad()
            loss.backward()
            opt.step()

        writer.add_scalar("train/pi_loss", pi_loss.item(), total_steps)
        writer.add_scalar("train/best_progress", best_prog, total_steps)

        if ep_count and ep_count % 10 == 0:
            print(f"steps {total_steps}  episodes {ep_count}  best_prog {best_prog:.0f}")

    writer.close()
    print(f"Done. Best progress {best_prog:.0f} → {out_path}")


if __name__ == "__main__":
    main()
