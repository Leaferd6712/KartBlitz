"""Fit an opt-in V2 PPO actor to clean planner examples; never promote or activate it."""
from __future__ import annotations
import argparse
import gzip
import json
import time
import copy
from pathlib import Path
import numpy as np
import torch
from .official_environment_v2 import EnergyVecEnv
from .official_train_v2 import new_policy, warm_start, write_json, campaign_is_live
from .official_train import ROOT, export_policy, save_checkpoint


def load_examples(path, metadata, track_id):
    with gzip.open(path, 'rt', encoding='utf-8') as stream:
        data = json.load(stream)
    if data.get('format') != 'kartblitz-pace-demonstrations-v1':
        raise ValueError('Unsupported demonstration format')
    for key in ['physicsHash', 'observationNames', 'actionNames']:
        if data.get(key) != metadata[key]:
            raise ValueError('Demonstration contract mismatch: ' + key)
    if data.get('trackId') != track_id or data.get('trackFingerprint') != metadata['tracks'][track_id]['fingerprint']:
        raise ValueError('Demonstration track differs')
    if data.get('difficulty') != 'extreme':
        raise ValueError('Pace R&D currently accepts Extreme examples only')
    observations, actions, groups = [], [], []
    episodes = data.get('episodes', [])
    for episode_id, episode in enumerate(episodes):
        result = episode.get('result', {})
        if not (result.get('finished') and result.get('validLap') and result.get('offTrackRate') == 0
                and result.get('contacts') == 0 and isinstance(result.get('raceTime'), (float, int)) and result['raceTime'] > 0):
            raise ValueError('Only clean, completed, timed demonstrations are accepted')
        if episode.get('trackId') != track_id or episode.get('difficulty') != data.get('difficulty'):
            raise ValueError('Mixed demonstration track/difficulty')
        if episode.get('seed') in data.get('provenance', {}).get('holdoutSeeds', []):
            raise ValueError('Held-out evaluations cannot enter training examples')
        for pair in episode.get('pairs', []):
            observation, action = pair.get('observation'), pair.get('action')
            if not isinstance(observation, list) or len(observation) != len(metadata['observationNames']) or not isinstance(action, list) or len(action) != 4:
                raise ValueError('Invalid demonstration dimensions')
            if not np.isfinite(observation).all() or not np.isfinite(action).all() or max(abs(x) for x in action) > 1:
                raise ValueError('Nonfinite or out-of-range demonstration')
            observations.append(observation); actions.append(action); groups.append(episode_id)
    if not observations:
        raise ValueError('No clean examples available')
    return data, np.asarray(observations, dtype=np.float32), np.asarray(actions, dtype=np.float32), np.asarray(groups)


def clone_actor(model, observations, actions, *, epochs=100, seconds=60, seed=42):
    """BC changes only the actor. PPO retains a fresh optimiser and zero RL steps."""
    if not len(observations) or epochs < 1 or seconds <= 0:
        raise ValueError('Positive cloning budget and examples are required')
    torch.manual_seed(seed)
    device = model.device
    obs = torch.as_tensor(observations, device=device)
    targets = torch.as_tensor(actions, device=device)
    parameters = list(model.policy.mlp_extractor.policy_net.parameters()) + list(model.policy.action_net.parameters())
    optimizer = torch.optim.Adam(parameters, lr=1e-3)
    weights = torch.tensor([3., 1., 2., .5], device=device)
    def predictions(indices):
        features = model.policy.extract_features(obs[indices])
        # Regress the raw mean: clipping here would give saturated brake outputs
        # zero gradient and prevent a brake-off actor learning to brake.
        return model.policy.action_net(model.policy.mlp_extractor.forward_actor(features))
    def loss(indices):
        return ((predictions(indices) - targets[indices]) ** 2 * weights).mean()
    all_indices = torch.arange(len(obs), device=device)
    with torch.no_grad():
        initial_loss = float(loss(all_indices))
    started = time.monotonic(); steps = 0; losses = []
    for epoch in range(epochs):
        order = torch.randperm(len(obs), device=device)
        for indices in order.split(256):
            optimizer.zero_grad(); error = loss(indices); error.backward()
            torch.nn.utils.clip_grad_norm_(parameters, 1.)
            optimizer.step(); steps += 1
        with torch.no_grad():
            losses.append(float(loss(all_indices)))
        if time.monotonic() - started >= seconds:
            break
    return {'initialFitLoss': initial_loss, 'finalFitLoss': losses[-1], 'epochs': len(losses), 'updates': steps,
            'elapsedSeconds': time.monotonic() - started, 'note': 'Training fit only. Closed-loop driving, not fit loss, determines quality.'}


