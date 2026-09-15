from __future__ import annotations

from typing import Any


def build_actor_critic(torch: Any, observation_count: int = 14, action_count: int = 9):
    nn = torch.nn

    class ActorCritic(nn.Module):
        def __init__(self):
            super().__init__()
            self.actor = nn.Sequential(nn.Linear(observation_count, 64), nn.Tanh(), nn.Linear(64, 64), nn.Tanh(), nn.Linear(64, action_count))
            self.critic = nn.Sequential(nn.Linear(observation_count, 64), nn.Tanh(), nn.Linear(64, 64), nn.Tanh(), nn.Linear(64, 1))

        def forward(self, observations):
            return self.actor(observations), self.critic(observations).squeeze(-1)

    return ActorCritic()


def export_actor(model: Any, metadata: dict[str, Any]) -> dict[str, Any]:
    linear_layers = [layer for layer in model.actor if layer.__class__.__name__ == "Linear"]
    layers = []
    for layer in linear_layers:
        layers.append({
            "kernel": layer.weight.detach().cpu().tolist(),
            "bias": layer.bias.detach().cpu().tolist(),
        })
    return {
        "format": "kartblitz-ml-v1",
        "formatVersion": 1,
        "id": metadata["id"],
        "name": metadata["name"],
        "source": "player",
        "description": "A PPO driving policy trained against KartBlitz track-relative sensors.",
        "observationVersion": 1,
        "observationCount": 14,
        "observationNames": metadata["observationNames"],
        "actionSpace": "discrete-9",
        "policy": {"activation": "tanh", "layers": layers},
        "training": metadata["training"],
        "evaluation": metadata["evaluation"],
    }

