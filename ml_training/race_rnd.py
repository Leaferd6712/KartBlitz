"""Equal-budget mixed-race PPO/rehearsal comparison, preserving the fast seed."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import signal
from pathlib import Path
import numpy as np
import torch
from stable_baselines3 import PPO
from .official_environment_v2 import EnergyVecEnv
from .official_train_v2 import new_policy, train_arm, choose_result, write_json, campaign_is_live, evaluate
from .official_train import save_checkpoint, TrainingControl
from .policy_seed import import_actor
from .race_rehearsal import RehearsalPPO


def retains_shootout(candidate, baseline, tolerance=.05):
    """A race challenger must retain every matched successful Shootout case."""
    key = lambda r: (r.get('case'), r.get('seed'), r.get('startingCharge'))
    previous = {key(r): r for r in baseline['cases'] if r['mode'] == 'shootout'}
    current = {key(r): r for r in candidate['cases'] if r['mode'] == 'shootout'}
    if not previous or previous.keys() != current.keys() or candidate.get('cancelled'):
        return False
    for identity, old in previous.items():
        new = current[identity]
        if old['finished']:
            if not new['finished'] or new.get('validLap') is False or new['offTrackRate'] > old['offTrackRate'] + 1e-8 or new['contacts'] > old['contacts']:
                return False
            if not isinstance(new.get('raceTime'), (int, float)) or not np.isfinite(new['raceTime']) or new['raceTime'] > old['raceTime'] + tolerance:
                return False
    return True


def select_retaining_seed(seed, baseline, challengers):
    eligible = [(seed, baseline, 'unchanged-fast-seed')]
    rejected = []
    for item in challengers:
        if retains_shootout(item[1], baseline): eligible.append(item)
        else: rejected.append({'arm': str(item[2]), 'reason': 'Matched Shootout pace/reliability regression'})
    return choose_result(eligible), rejected


def capture_teacher(model, config, output):
    observations, targets = [], []
    env = EnergyVecEnv({**config, 'numEnvs': 1, 'workers': 1, 'mode': 'shootout', 'racecraft': False, 'lineGuidance': False, 'randomization': False})
    try:
        with gzip.open(output / 'teacher-attempts.jsonl.gz', 'wt', encoding='utf-8') as stream:
            for charge in [.25, .5, 1.]:
                obs = env.fixed_reset('shootout', energy=charge)
                rows, raw = [], []
                while True:
                    with torch.no_grad():
                        tensor = torch.as_tensor(obs, device=model.device)
                        means = model.policy.action_net(model.policy.mlp_extractor.forward_actor(model.policy.extract_features(tensor))).cpu().numpy()
                    rows.append(obs[0].copy()); raw.append(means[0].copy())
                    obs, _, done, infos = env.step(np.clip(means, -1, 1))
                    if done[0]:
                        result = {k: v for k, v in infos[0].items() if k not in ['terminal_observation', 'episode', 'rewardComponents']}
                        result['startingCharge'] = charge
                        clean = result['finished'] and result['validLap'] and not result['offTrackRate'] and not result['contacts']
                        stream.write(json.dumps({'result': result, 'points': env.completed_trajectory, 'cleanTeacher': bool(clean)}) + '\n')
                        if not clean:
                            raise ValueError('Fast seed failed the clean teacher check; no challenger training was started')
                        observations.extend(rows); targets.extend(raw)
                        break
    finally:
        env.close()
    obs = np.asarray(observations, dtype=np.float32); targets = np.asarray(targets, dtype=np.float32)
    np.savez_compressed(output / 'teacher-observations.npz', observations=obs, rawTargets=targets)
    return obs, targets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True); parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds-per-arm', type=float, default=120)
    parser.add_argument('--cars', type=int, default=16); parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if campaign_is_live(): parser.error('V1 campaign is alive or inaccessible; research training was not started')
    if not 30 <= args.seconds_per_arm <= 7200: parser.error('Use 30–7200 seconds per arm, plus independent evaluation')
    if args.output.exists(): parser.error('Use a new directory; research runs are immutable')
    source = args.candidate.read_bytes(); pack = json.loads(source); track_id = pack.get('trackId')
    config = {'trackId': track_id, 'difficulty': 'extreme', 'gamma': .9995, 'seed': 42, 'device': 'cpu', 'horizon': 128,
        'batchSize': 1024, 'learningRate': 5e-5, 'targetKL': .015, 'numEnvs': args.cars, 'workers': args.workers,
        'initialTyreWearChoices': [0, 0, .2, .4, .6], 'lineGuidance': False, 'seconds': args.seconds_per_arm,
        'bestCheckpoint': True, 'selectionIntervalSeconds': 45}
    env = EnergyVecEnv({**config, 'numEnvs': 1, 'workers': 1})
    try:
        seed_model = import_actor(new_policy(env, config), pack, env.metadata, 'extreme')
        # A warm driver needs smaller exploratory steering noise than a random
        # driver. This is an experimental setting, identical in both arms.
        with torch.no_grad(): seed_model.policy.log_std.copy_(torch.tensor([-2.3, -1.6, -1.6, -1.], device=seed_model.device))
        args.output.mkdir(parents=True)
        seed_dir = args.output / 'seed'; seed_dir.mkdir()
        save_checkpoint(seed_model, seed_dir / 'last.zip')
        write_json(seed_dir / 'contract.json', {'trackId': track_id, 'physicsHash': env.physics_hash, 'source': str(args.candidate.resolve())})
        observations, targets = capture_teacher(seed_model, config, args.output)
    finally: env.close()
    config['warmStart'] = str(seed_dir / 'last.zip')
    baseline=evaluate(seed_model,config,args.output/'baseline-evaluation')
    write_json(args.output / 'config.json', {'source': str(args.candidate.resolve()), 'sourceSha256': hashlib.sha256(source).hexdigest(),
        'config': config, 'teacherSamples': len(observations), 'approved': False,
        'note': 'Both arms train the same scenario mixture and degraded starting tyres; rehearsal is the only arm difference.'})
    control = TrainingControl()
    def stop(*_): control.cancelled.set(); control.running.set()
    signal.signal(signal.SIGINT, stop); signal.signal(signal.SIGTERM, stop)
    results = []
    for rehearsed in [False, True]:
        if control.cancelled.is_set(): break
        arm_dir = args.output / ('rehearsal' if rehearsed else 'plain')
        arm = {**config, 'algorithm': 'PPO + frozen Shootout rehearsal' if rehearsed else 'PPO'}
        def factory(env, cfg):
            model = new_policy(env, cfg, policy_class=RehearsalPPO if rehearsed else PPO)
            if rehearsed: model.attach_teacher(observations, targets, updates=4, learning_rate=1e-5)
            return model
        write_json(args.output / 'status.json', {'phase': 'training', 'arm': arm['algorithm'], 'approved': False})
        candidate, report = train_arm(arm, arm_dir, control, model_factory=factory)
        results.append((candidate, report, arm_dir))
    if control.cancelled.is_set():
        write_json(args.output / 'status.json', {'phase': 'stopped', 'approved': False}); return
    selected,rejected = select_retaining_seed(pack,baseline,results)
    write_json(args.output / 'candidate.kartai.json', selected[0])
    write_json(args.output / 'report.json', {'approved': False, 'chosenArm': str(selected[2]),
        'baseline':baseline,'rejected':rejected,'reports': [{'arm': str(row[2]), 'evaluation': row[1]} for row in results],
        'note': 'Headless research selection only. Run a new-seed native comparison before promotion; original seed remains unchanged.'})
    write_json(args.output / 'status.json', {'phase': 'complete', 'chosenArm': str(selected[2]), 'approved': False})
    print(json.dumps({'output': str(args.output.resolve()), 'chosenArm': str(selected[2]), 'approved': False}), flush=True)


if __name__ == '__main__': main()