def evaluate_student(model, data, config, directory):
    rows = []
    modes = sorted(set((e['mode'], e['raceLaps']) for e in data['episodes']))
    with gzip.open(directory / 'student-evaluation.jsonl.gz', 'wt', encoding='utf-8') as archive:
        for mode, laps in modes:
            for seed in [81271, 91517]:
                for charge in [.25, .5, 1.]:
                    env = EnergyVecEnv({**config, 'numEnvs': 1, 'workers': 1, 'mode': mode, 'raceLaps': laps,
                        'seed': seed, 'scenario': 'solo', 'racecraft': False, 'randomization': False, 'lineGuidance': False, 'episodeSeconds': max(150, laps * 120)})
                    try:
                        obs = env.fixed_reset(mode, raceLaps=laps, energy=charge)
                        while True:
                            action, _ = model.predict(obs, deterministic=True)
                            obs, _, done, infos = env.step(action)
                            if done[0]:
                                info = {k: v for k, v in infos[0].items() if k not in ['terminal_observation', 'episode', 'rewardComponents', 'trajectory']}
                                info.update(seed=seed, startingCharge=charge)
                                rows.append(info)
                                archive.write(json.dumps({'result': info, 'points': env.completed_trajectory}) + '\n')
                                break
                    finally:
                        env.close()
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--warm-start', type=Path)
    parser.add_argument('--coach-plan', type=Path, help='Enable corrective imitation with a matching real-physics planner')
    parser.add_argument('--dagger-rounds', type=int, default=3)
    args = parser.parse_args()
    if campaign_is_live():
        parser.error('V1 manager is still alive or cannot be inspected. No policy fitting was started.')
    if not 1 <= args.epochs <= 2000 or not 1 <= args.seconds <= 1800:
        parser.error('Use 1–2000 epochs and 1–1800 seconds for this bounded R&D fit')
    if not 0 <= args.dagger_rounds <= 5:
        parser.error('Use 0–5 corrective imitation rounds')
    if args.output.exists():
        parser.error('Choose a new output directory; existing runs remain untouched')
    with gzip.open(args.data, 'rt', encoding='utf-8') as stream:
        header = json.load(stream)
    track_id = header.get('trackId')
    if not isinstance(track_id, int) or not 0 <= track_id <= 7:
        parser.error('Invalid demonstration track')
    config = {'trackId': track_id, 'difficulty': 'extreme', 'gamma': .9995, 'seed': args.seed, 'numEnvs': 1, 'workers': 1, 'device': 'cpu'}
    env = EnergyVecEnv(config)
    try:
        data, observations, actions, groups = load_examples(args.data, env.metadata, track_id)
        model = new_policy(env, config)
        if args.warm_start:
            warm_start(model, args.warm_start, track_id, env.physics_hash)
        args.output.mkdir(parents=True)
        rounds = args.dagger_rounds if args.coach_plan else 0
        fit = clone_actor(model, observations, actions, epochs=args.epochs, seconds=args.seconds / (rounds + 1), seed=args.seed)
        corrections = []
        if rounds:
            from .pace_dagger import collect, quality
            modes = sorted(set((e['mode'], e['raceLaps']) for e in data['episodes']))
            cases = [{'mode': mode, 'raceLaps': laps, 'energy': charge, 'seed': args.seed + 200,
                'lateralOffset': 0, 'headingOffset': 0} for mode, laps in modes for charge in [.25, .5, 1.]]
            scored, _, _ = collect(model, args.coach_plan, cases, args.output / 'selection-initial.jsonl.gz')
            best_quality, best_state = quality(scored), copy.deepcopy(model.policy.state_dict())
            for round_id in range(rounds):
                beta = [.5, .2, 0., 0., 0.][round_id]
                _, extra_obs, extra_actions = collect(model, args.coach_plan, cases, args.output / f'corrections-{round_id}.jsonl.gz', beta=beta, seed=args.seed + round_id, labels=True)
                observations = np.concatenate([observations, extra_obs]); actions = np.concatenate([actions, extra_actions])
                updated = clone_actor(model, observations, actions, epochs=max(80, args.epochs // 2), seconds=args.seconds / (rounds + 1), seed=args.seed + round_id + 1)
                scored, _, _ = collect(model, args.coach_plan, cases, args.output / f'selection-{round_id}.jsonl.gz')
                if quality(scored) > best_quality:
                    best_quality, best_state = quality(scored), copy.deepcopy(model.policy.state_dict())
                corrections.append({'round': round_id, 'beta': beta, 'fit': updated, 'addedSamples': len(extra_obs), 'selectionQuality': quality(scored)})
            model.policy.load_state_dict(best_state)
        save_checkpoint(model, args.output / 'last.zip')
        write_json(args.output / 'contract.json', {'trackId': track_id, 'physicsHash': env.physics_hash, 'modelGeneration': 2,
            'observationNames': env.metadata['observationNames'], 'actionNames': env.metadata['actionNames'], 'config': config})
        pack = {'format': 'kartblitz-official-track-v2', 'modelGeneration': 2, 'name': 'V2 R&D · pace imitation · unapproved',
            'trackId': track_id, 'physicsHash': env.physics_hash, 'trackFingerprint': data['trackFingerprint'], 'observationVersion': 2,
            'observationCount': len(env.metadata['observationNames']), 'observationNames': env.metadata['observationNames'],
            'actionCount': 4, 'actionNames': env.metadata['actionNames'], 'decisionHz': 20, 'environmentVersion': 6,
            'createdAt': int(time.time() * 1000), 'approved': False,
            'variants': {'extreme': {'id': args.output.name, 'policy': export_policy(model),
                'training': {'algorithm': 'Corrective imitation from pace search' if rounds else 'Behaviour cloning from pace search', 'steps': 0, 'samples': len(observations),
                    'source': str(args.data.resolve()), 'fit': fit, 'racecraft': False, 'warmStart': bool(args.warm_start)}}}}
        pack['variants']['extreme']['training']['correctiveRounds'] = corrections
        write_json(args.output / 'candidate.kartai.json', pack)
    finally:
        env.close()
    if args.coach_plan:
        from .pace_dagger import collect
        cases = [{'mode': mode, 'raceLaps': laps, 'energy': charge, 'seed': seed,
            'lateralOffset': -6 if seed == 81271 else 6, 'headingOffset': -.025 if seed == 81271 else .025}
            for mode, laps in sorted(set((e['mode'], e['raceLaps']) for e in data['episodes'])) for seed in [81271, 91517] for charge in [.25, .5, 1.]]
        rows, _, _ = collect(model, args.coach_plan, cases, args.output / 'student-evaluation.jsonl.gz')
    else:
        rows = evaluate_student(model, data, config, args.output)
    clean = [r for r in rows if r['finished'] and r['validLap'] and r['offTrackRate'] == 0 and r['contacts'] == 0]
    report = {'approved': False, 'reason': 'R&D only; imitation loss is not a driving score and native-game/racecraft validation is still required.',
        'fit': fit, 'correctiveRounds': corrections, 'samples': len(observations), 'demonstrationEpisodes': len(set(groups.tolist())), 'cases': rows,
        'closedLoopCleanRate': len(clean) / max(1, len(rows)), 'ppoOptimiserStateEntries': len(model.policy.optimizer.state),
        'checkpoint': str((args.output / 'last.zip').resolve())}
    write_json(args.output / 'report.json', report)
    print(json.dumps({'output': str(args.output.resolve()), 'samples': len(observations), 'fit': fit, 'closedLoopCleanRate': report['closedLoopCleanRate'], 'approved': False}), flush=True)


if __name__ == '__main__':
    main()
