from __future__ import annotations

import argparse
import json
import math
import random
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .environment import KartTrackEnv, OBSERVATION_NAMES, load_tracks
from .model import build_actor_critic, export_actor

ProgressCallback = Callable[[dict[str, Any]], None]


def _import_torch():
    try:
        import torch
        return torch
    except ImportError as exc:
        raise RuntimeError("PyTorch is not installed. Run ml_training/install.ps1 first.") from exc


def capture_trajectory(torch: Any, model: Any, tracks: list[dict[str, Any]], rewards: dict[str, float], device: Any, label: str, track_id: int = 0) -> dict[str, Any]:
    env = KartTrackEnv(tracks, rewards, seed=8128)
    observation = env.reset(track_id, random_start=False)
    points = [{"x": round(env.x, 2), "y": round(env.y, 2)}]
    model.eval()
    with torch.no_grad():
        for step in range(30 * 75):
            logits, _ = model(torch.tensor([observation], dtype=torch.float32, device=device))
            action = int(torch.argmax(logits, dim=1).item())
            observation, _, done, _ = env.step(action)
            if step % 8 == 0: points.append({"x": round(env.x, 2), "y": round(env.y, 2)})
            if done: break
    model.train()
    return {"trackId": track_id, "label": label, "points": points}


def evaluate(torch: Any, model: Any, tracks: list[dict[str, Any]], rewards: dict[str, float], device: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    metrics, snapshots = [], []
    model.eval()
    with torch.no_grad():
        for track_id in range(len(tracks)):
            finishes, off_steps, total_steps, speeds, trajectory = 0, 0, 0, [], []
            for episode in range(2):
                env = KartTrackEnv(tracks, rewards, seed=9100 + track_id * 17 + episode)
                obs = env.reset(track_id, random_start=False)
                for step in range(30 * 80):
                    logits, _ = model(torch.tensor([obs], dtype=torch.float32, device=device))
                    action = int(torch.argmax(logits, dim=1).item())
                    obs, _, done, info = env.step(action)
                    total_steps += 1; off_steps += int(info["offTrack"]); speeds.append(env.speed)
                    if episode == 0 and step % 8 == 0: trajectory.append({"x": round(env.x, 2), "y": round(env.y, 2)})
                    if done:
                        finishes += int(info["lap"] > 0)
                        break
            metrics.append({"trackId": track_id, "finishRate": finishes / 2, "offTrackRate": off_steps / max(1, total_steps), "meanSpeed": sum(speeds) / max(1, len(speeds))})
            if track_id < 3: snapshots.append({"trackId": track_id, "label": f"Final · track {track_id + 1}", "points": trajectory})
    model.train()
    return metrics, snapshots


def train_model(config: dict[str, Any], callback: ProgressCallback | None = None) -> dict[str, Any]:
    torch = _import_torch()
    seed = int(config.get("seed", 42))
    random.seed(seed); torch.manual_seed(seed)
    if torch.cuda.is_available(): torch.cuda.manual_seed_all(seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    tracks = load_tracks()
    total_steps = max(4096, min(int(config.get("totalSteps", 150000)), 10_000_000))
    num_envs = max(8, min(int(config.get("numEnvs", 64)), 128))
    horizon = 128
    rewards = config.get("rewards") or {}
    envs = [KartTrackEnv(tracks, rewards, seed + i * 31) for i in range(num_envs)]
    model = build_actor_critic(torch).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=3e-4)
    observations = torch.tensor([env.reset() for env in envs], dtype=torch.float32, device=device)
    completed_steps, update = 0, 0
    recent_rewards: list[float] = []
    logs = [f"Loaded {len(tracks)} KartBlitz tracks", f"PyTorch device: {device}"]
    learning_snapshots = [capture_trajectory(torch, model, tracks, rewards, device, "Early · untrained")]
    captured_middle = False

    while completed_steps < total_steps:
        obs_buf, act_buf, log_buf, rew_buf, done_buf, val_buf = [], [], [], [], [], []
        for _ in range(horizon):
            with torch.no_grad():
                logits, values = model(observations)
                distribution = torch.distributions.Categorical(logits=logits)
                actions = distribution.sample()
                log_probs = distribution.log_prob(actions)
            next_obs, rewards_step, dones = [], [], []
            for i, env in enumerate(envs):
                obs, reward, done, _ = env.step(int(actions[i].item()))
                if done: obs = env.reset()
                next_obs.append(obs); rewards_step.append(reward); dones.append(done)
            obs_buf.append(observations); act_buf.append(actions); log_buf.append(log_probs); val_buf.append(values)
            rew_buf.append(torch.tensor(rewards_step, dtype=torch.float32, device=device))
            done_buf.append(torch.tensor(dones, dtype=torch.float32, device=device))
            observations = torch.tensor(next_obs, dtype=torch.float32, device=device)
            recent_rewards.extend(rewards_step)
        with torch.no_grad(): _, next_value = model(observations)
        advantages = torch.zeros((horizon, num_envs), dtype=torch.float32, device=device)
        last_gae = torch.zeros(num_envs, dtype=torch.float32, device=device)
        for t in reversed(range(horizon)):
            next_non_terminal = 1.0 - done_buf[t]
            next_values = next_value if t == horizon - 1 else val_buf[t + 1]
            delta = rew_buf[t] + .99 * next_values * next_non_terminal - val_buf[t]
            last_gae = delta + .99 * .95 * next_non_terminal * last_gae
            advantages[t] = last_gae
        returns = advantages + torch.stack(val_buf)
        batch_obs = torch.cat(obs_buf); batch_actions = torch.cat(act_buf); batch_old_log = torch.cat(log_buf); batch_adv = advantages.flatten(); batch_returns = returns.flatten()
        batch_adv = (batch_adv - batch_adv.mean()) / (batch_adv.std() + 1e-8)
        batch_size = batch_obs.shape[0]
        for _ in range(4):
            permutation = torch.randperm(batch_size, device=device)
            for start in range(0, batch_size, 1024):
                idx = permutation[start:start + 1024]
                logits, value = model(batch_obs[idx]); dist = torch.distributions.Categorical(logits=logits); new_log = dist.log_prob(batch_actions[idx])
                ratio = (new_log - batch_old_log[idx]).exp(); unclipped = ratio * batch_adv[idx]; clipped = torch.clamp(ratio, .8, 1.2) * batch_adv[idx]
                policy_loss = -torch.min(unclipped, clipped).mean(); value_loss = .5 * (value - batch_returns[idx]).pow(2).mean(); entropy = dist.entropy().mean()
                loss = policy_loss + .5 * value_loss - .01 * entropy
                optimizer.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), .5); optimizer.step()
        completed_steps += horizon * num_envs; update += 1
        if not captured_middle and completed_steps >= total_steps * .5:
            learning_snapshots.append(capture_trajectory(torch, model, tracks, rewards, device, "Middle · 50%"))
            captured_middle = True
        if update % 2 == 0 or completed_steps >= total_steps:
            mean_reward = sum(recent_rewards[-4096:]) / max(1, len(recent_rewards[-4096:]))
            message = f"{min(completed_steps, total_steps):,}/{total_steps:,} steps · reward {mean_reward:.3f}"
            logs.append(message); logs = logs[-12:]
            if callback: callback({"status": "running", "step": min(completed_steps, total_steps), "totalSteps": total_steps, "meanReward": mean_reward, "device": str(device).upper(), "logs": logs[:]})

    per_track, snapshots = evaluate(torch, model, tracks, rewards, device)
    finish_rate = sum(item["finishRate"] for item in per_track) / len(per_track)
    off_rate = sum(item["offTrackRate"] for item in per_track) / len(per_track)
    certified = finish_rate >= .95 and all(item["finishRate"] >= .5 for item in per_track) and off_rate < .06
    metadata = {
        "id": f"player-ppo-{uuid.uuid4().hex[:10]}", "name": config.get("name") or "My KartBlitz PPO Driver",
        "observationNames": OBSERVATION_NAMES,
        "training": {"algorithm": "PPO", "totalSteps": total_steps, "numEnvs": num_envs, "tracks": list(range(len(tracks))), "rewardWeights": rewards, "device": str(device), "seed": seed, "createdAt": int(time.time() * 1000)},
        "evaluation": {"status": "high-speed-certified" if certified else "needs-more-training", "simulatedFinishRate": finish_rate, "simulatedOffTrackRate": off_rate, "perTrack": per_track, "browserValidationRequired": True},
    }
    final_snapshot = next((snapshot for snapshot in snapshots if snapshot["trackId"] == 0), capture_trajectory(torch, model, tracks, rewards, device, "Final"))
    final_snapshot["label"] = "Final · trained"
    return {"model": export_actor(model, metadata), "snapshots": learning_snapshots + [final_snapshot], "metrics": metadata["evaluation"]}


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a KartBlitz PPO driver across all tracks")
    parser.add_argument("--steps", type=int, default=150_000); parser.add_argument("--envs", type=int, default=64)
    parser.add_argument("--output", type=Path, default=Path("ml_training/runs/player-model.kartml.json")); parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(); result = train_model({"totalSteps": args.steps, "numEnvs": args.envs, "seed": args.seed, "tracks": "all"}, lambda p: print(p["logs"][-1], flush=True))
    args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(result["model"], indent=2), encoding="utf-8"); print(f"Saved {args.output}")


if __name__ == "__main__": main()
