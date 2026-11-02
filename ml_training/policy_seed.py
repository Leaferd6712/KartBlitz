"""Convert a measured V2 JSON actor into a fresh PPO checkpoint without imitation loss."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import torch
from .official_environment_v2 import EnergyVecEnv
from .official_train_v2 import new_policy, campaign_is_live, write_json
from .official_train import save_checkpoint


def import_actor(model, pack, metadata, difficulty):
    if pack.get('format') != 'kartblitz-official-track-v2' or pack.get('observationVersion') != 2 or pack.get('actionCount') != 4:
        raise ValueError('A current V2 package is required; run old models through R&D first')
    for key in ['physicsHash', 'observationNames', 'actionNames']:
        if pack.get(key) != metadata[key]:
            raise ValueError('Policy contract mismatch: ' + key)
    track_id = pack.get('trackId')
    if not isinstance(track_id, int) or not 0 <= track_id <= 7 or pack.get('trackFingerprint') != metadata['tracks'][track_id]['fingerprint']:
        raise ValueError('Policy track geometry differs')
    policy = pack.get('variants', {}).get(difficulty, {}).get('policy', {})
    if policy.get('activation') != 'tanh' or policy.get('output') != 'clipped-linear':
        raise ValueError('Unsupported policy activation')
    linears = [layer for layer in [*model.policy.mlp_extractor.policy_net, model.policy.action_net] if isinstance(layer, torch.nn.Linear)]
    layers = policy.get('layers', [])
    if len(layers) != len(linears):
        raise ValueError('Policy architecture differs from PPO seed')
    tensors = []
    for layer, definition in zip(linears, layers):
        weights = np.asarray(definition['kernel'], dtype=np.float32)
        bias = np.asarray(definition['bias'], dtype=np.float32)
        if weights.shape != tuple(layer.weight.shape) or bias.shape != tuple(layer.bias.shape) or not np.isfinite(weights).all() or not np.isfinite(bias).all():
            raise ValueError('Policy layer dimensions or values differ')
        tensors.append((layer, weights, bias))
    # Validate all layers before changing even the first tensor.
    with torch.no_grad():
        for layer, weights, bias in tensors:
            layer.weight.copy_(torch.as_tensor(weights, device=model.device))
            layer.bias.copy_(torch.as_tensor(bias, device=model.device))
    return model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--difficulty', default='extreme')
    args = parser.parse_args()
    if campaign_is_live():
        parser.error('A live or inaccessible V1 manager prevents creating a new training seed')
    if args.output.exists():
        parser.error('Choose a new output directory; existing checkpoints are immutable')
    raw = args.candidate.read_bytes(); pack = json.loads(raw)
    track_id = pack.get('trackId')
    if not isinstance(track_id, int) or not 0 <= track_id <= 7:
        parser.error('Invalid candidate track')
    config = {'trackId': track_id, 'difficulty': args.difficulty, 'gamma': .9995, 'seed': 42, 'numEnvs': 1, 'workers': 1, 'device': 'cpu'}
    env = EnergyVecEnv(config)
    try:
        model = import_actor(new_policy(env, config), pack, env.metadata, args.difficulty)
        args.output.mkdir(parents=True)
        save_checkpoint(model, args.output / 'last.zip')
        write_json(args.output / 'contract.json', {'trackId': track_id, 'physicsHash': env.physics_hash, 'modelGeneration': 2,
            'observationNames': env.metadata['observationNames'], 'actionNames': env.metadata['actionNames'], 'config': config,
            'source': str(args.candidate.resolve()), 'sourceSha256': hashlib.sha256(raw).hexdigest(), 'approved': False,
            'note': 'Actor copied exactly; critic and optimiser are fresh. PPO training has not run.'})
        print(json.dumps({'output': str(args.output.resolve()), 'rlSteps': model.num_timesteps, 'optimiserStateEntries': len(model.policy.optimizer.state), 'approved': False}))
    finally:
        env.close()


if __name__ == '__main__':
    main()
