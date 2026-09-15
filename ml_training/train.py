from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable

from .environment import KartTrackEnv, OBSERVATION_NAMES, expert_action, load_tracks
from .model import build_actor_critic, export_actor

ProgressCallback = Callable[[dict[str, Any]], None]


def _import_torch():
    try:
        import torch
        return torch
    except ImportError as exc:
        raise RuntimeError("PyTorch is not installed. Run ml_training/install.ps1 on the training computer first.") from exc


def _bounded(value: Any, default: float, low: float, high: float) -> float:
    try:
        return max(low, min(high, float(value)))
    except (TypeError, ValueError):
        return default


def split_training_budget(total_steps: Any) -> tuple[int, int, int]:
    """Return the bounded total, 10% imitation budget, and 90% PPO budget."""
    total = max(32_768, min(int(total_steps), 25_000_000))
    imitation = round(total * .10)
    return total, imitation, total - imitation


def _atanh(value: float) -> float:
    value = max(-.999, min(.999, value))
    return .5 * math.log((1 + value) / (1 - value))


def _iter_demo_samples(demonstrations: Any) -> Iterable[tuple[list[float], list[float]]]:
    if not isinstance(demonstrations, list):
        return
    for demonstration in demonstrations:
        samples = demonstration.get("samples", []) if isinstance(demonstration, dict) else []
        for sample in samples:
            observation = sample.get("observation") if isinstance(sample, dict) else None
            action = sample.get("action") if isinstance(sample, dict) else None
            if (isinstance(observation, list) and len(observation) == len(OBSERVATION_NAMES)
                    and isinstance(action, list) and len(action) == 3):
                try:
                    clean_observation = [float(value) for value in observation]
                    clean_action = [max(-1.0, min(1.0, float(value))) for value in action]
                except (TypeError, ValueError):
                    continue
                if all(math.isfinite(value) for value in clean_observation + clean_action):
                    yield clean_observation, clean_action


def collect_teacher_data(
    tracks: list[dict[str, Any]],
    rewards: dict[str, float],
    count: int,
    seed: int,
) -> list[tuple[list[float], list[float]]]:
    env = KartTrackEnv(tracks, rewards, seed=seed)
    env.set_curriculum(.72)
    observation = env.reset()
    samples: list[tuple[list[float], list[float]]] = []
    while len(samples) < count:
        action = expert_action(observation)
        # Small noise teaches recovery around the teacher's ideal trajectory.
        noisy = [max(-1, min(1, value + env.random.uniform(-.045, .045))) for value in action]
        samples.append((observation, action))
        observation, _, done, _ = env.step(noisy)
        if done:
            observation = env.reset()
    return samples


