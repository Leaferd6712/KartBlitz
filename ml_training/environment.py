from __future__ import annotations

import bisect
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


OBSERVATION_NAMES = [
    "speed_norm", "lateral_norm", "heading_sin", "heading_cos",
    "look_80_sin", "look_180_sin", "look_360_sin", "look_650_sin",
    "curvature_80", "curvature_180", "curvature_360", "curvature_peak",
    "edge_margin", "target_speed_error", "off_track", "progress_velocity",
    "yaw_rate", "previous_steer", "previous_throttle", "previous_brake",
    "ers_charge", "drs_available", "tyre_grip", "stuck",
]

ACTION_NAMES = ["steer", "drive", "brake"]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value if math.isfinite(value) else 0.0))


def wrap(angle: float) -> float:
    while angle > math.pi:
        angle -= math.pi * 2
    while angle < -math.pi:
        angle += math.pi * 2
    return angle


def load_tracks(root: Path | None = None) -> list[dict[str, Any]]:
    project = root or Path(__file__).resolve().parents[1]
    payload = json.loads((project / "sim" / "tracks" / "bakes.json").read_text(encoding="utf-8"))
    tracks = payload.get("tracks", payload)
    if isinstance(tracks, dict):
        tracks = [tracks[key] for key in sorted(tracks, key=lambda item: int(item))]
    if not isinstance(tracks, list) or not tracks:
        raise RuntimeError("No KartBlitz track bakes were found")
    return tracks


def tangent(spline: list[dict[str, float]], index: int, gap: int = 3) -> tuple[float, float, float]:
    count = len(spline)
    a, b = spline[(index - gap) % count], spline[(index + gap) % count]
    dx, dy = b["x"] - a["x"], b["y"] - a["y"]
    length = math.hypot(dx, dy) or 1.0
    return dx / length, dy / length, math.atan2(dy, dx)


def signed_curvature(spline: list[dict[str, float]], index: int, gap: int) -> float:
    count = len(spline)
    a, b, c = spline[(index - gap) % count], spline[index], spline[(index + gap) % count]
    abx, aby = b["x"] - a["x"], b["y"] - a["y"]
    bcx, bcy = c["x"] - b["x"], c["y"] - b["y"]
    al, bl = math.hypot(abx, aby) or 1.0, math.hypot(bcx, bcy) or 1.0
    return clamp((abx / al) * (bcy / bl) - (aby / al) * (bcx / bl), -1.0, 1.0)


@dataclass
class RewardWeights:
    progress: float = 1.00
    speed: float = 0.20
    line: float = 0.15
    heading: float = 0.20
    offTrack: float = 1.50
    smoothness: float = 0.05
    stuck: float = 1.00
    lap: float = 3.00


