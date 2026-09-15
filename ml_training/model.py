from __future__ import annotations

from typing import Any


def build_actor_critic(torch: Any, observation_count: int = 24, action_count: int = 3, hidden_size: int = 128):
    nn = torch.nn

    class ActorCritic(nn.Module):
        def __init__(self):
            super().__init__()
            self.actor = nn.Sequential(
                nn.Linear(observation_count, hidden_size), nn.Tanh(),
                nn.Linear(hidden_size, hidden_size), nn.Tanh(),
                nn.Linear(hidden_size, action_count),
            )
            self.critic = nn.Sequential(
                nn.Linear(observation_count, hidden_size), nn.Tanh(),
                nn.Linear(hidden_size, hidden_size), nn.Tanh(),
                nn.Linear(hidden_size, 1),
            )
            # PPO learns exploration noise. It is not exported: races use the
            # deterministic actor mean so identical situations stay repeatable.
            self.log_std = nn.Parameter(torch.full((action_count,), -.70))

        def forward(self, observations):
            return self.actor(observations), self.critic(observations).squeeze(-1)

        def distribution(self, torch_module: Any, observations):
            means, values = self(observations)
            std = self.log_std.exp().expand_as(means)
            return torch_module.distributions.Normal(means, std), values

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
        "formatVersion": 2,
        "id": metadata["id"],
        "name": metadata["name"],
        "source": "player",
        "description": "A continuous-control PPO policy trained on every KartBlitz track.",
        "observationVersion": 2,
        "observationCount": 24,
        "observationNames": metadata["observationNames"],
        "actionSpace": "continuous-3-v2",
        "actionNames": ["steer", "drive", "brake"],
        "policy": {"activation": "tanh", "layers": layers},
        "training": metadata["training"],
        "evaluation": metadata["evaluation"],
    }
