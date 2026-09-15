from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

OBSERVATION_NAMES = [
    "speed_norm", "lateral_norm", "heading_sin",
    "look_near_sin", "look_mid_sin", "look_far_sin",
    "curvature_near", "curvature_mid", "curvature_far",
    "corner_demand", "target_speed_error", "off_track",
    "progress_delta", "stuck",
]

ACTIONS = [
    (1, 0, -1), (1, 0, 0), (1, 0, 1),
    (0, 0, -1), (0, 0, 0), (0, 0, 1),
    (0, 1, -1), (0, 1, 0), (0, 1, 1),
]


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
    progress: float = 1.0
    speed: float = 0.25
    center: float = 0.18
    offTrack: float = 1.2
    stuck: float = 0.8
    lap: float = 2.0


class KartTrackEnv:
    """Fast curriculum environment driven by KartBlitz's exported track geometry.

    It intentionally uses a compact kinematic approximation for throughput. Final
    weights must still pass evaluation inside the real browser physics.
    """

    DT = 1.0 / 30.0
    MAX_SPEED = 520.0
    ACCEL = 150.0
    BRAKE = 660.0
    TURN_RATE = 2.9

    def __init__(self, tracks: list[dict[str, Any]], rewards: dict[str, float] | None = None, seed: int = 0):
        self.tracks = tracks
        allowed = RewardWeights.__dataclass_fields__
        values = {k: float(v) for k, v in (rewards or {}).items() if k in allowed}
        self.reward_weights = RewardWeights(**values)
        self.random = random.Random(seed)
        self.track: dict[str, Any] = tracks[0]
        self.track_index = 0
        self.x = self.y = self.angle = self.speed = 0.0
        self.nearest = 0
        self.previous_progress = 0.0
        self.stuck_steps = 0
        self.steps = 0
        self.laps = 0
        self.off_track = False
        self.reset()

    def reset(self, track_index: int | None = None, random_start: bool = True) -> list[float]:
        self.track_index = self.random.randrange(len(self.tracks)) if track_index is None else track_index % len(self.tracks)
        self.track = self.tracks[self.track_index]
        spline = self.track["spline"]
        self.nearest = self.random.randrange(len(spline)) if random_start else 0
        point = spline[self.nearest]
        tx, ty, heading = tangent(spline, self.nearest)
        width = max(30.0, float(self.track.get("trackWidth", 160)))
        lateral = self.random.uniform(-0.18, 0.18) * width if random_start else 0.0
        self.x, self.y = point["x"] - ty * lateral, point["y"] + tx * lateral
        self.angle = heading + (self.random.uniform(-0.08, 0.08) if random_start else 0.0)
        self.speed = self.random.uniform(50.0, 230.0) if random_start else 0.0
        self.previous_progress = self.nearest / len(spline)
        self.stuck_steps = self.steps = self.laps = 0
        self.off_track = False
        return self.observe(0.0)

    def _nearest_index(self) -> tuple[int, float]:
        spline = self.track["spline"]
        count, best, best_distance = len(spline), self.nearest, float("inf")
        for delta in range(-18, 88):
            index = (self.nearest + delta) % count
            p = spline[index]
            distance = (self.x - p["x"]) ** 2 + (self.y - p["y"]) ** 2
            if distance < best_distance:
                best, best_distance = index, distance
        return best, math.sqrt(best_distance)

    def observe(self, progress_delta: float) -> list[float]:
        spline, count = self.track["spline"], len(self.track["spline"])
        idx, distance = self._nearest_index()
        self.nearest = idx
        tx, ty, heading = tangent(spline, idx)
        center = spline[idx]
        width = max(30.0, float(self.track.get("trackWidth", 160)))
        lateral = ((self.x - center["x"]) * -ty + (self.y - center["y"]) * tx) / (width * 0.5)
        near, mid, far = max(6, round(count * .012)), max(14, round(count * .032)), max(28, round(count * .065))

        def look(offset: int) -> float:
            p = spline[(idx + offset) % count]
            return math.sin(wrap(math.atan2(p["y"] - self.y, p["x"] - self.x) - self.angle))

        near_look, mid_look, far_look = look(near), look(mid), look(far)
        cn = signed_curvature(spline, (idx + near) % count, max(3, round(near * .5)))
        cm = signed_curvature(spline, (idx + mid) % count, max(4, round(mid * .35)))
        cf = signed_curvature(spline, (idx + far) % count, max(5, round(far * .25)))
        speed_norm = clamp(abs(self.speed) / self.MAX_SPEED, 0.0, 1.5)
        corner = clamp(max(abs(near_look), abs(mid_look) * .92, abs(far_look) * .72, abs(cn) * 1.3, abs(cm) * 1.1) * (.45 + speed_norm * .75), 0.0, 1.5)
        target_speed = clamp(1.04 - corner * .78, .30, 1.02)
        self.off_track = distance > width * .52
        return [speed_norm, clamp(lateral, -2, 2), math.sin(wrap(heading - self.angle)), near_look, mid_look, far_look,
                cn, cm, cf, corner, clamp(speed_norm - target_speed, -1.2, 1.2), float(self.off_track),
                clamp(progress_delta * count * .2, -1, 1), float(self.stuck_steps > 45)]

    def step(self, action: int) -> tuple[list[float], float, bool, dict[str, Any]]:
        throttle, brake, steer = ACTIONS[int(action) % len(ACTIONS)]
        previous_idx = self.nearest
        speed_ratio = clamp(abs(self.speed) / self.MAX_SPEED, 0.0, 1.2)
        if throttle:
            self.speed += self.ACCEL * (1.0 - min(1.0, speed_ratio) * .58) * self.DT
        elif brake:
            self.speed -= self.BRAKE * self.DT
        else:
            self.speed *= .9915 ** (self.DT * 60)
        self.speed = clamp(self.speed, 0, self.MAX_SPEED)
        grip = .55 if self.off_track else 1.0
        self.angle += steer * self.TURN_RATE * self.DT * (.32 + .68 * min(1, speed_ratio)) * grip
        self.x += math.cos(self.angle) * self.speed * self.DT
        self.y += math.sin(self.angle) * self.speed * self.DT
        if self.off_track:
            self.speed *= .972 ** (self.DT * 60)
        idx, _ = self._nearest_index()
        count = len(self.track["spline"])
        delta_idx = idx - previous_idx
        if delta_idx < -count / 2: delta_idx += count
        if delta_idx > count / 2: delta_idx -= count
        progress_delta = delta_idx / count
        if previous_idx > count * .82 and idx < count * .18 and delta_idx > 0:
            self.laps += 1
        self.nearest = idx
        if self.speed < 16 or progress_delta <= 0:
            self.stuck_steps += 1
        else:
            self.stuck_steps = max(0, self.stuck_steps - 2)
        obs = self.observe(progress_delta)
        alignment = max(0.0, math.cos(math.asin(clamp(obs[2], -1, 1))))
        rw = self.reward_weights
        reward = rw.progress * progress_delta * count * 2.8
        reward += rw.speed * obs[0] * alignment * (0 if self.off_track else 1) * .05
        reward += rw.center * max(0.0, 1.0 - abs(obs[1])) * .025
        reward -= rw.offTrack * float(self.off_track) * .055
        reward -= rw.stuck * float(self.stuck_steps > 45) * .06
        if self.laps > 0: reward += rw.lap
        self.steps += 1
        done = self.steps >= 30 * 75 or self.stuck_steps > 300 or abs(obs[1]) > 2.4 or self.laps > 0
        return obs, reward, done, {"track": self.track_index, "lap": self.laps, "offTrack": self.off_track, "progress": idx / count}