class KartTrackEnv:
    """Fast, curriculum-ready approximation of the KartBlitz driving physics.

    Training randomizes kart grip and power so the policy cannot memorize one
    exact simulator. Exported policies must still pass evaluation in the browser;
    this environment is deliberately treated as a training approximation.
    """

    # The browser controller is queried by the game's 60 Hz physics update.
    DT = 1.0 / 60.0
    MAX_EPISODE_STEPS = 60 * 95

    def __init__(
        self,
        tracks: list[dict[str, Any]],
        rewards: dict[str, float] | None = None,
        seed: int = 0,
        domain_randomization: bool = True,
    ):
        self.tracks = tracks
        allowed = RewardWeights.__dataclass_fields__
        values = {key: float(value) for key, value in (rewards or {}).items() if key in allowed}
        self.reward_weights = RewardWeights(**values)
        self.random = random.Random(seed)
        self.domain_randomization = domain_randomization
        self.curriculum = 1.0
        self.track: dict[str, Any] = tracks[0]
        self.track_index = 0
        self.x = self.y = self.angle = self.speed = 0.0
        self.nearest = self.previous_nearest = 0
        self.stuck_steps = self.steps = self.laps = 0
        self.off_track = False
        self.previous_steer = self.previous_throttle = self.previous_brake = 0.0
        self.previous_angle = 0.0
        self.last_progress_velocity = 0.0
        self.episode_off_steps = 0
        self.episode_speed_sum = 0.0
        self.max_speed = 520.0
        self.accel = 133.2
        self.brake = 150.0
        self.turn_rate = 2.88
        self.tyre_grip = 1.0
        self.reset()

    def set_curriculum(self, fraction: float) -> None:
        self.curriculum = clamp(float(fraction), 0.0, 1.0)

    def _available_track_count(self) -> int:
        if self.curriculum < 0.20:
            return min(2, len(self.tracks))
        if self.curriculum < 0.45:
            return min(4, len(self.tracks))
        return len(self.tracks)

    def _randomize_dynamics(self) -> None:
        strength = self.curriculum if self.domain_randomization else 0.0
        self.max_speed = 520.0 * self.random.uniform(1 - .08 * strength, 1 + .08 * strength)
        self.accel = 133.2 * self.random.uniform(1 - .10 * strength, 1 + .10 * strength)
        self.turn_rate = 2.88 * self.random.uniform(1 - .07 * strength, 1 + .07 * strength)
        self.tyre_grip = self.random.uniform(1 - .15 * strength, 1 + .10 * strength)
        self.brake = 150.0 * self.random.uniform(1 - .08 * strength, 1 + .08 * strength)

    def reset(self, track_index: int | None = None, random_start: bool = True) -> list[float]:
        available = self._available_track_count()
        self.track_index = self.random.randrange(available) if track_index is None else track_index % len(self.tracks)
        self.track = self.tracks[self.track_index]
        self._randomize_dynamics()
        spline = self.track["spline"]
        self.nearest = self.random.randrange(len(spline)) if random_start else 0
        self.previous_nearest = self.nearest
        point = spline[self.nearest]
        tx, ty, heading = tangent(spline, self.nearest)
        width = max(30.0, float(self.track.get("trackWidth", 160)))
        perturb = .06 + .26 * self.curriculum
        lateral = self.random.uniform(-perturb, perturb) * width if random_start else 0.0
        self.x, self.y = point["x"] - ty * lateral, point["y"] + tx * lateral
        self.angle = heading + (self.random.uniform(-.04 - .18 * self.curriculum, .04 + .18 * self.curriculum) if random_start else 0.0)
        max_start = 90.0 + 230.0 * self.curriculum
        self.speed = self.random.uniform(35.0, max_start) if random_start else 0.0
        self.previous_angle = self.angle
        self.previous_steer = self.previous_throttle = self.previous_brake = 0.0
        self.last_progress_velocity = 0.0
        self.stuck_steps = self.steps = self.laps = self.episode_off_steps = 0
        self.episode_speed_sum = 0.0
        self.off_track = False
        return self.observe()

    def _nearest_index(self) -> tuple[int, float]:
        spline = self.track["spline"]
        count, best, best_distance = len(spline), self.nearest, float("inf")
        for delta in range(-20, 90):
            index = (self.nearest + delta) % count
            point = spline[index]
            distance = (self.x - point["x"]) ** 2 + (self.y - point["y"]) ** 2
            if distance < best_distance:
                best, best_distance = index, distance
        return best, math.sqrt(best_distance)

    def _index_at_distance(self, start: int, distance: float) -> int:
        spline = self.track["spline"]
        count = len(spline)
        cumulative = self.track.get("cum")
        total = float(self.track.get("totalLen") or 0)
        if not isinstance(cumulative, list) or len(cumulative) != count or total <= 0:
            return (start + max(1, round(count * distance / max(1.0, total or count * 18)))) % count
        target = (float(cumulative[start]) + distance) % total
        return min(count - 1, bisect.bisect_left(cumulative, target))

    def observe(self) -> list[float]:
        spline, count = self.track["spline"], len(self.track["spline"])
        idx, distance = self._nearest_index()
        self.nearest = idx
        tx, ty, heading = tangent(spline, idx)
        center = spline[idx]
        width = max(30.0, float(self.track.get("trackWidth", 160)))
        lateral = ((self.x - center["x"]) * -ty + (self.y - center["y"]) * tx) / (width * .5)
        look_indices = [self._index_at_distance(idx, distance) for distance in (80, 180, 360, 650)]
        looks = [math.sin(wrap(math.atan2(spline[i]["y"] - self.y, spline[i]["x"] - self.x) - self.angle)) for i in look_indices]
        gap = max(3, round(count * .008))
        curves = [signed_curvature(spline, i, gap) for i in look_indices[:3]]
        peak = 0.0
        for distance_ahead in range(60, 701, 55):
            value = signed_curvature(spline, self._index_at_distance(idx, distance_ahead), gap)
            if abs(value) > abs(peak):
                peak = value
        speed_norm = clamp(abs(self.speed) / max(1.0, self.max_speed), 0.0, 1.5)
        corner_demand = clamp(max(abs(looks[0]), abs(looks[1]) * .9, abs(looks[2]) * .72,
                                  abs(curves[0]) * 1.35, abs(curves[1]) * 1.15, abs(peak)) * (.42 + speed_norm * .78), 0.0, 1.5)
        target_speed = clamp(1.05 - corner_demand * .76, .28, 1.04)
        heading_error = wrap(heading - self.angle)
        yaw_rate = clamp(wrap(self.angle - self.previous_angle) / .11, -1.5, 1.5)
        self.off_track = distance > width * .52
        return [
            speed_norm, clamp(lateral, -2.5, 2.5), math.sin(heading_error), math.cos(heading_error),
            *looks, *curves, peak, clamp(1 - abs(lateral), -1.5, 1),
            clamp(speed_norm - target_speed, -1.2, 1.2), float(self.off_track),
            clamp(self.last_progress_velocity, -1.5, 1.5), yaw_rate,
            self.previous_steer, self.previous_throttle, self.previous_brake,
            0.0, 0.0, clamp(self.tyre_grip, 0.0, 1.5), float(self.stuck_steps > 45),
        ]

    def step(self, action: Sequence[float]) -> tuple[list[float], float, bool, dict[str, Any]]:
        if len(action) != 3:
            raise ValueError("Continuous KartBlitz actions require [steer, drive, brake]")
        target_steer = clamp(float(action[0]), -1.0, 1.0)
        target_throttle = (clamp(float(action[1]), -1.0, 1.0) + 1.0) * .5
        target_brake = (clamp(float(action[2]), -1.0, 1.0) + 1.0) * .5
        if target_brake > .12:
            target_throttle *= max(0.0, 1 - target_brake * 1.35)
        if target_brake < .045:
            target_brake = 0.0
        steer = self.previous_steer + (target_steer - self.previous_steer) * .42
        throttle = self.previous_throttle + (target_throttle - self.previous_throttle) * .34
        brake = self.previous_brake + (target_brake - self.previous_brake) * .46
        old_controls = (self.previous_steer, self.previous_throttle, self.previous_brake)
        previous_idx = self.nearest
        previous_angle = self.angle

        # One policy decision per game-style 60 Hz physics step keeps smoothing,
        # yaw-rate and progress sensors aligned with browser inference.
        for _ in range(1):
            dt = self.DT
            speed_ratio = clamp(abs(self.speed) / self.max_speed, 0.0, 1.2)
            self.speed += self.accel * throttle * (1.0 - min(1.0, speed_ratio) * .58) * dt
            self.speed -= self.brake * brake * dt
            self.speed *= .9915 ** (dt * 60 * max(0.0, 1.0 - throttle))
            self.speed = clamp(self.speed, 0.0, self.max_speed)
            surface_grip = .55 if self.off_track else 1.0
            understeer = max(.24, 1.0 - speed_ratio ** 1.1 * .68)
            self.angle += steer * self.turn_rate * understeer * self.tyre_grip * surface_grip * dt
            self.x += math.cos(self.angle) * self.speed * dt
            self.y += math.sin(self.angle) * self.speed * dt
            if self.off_track:
                self.speed *= .972 ** (dt * 60)

        idx, _ = self._nearest_index()
        count = len(self.track["spline"])
        delta_idx = idx - previous_idx
        if delta_idx < -count / 2:
            delta_idx += count
        if delta_idx > count / 2:
            delta_idx -= count
        if previous_idx > count * .82 and idx < count * .18 and delta_idx > 0:
            self.laps += 1
        self.nearest = idx
        self.last_progress_velocity = clamp(delta_idx * .2, -1.5, 1.5)
        if self.speed < 16 or delta_idx < 0:
            self.stuck_steps += 1
        elif delta_idx > 0:
            self.stuck_steps = max(0, self.stuck_steps - 2)
        elif self.speed > 30:
            self.stuck_steps = max(0, self.stuck_steps - 1)
        self.previous_angle = previous_angle
        self.previous_steer, self.previous_throttle, self.previous_brake = steer, throttle, brake
        observation = self.observe()

        heading_alignment = max(0.0, observation[3])
        smoothness = abs(steer - old_controls[0]) + .5 * abs(throttle - old_controls[1]) + .5 * abs(brake - old_controls[2])
        weights = self.reward_weights
        reward = weights.progress * delta_idx * 2.8
        reward += weights.speed * observation[0] * heading_alignment * (0 if self.off_track else 1) * .025
        reward += weights.line * max(0.0, observation[12]) * .0125
        reward += weights.heading * heading_alignment * .01
        reward -= weights.offTrack * float(self.off_track) * .0275
        reward -= weights.smoothness * smoothness * .0125
        reward -= weights.stuck * float(self.stuck_steps > 45) * .03
        if self.laps > 0:
            reward += weights.lap

        self.steps += 1
        self.episode_off_steps += int(self.off_track)
        self.episode_speed_sum += self.speed
        done = self.steps >= self.MAX_EPISODE_STEPS or self.stuck_steps > 300 or abs(observation[1]) > 2.4 or self.laps > 0
        info = {
            "track": self.track_index,
            "lap": self.laps,
            "offTrack": self.off_track,
            "progress": idx / count,
            "lapTime": self.steps * self.DT if self.laps else None,
            "offTrackRate": self.episode_off_steps / max(1, self.steps),
            "meanSpeed": self.episode_speed_sum / max(1, self.steps),
            "terminated": "lap" if self.laps else ("stuck" if self.stuck_steps > 300 else "timeout" if self.steps >= self.MAX_EPISODE_STEPS else "bounds" if abs(observation[1]) > 2.4 else None),
        }
        return observation, reward, done, info


