"""Export PyTorch checkpoint or linear policy to sim/rl/policy.json for game + browser eval."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
import torch.nn as nn

N_OBS = 10
N_ACT = 9
ACTION_NAMES = [
    "thr-L", "thr", "thr-R", "coast-L", "coast", "coast-R", "brk-L", "brk", "brk-R",
]


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

    def forward(self, x):
        h = self.body(x)
        return self.pi(h)


def mlp_to_json(model: nn.Module) -> dict:
    layers = []
    seq = model.net if hasattr(model, "net") else None
    if seq is None:
        raise ValueError("Unsupported model architecture")
    linears = [m for m in seq if isinstance(m, nn.Linear)]
    for i, lin in enumerate(linears):
        W = lin.weight.detach().cpu().numpy().flatten().tolist()
        b = lin.bias.detach().cpu().numpy().tolist()
        layers.append({"in": lin.in_features, "out": lin.out_features, "W": W, "b": b})
    return {
        "type": "mlp",
        "nObs": N_OBS,
        "nAct": N_ACT,
        "actions": ACTION_NAMES,
        "layers": layers,
    }


def linear_json_from_file(path: Path) -> dict:
    j = json.loads(path.read_text(encoding="utf-8"))
    if "W" in j and "b" in j:
        return j
    raise ValueError("Not a linear policy JSON")


def parse_args():
    p = argparse.ArgumentParser(description="Export KartBlitz policy.json")
    p.add_argument("--checkpoint", help="PyTorch .pt checkpoint")
    p.add_argument("--linear", help="Existing linear policy.json to copy")
    p.add_argument("--out", default="sim/rl/policy.json")
    p.add_argument("--hidden", type=int, default=128)
    return p.parse_args()


def main():
    args = parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    if args.linear:
        data = linear_json_from_file(Path(args.linear))
        out.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"Copied linear policy → {out}")
        return

    if not args.checkpoint:
        raise SystemExit("Provide --checkpoint or --linear")

    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    hidden = ckpt.get("hidden", args.hidden)

    if ckpt.get("actor_critic"):
        model = ActorCritic(hidden)
        model.load_state_dict(ckpt["state_dict"])
        layers = []
        for lin in [model.body[0], model.body[2], model.pi]:
            W = lin.weight.detach().cpu().numpy().flatten().tolist()
            b = lin.bias.detach().cpu().numpy().tolist()
            layers.append({"in": lin.in_features, "out": lin.out_features, "W": W, "b": b})
        data = {
            "type": "mlp",
            "nObs": N_OBS,
            "nAct": N_ACT,
            "actions": ACTION_NAMES,
            "layers": layers,
        }
    else:
        model = PolicyMLP(hidden)
        model.load_state_dict(ckpt["state_dict"])
        data = mlp_to_json(model)

    data["meta"] = {
        "source": str(args.checkpoint),
        "val_acc": ckpt.get("val_acc"),
        "reward": ckpt.get("reward"),
        "progress": ckpt.get("progress"),
    }
    out.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Exported MLP policy → {out}")


if __name__ == "__main__":
    main()