def imitation_warm_start(
    torch: Any,
    model: Any,
    optimizer: Any,
    samples: list[tuple[list[float], list[float]]],
    epochs: int,
    minibatch: int,
    device: Any,
    callback: ProgressCallback | None,
    logs: list[str],
    progress_budget: int,
    total_budget: int,
) -> None:
    if not samples or epochs <= 0:
        logs.append("Imitation warm-start skipped")
        return
    observations = torch.tensor([item[0] for item in samples], dtype=torch.float32, device=device)
    raw_targets = torch.tensor([[_atanh(value) for value in item[1]] for item in samples], dtype=torch.float32, device=device)
    for epoch in range(epochs):
        permutation = torch.randperm(len(samples), device=device)
        losses = []
        for start in range(0, len(samples), minibatch):
            indices = permutation[start:start + minibatch]
            means, _ = model(observations[indices])
            loss = torch.nn.functional.smooth_l1_loss(means, raw_targets[indices])
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), .5)
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        if epoch == epochs - 1 or epoch % max(1, epochs // 4) == 0:
            message = f"Imitation epoch {epoch + 1}/{epochs} - loss {statistics.fmean(losses):.4f}"
            logs.append(message)
            if callback:
                callback({
                    "status": "running", "phase": "imitation",
                    "step": round(progress_budget * (epoch + 1) / epochs),
                    "totalSteps": total_budget, "meanReward": None,
                    "imitationShare": .10, "reinforcementShare": .90,
                    "logs": logs[-16:],
                })


def deterministic_action(torch: Any, model: Any, observation: list[float], device: Any) -> list[float]:
    with torch.no_grad():
        means, _ = model(torch.tensor([observation], dtype=torch.float32, device=device))
        return torch.tanh(means[0]).cpu().tolist()


def capture_trajectory(
    torch: Any,
    model: Any,
    tracks: list[dict[str, Any]],
    rewards: dict[str, float],
    device: Any,
    label: str,
    track_id: int,
) -> dict[str, Any]:
    env = KartTrackEnv(tracks, rewards, seed=8128 + track_id, domain_randomization=False)
    env.set_curriculum(1)
    observation = env.reset(track_id, random_start=False)
    points = [{"x": round(env.x, 2), "y": round(env.y, 2), "offTrack": False, "speed": 0}]
    model.eval()
    info: dict[str, Any] = {}
    for step in range(env.MAX_EPISODE_STEPS):
        action = deterministic_action(torch, model, observation, device)
        observation, _, done, info = env.step(action)
        if step % 6 == 0:
            points.append({"x": round(env.x, 2), "y": round(env.y, 2), "offTrack": bool(env.off_track), "speed": round(env.speed, 1)})
        if done:
            break
    model.train()
    return {
        "trackId": track_id,
        "label": label,
        "points": points,
        "finished": bool(info.get("lap")),
        "lapTime": info.get("lapTime"),
        "offTrackRate": info.get("offTrackRate", 0),
    }


def capture_all_tracks(torch: Any, model: Any, tracks: list[dict[str, Any]], rewards: dict[str, float], device: Any, label: str) -> list[dict[str, Any]]:
    return [capture_trajectory(torch, model, tracks, rewards, device, label, track_id) for track_id in range(len(tracks))]


def evaluate(
    torch: Any,
    model: Any,
    tracks: list[dict[str, Any]],
    rewards: dict[str, float],
    device: Any,
    episodes: int = 5,
) -> list[dict[str, Any]]:
    metrics: list[dict[str, Any]] = []
    model.eval()
    for track_id in range(len(tracks)):
        finishes = off_steps = total_steps = recovery_failures = 0
        speeds: list[float] = []
        lap_times: list[float] = []
        for episode in range(episodes):
            env = KartTrackEnv(tracks, rewards, seed=9100 + track_id * 37 + episode, domain_randomization=True)
            env.set_curriculum(1)
            observation = env.reset(track_id, random_start=episode > 0)
            info: dict[str, Any] = {}
            for _ in range(env.MAX_EPISODE_STEPS):
                action = deterministic_action(torch, model, observation, device)
                observation, _, done, info = env.step(action)
                total_steps += 1
                off_steps += int(info["offTrack"])
                speeds.append(env.speed)
                if done:
                    break
            if info.get("lap"):
                finishes += 1
                if info.get("lapTime") is not None:
                    lap_times.append(float(info["lapTime"]))
            elif info.get("terminated") in ("stuck", "bounds"):
                recovery_failures += 1
        metrics.append({
            "trackId": track_id,
            "finishRate": finishes / episodes,
            "medianLapTime": round(statistics.median(lap_times), 3) if lap_times else None,
            "meanLapTime": round(statistics.fmean(lap_times), 3) if lap_times else None,
            "meanSpeed": round(statistics.fmean(speeds), 2) if speeds else 0,
            "offTrackRate": round(off_steps / max(1, total_steps), 5),
            "recoveryFailureRate": recovery_failures / episodes,
            "evaluationEpisodes": episodes,
        })
    model.train()
    return metrics


def train_model(config: dict[str, Any], callback: ProgressCallback | None = None) -> dict[str, Any]:
    torch = _import_torch()
    seed = int(config.get("seed", 42))
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    tracks = load_tracks()
    training_budget, imitation_steps, total_steps = split_training_budget(config.get("totalSteps", 3_000_000))
    imitation_share = .10
    num_envs = max(4, min(int(config.get("numEnvs", 48)), 128))
    horizon = max(64, min(int(config.get("horizon", 256)), 1024))
    epochs = max(1, min(int(config.get("epochs", 6)), 16))
    minibatch = max(128, min(int(config.get("minibatch", 2048)), horizon * num_envs))
    learning_rate = _bounded(config.get("learningRate"), 3e-4, 1e-6, 3e-3)
    gamma = _bounded(config.get("gamma"), .995, .90, .9999)
    gae_lambda = _bounded(config.get("gaeLambda"), .95, .80, 1.0)
    clip_range = _bounded(config.get("clipRange"), .20, .05, .40)
    entropy_weight = _bounded(config.get("entropy"), .008, 0, .08)
    max_grad_norm = _bounded(config.get("maxGradNorm"), .50, .10, 5.0)
    imitation_epochs = max(1, min(int(config.get("imitationEpochs", 3)), 12))
    rewards = config.get("rewards") or {}

    envs = [KartTrackEnv(tracks, rewards, seed + i * 31) for i in range(num_envs)]
    model = build_actor_critic(torch).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate, eps=1e-5)
    logs = [f"Loaded {len(tracks)} KartBlitz tracks", f"Neural updates: {str(device).upper()}", f"Rollout workers: {num_envs} CPU environments"]
    if callback:
        callback({"status": "running", "phase": "prepare", "step": 0, "totalSteps": training_budget, "meanReward": None, "device": str(device).upper(), "imitationShare": imitation_share, "reinforcementShare": 1 - imitation_share, "logs": logs[:]})

    human_samples = list(_iter_demo_samples(config.get("demonstrations")))[:imitation_steps]
    teacher_samples = max(0, imitation_steps - len(human_samples))
    generated_samples = collect_teacher_data(tracks, rewards, teacher_samples, seed + 7000) if teacher_samples else []
    warm_start_samples = generated_samples + human_samples
    logs.append(f"10% imitation: {len(generated_samples):,} heuristic + {len(human_samples):,} human samples")
    logs.append(f"90% reinforcement learning: {total_steps:,} PPO experience steps")
    imitation_warm_start(torch, model, optimizer, warm_start_samples, imitation_epochs, minibatch, device, callback, logs, imitation_steps, training_budget)
    snapshots = capture_all_tracks(torch, model, tracks, rewards, device, "Warm start")

    observations = torch.tensor([env.reset() for env in envs], dtype=torch.float32, device=device)
    completed_steps = update = 0
    recent_rewards: list[float] = []
    captured_middle = False

    while completed_steps < total_steps:
        curriculum = min(1.0, completed_steps / max(1, total_steps * .70))
        for env in envs:
            env.set_curriculum(curriculum)
        if callback and update % 4 == 0:
            callback({"status": "running", "phase": "rollout", "step": imitation_steps + min(completed_steps, total_steps), "totalSteps": training_budget, "meanReward": statistics.fmean(recent_rewards[-8192:]) if recent_rewards else None, "curriculum": curriculum, "device": str(device).upper(), "imitationShare": imitation_share, "reinforcementShare": 1 - imitation_share, "logs": logs[:]})
        obs_buf, raw_action_buf, log_buf, reward_buf, done_buf, value_buf = [], [], [], [], [], []
        for _ in range(horizon):
            with torch.no_grad():
                distribution, values = model.distribution(torch, observations)
                raw_actions = distribution.sample()
                log_probs = distribution.log_prob(raw_actions).sum(-1)
                bounded_actions = torch.tanh(raw_actions)
            next_observations, step_rewards, dones = [], [], []
            for index, env in enumerate(envs):
                observation, reward, done, _ = env.step(bounded_actions[index].cpu().tolist())
                if done:
                    observation = env.reset()
                next_observations.append(observation)
                step_rewards.append(reward)
                dones.append(done)
            obs_buf.append(observations)
            raw_action_buf.append(raw_actions)
            log_buf.append(log_probs)
            value_buf.append(values)
            reward_buf.append(torch.tensor(step_rewards, dtype=torch.float32, device=device))
            done_buf.append(torch.tensor(dones, dtype=torch.float32, device=device))
            observations = torch.tensor(next_observations, dtype=torch.float32, device=device)
            recent_rewards.extend(step_rewards)

        with torch.no_grad():
            _, next_value = model(observations)
        advantages = torch.zeros((horizon, num_envs), dtype=torch.float32, device=device)
        last_gae = torch.zeros(num_envs, dtype=torch.float32, device=device)
        for tick in reversed(range(horizon)):
            next_non_terminal = 1.0 - done_buf[tick]
            next_values = next_value if tick == horizon - 1 else value_buf[tick + 1]
            delta = reward_buf[tick] + gamma * next_values * next_non_terminal - value_buf[tick]
            last_gae = delta + gamma * gae_lambda * next_non_terminal * last_gae
            advantages[tick] = last_gae
        returns = advantages + torch.stack(value_buf)

        batch_observations = torch.cat(obs_buf)
        batch_raw_actions = torch.cat(raw_action_buf)
        batch_old_log = torch.cat(log_buf)
        batch_advantages = advantages.flatten()
        batch_returns = returns.flatten()
        batch_advantages = (batch_advantages - batch_advantages.mean()) / (batch_advantages.std() + 1e-8)
        batch_size = batch_observations.shape[0]
        policy_losses: list[float] = []
        for _ in range(epochs):
            permutation = torch.randperm(batch_size, device=device)
            for start in range(0, batch_size, minibatch):
                indices = permutation[start:start + minibatch]
                distribution, values = model.distribution(torch, batch_observations[indices])
                new_log = distribution.log_prob(batch_raw_actions[indices]).sum(-1)
                ratio = (new_log - batch_old_log[indices]).exp()
                unclipped = ratio * batch_advantages[indices]
                clipped = torch.clamp(ratio, 1 - clip_range, 1 + clip_range) * batch_advantages[indices]
                policy_loss = -torch.min(unclipped, clipped).mean()
                value_loss = .5 * (values - batch_returns[indices]).pow(2).mean()
                entropy = distribution.entropy().sum(-1).mean()
                loss = policy_loss + .5 * value_loss - entropy_weight * entropy
                optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
                optimizer.step()
                policy_losses.append(float(policy_loss.detach().cpu()))

        completed_steps += horizon * num_envs
        update += 1
        if not captured_middle and completed_steps >= total_steps * .5:
            snapshots.extend(capture_all_tracks(torch, model, tracks, rewards, device, "Middle - 50%"))
            captured_middle = True
        if update % 2 == 0 or completed_steps >= total_steps:
            mean_reward = statistics.fmean(recent_rewards[-8192:]) if recent_rewards else 0.0
            message = f"PPO {min(completed_steps, total_steps):,}/{total_steps:,} - reward {mean_reward:.3f} - curriculum {curriculum:.0%}"
            logs.append(message)
            logs = logs[-16:]
            if callback:
                callback({
                    "status": "running", "phase": "ppo", "step": imitation_steps + min(completed_steps, total_steps),
                    "totalSteps": training_budget, "meanReward": mean_reward,
                    "policyLoss": statistics.fmean(policy_losses) if policy_losses else None,
                    "curriculum": curriculum, "device": str(device).upper(), "logs": logs[:],
                })

    logs.append("Weights frozen - evaluating five randomized runs on every track")
    if callback:
        callback({"status": "running", "phase": "evaluation", "step": training_budget, "totalSteps": training_budget, "meanReward": statistics.fmean(recent_rewards[-8192:]) if recent_rewards else None, "device": str(device).upper(), "imitationShare": imitation_share, "reinforcementShare": 1 - imitation_share, "logs": logs[-16:]})
    snapshots.extend(capture_all_tracks(torch, model, tracks, rewards, device, "Final"))
    per_track = evaluate(torch, model, tracks, rewards, device, episodes=5)
    finish_rate = statistics.fmean(item["finishRate"] for item in per_track)
    off_rate = statistics.fmean(item["offTrackRate"] for item in per_track)
    recovery_rate = statistics.fmean(item["recoveryFailureRate"] for item in per_track)
    simulation_qualified = finish_rate >= .95 and all(item["finishRate"] >= .8 for item in per_track) and off_rate < .04
    evaluation = {
        "status": "simulation-qualified" if simulation_qualified else "needs-more-training",
        "simulatedFinishRate": round(finish_rate, 4),
        "simulatedOffTrackRate": round(off_rate, 5),
        "simulatedRecoveryFailureRate": round(recovery_rate, 4),
        "perTrack": per_track,
        "browserValidationRequired": True,
        "humanBenchmarkRequired": True,
        "humanLevelClaimed": False,
        "note": "A simulation pass is not proof of human-level pace. Validate exported weights in real KartBlitz races and compare median laps against players.",
    }
    metadata = {
        "id": f"player-ppo-{uuid.uuid4().hex[:10]}",
        "name": config.get("name") or "My KartBlitz PPO Driver",
        "observationNames": OBSERVATION_NAMES,
        "training": {
            "algorithm": "90% PPO reinforcement learning + 10% imitation warm-start", "totalSteps": training_budget, "reinforcementSteps": total_steps, "imitationShare": imitation_share, "reinforcementShare": 1 - imitation_share, "numEnvs": num_envs,
            "horizon": horizon, "epochs": epochs, "minibatch": minibatch, "learningRate": learning_rate,
            "gamma": gamma, "gaeLambda": gae_lambda, "clipRange": clip_range, "entropy": entropy_weight,
            "imitationEpochs": imitation_epochs, "teacherSamples": len(generated_samples), "humanSamples": len(human_samples),
            "tracks": list(range(len(tracks))), "rewardWeights": rewards, "domainRandomization": True,
            "curriculum": "2 tracks -> 4 tracks -> all tracks + full randomization",
            "device": str(device), "seed": seed, "createdAt": int(time.time() * 1000), "replay": snapshots,
        },
        "evaluation": evaluation,
    }
    exported = export_actor(model, metadata)
    return {"model": exported, "snapshots": snapshots, "metrics": evaluation}


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a continuous KartBlitz PPO driver across all tracks")
    parser.add_argument("--steps", type=int, default=3_000_000)
    parser.add_argument("--envs", type=int, default=48)
    parser.add_argument("--output", type=Path, default=Path("ml_training/runs/player-model.kartml.json"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--demo", type=Path, action="append", default=[], help="Human demonstration JSON exported by ML Lab; repeatable")
    args = parser.parse_args()
    demonstrations = []
    for path in args.demo:
        payload = json.loads(path.read_text(encoding="utf-8"))
        demonstrations.extend(payload.get("demonstrations", [payload]) if isinstance(payload, dict) else payload)
    result = train_model(
        {"totalSteps": args.steps, "numEnvs": args.envs, "seed": args.seed, "tracks": "all", "demonstrations": demonstrations},
        lambda progress: print(progress["logs"][-1], flush=True),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result["model"], separators=(",", ":")), encoding="utf-8")
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