def expert_action(observation: Sequence[float]) -> list[float]:
    """A conservative teacher used only to warm-start the neural policy."""
    lateral = observation[1]
    heading = observation[2]
    near, middle, far = observation[4], observation[5], observation[6]
    curvature_peak = observation[11]
    target_speed_error = observation[13]
    off_track = observation[14]
    stuck = observation[23]
    steer = clamp(heading * 1.40 + near * 1.05 + middle * .42 + far * .12 - lateral * .74 + curvature_peak * .18, -1, 1)
    demand = max(abs(near), abs(middle) * .90, abs(far) * .62, abs(curvature_peak) * 1.35)
    overspeed = max(0.0, target_speed_error)
    brake_amount = clamp(overspeed * (2.0 + demand * .8), 0, 1)
    throttle_amount = clamp(.98 - demand * .55 - overspeed * 1.55, .20, 1.0)
    if off_track:
        steer = clamp(heading * 1.75 - lateral * 1.15 + near * .25, -1, 1)
        throttle_amount, brake_amount = .22, 0.0
    if stuck:
        steer = clamp(heading * 1.9 - lateral * 1.25, -1, 1)
        throttle_amount, brake_amount = .72, 0.0
    return [steer, throttle_amount * 2 - 1, brake_amount * 2 - 1]
