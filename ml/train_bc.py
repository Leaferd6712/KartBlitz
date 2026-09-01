"""Behavior Cloning trainer — imitation learning from human demos."""
from __future__ import annotations

import argparse
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import DataLoader, random_split
from torch.utils.tensorboard import SummaryWriter

from dataset import DemoDataset, load_demo_frames

N_OBS = 10
N_ACT = 9


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
    p = argparse.ArgumentParser(description="KartBlitz Behavior Cloning")
    p.add_argument("--demos", default="sim/rl/demos")
    p.add_argument("--epochs", type=int, default=80)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--hidden", type=int, default=128)
    p.add_argument("--val-frac", type=float, default=0.15)
    p.add_argument("--out", default="sim/rl/models/bc_best.pt")
    p.add_argument("--logdir", default="ml/runs/bc")
    return p.parse_args()


def main():
    args = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    obs, actions = load_demo_frames(args.demos)
    print(f"Loaded {len(obs)} frames from {args.demos}")

    ds = DemoDataset(obs, actions)
    n_val = max(1, int(len(ds) * args.val_frac))
    n_train = len(ds) - n_val
    train_ds, val_ds = random_split(ds, [n_train, n_val], generator=torch.Generator().manual_seed(42))

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size)

    model = PolicyMLP(args.hidden).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    loss_fn = nn.CrossEntropyLoss()
    writer = SummaryWriter(args.logdir)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    best_acc = 0.0

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            opt.zero_grad()
            logits = model(xb)
            loss = loss_fn(logits, yb)
            loss.backward()
            opt.step()
            total_loss += loss.item() * len(xb)

        model.eval()
        correct = 0
        val_loss = 0.0
        with torch.no_grad():
            for xb, yb in val_loader:
                xb, yb = xb.to(device), yb.to(device)
                logits = model(xb)
                val_loss += loss_fn(logits, yb).item() * len(xb)
                correct += (logits.argmax(1) == yb).sum().item()

        train_loss = total_loss / n_train
        val_loss /= n_val
        acc = correct / n_val
        writer.add_scalar("loss/train", train_loss, epoch)
        writer.add_scalar("loss/val", val_loss, epoch)
        writer.add_scalar("accuracy/val", acc, epoch)

        if acc > best_acc:
            best_acc = acc
            torch.save(
                {
                    "type": "mlp",
                    "hidden": args.hidden,
                    "state_dict": model.state_dict(),
                    "val_acc": acc,
                    "epoch": epoch,
                },
                out_path,
            )

        if epoch % 10 == 0 or epoch == 1:
            print(f"epoch {epoch:4d}  train_loss {train_loss:.4f}  val_loss {val_loss:.4f}  val_acc {acc:.3f}")

    writer.close()
    print(f"Best val acc {best_acc:.3f} → {out_path}")
    print(f"Export: python ml/policy_export.py --checkpoint {out_path}")


if __name__ == "__main__":
    main()
