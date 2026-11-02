"""Corrective imitation; expert labels on visited states are not scored as clean laps."""
import gzip
import json
import os
import subprocess
import numpy as np
from .official_train import ROOT


class Coach:
    def __init__(self, plan):
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        self.process = subprocess.Popen(['node', 'scripts/pace-coach.mjs', str(plan)], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=flags)

    def call(self, value):
        self.process.stdin.write(json.dumps(value) + '\n'); self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('Coach exited: ' + self.process.stderr.read()[-1500:])
        result = json.loads(line)
        if not result.get('ok'):
            raise RuntimeError(result.get('error', 'Coach failed'))
        return result

    def close(self):
        if self.process.poll() is None:
            try:
                self.call({'command': 'close'}); self.process.wait(timeout=3)
            except Exception:
                self.process.kill(); self.process.wait(timeout=3)
        for stream in [self.process.stdin, self.process.stdout, self.process.stderr]:
            stream.close()


def collect(model, plan, cases, archive, *, beta=0., seed=42, labels=False):
    random = np.random.default_rng(seed); rows, observations, targets = [], [], []
    coach = Coach(plan)
    try:
        with gzip.open(archive, 'wt', encoding='utf-8') as stream:
            for case in cases:
                state = coach.call({'command': 'reset', 'case': case}); pairs = []
                while True:
                    obs = np.asarray(state['observation'], dtype=np.float32)
                    learner, _ = model.predict(obs, deterministic=True)
                    if labels:
                        observations.append(obs); targets.append(state['expert'])
                        pairs.append({'observation': obs.tolist(), 'expertAction': state['expert'], 'learnerAction': learner.tolist()})
                    action = state['expert'] if random.random() < beta else learner.tolist()
                    state = coach.call({'command': 'step', 'action': action})
                    if state['done']:
                        result = {**state['result'], **case, 'startingCharge': case['energy']}; rows.append(result)
                        points = coach.call({'command': 'recording'})['points']
                        stream.write(json.dumps({'result': result, 'points': points, 'beta': beta, 'correctionOnly': labels, 'pairs': pairs}) + '\n')
                        break
    finally:
        coach.close()
    return rows, np.asarray(observations, dtype=np.float32), np.asarray(targets, dtype=np.float32)


def quality(rows):
    clean = [r for r in rows if r['finished'] and r['validLap'] and r['offTrackRate'] == 0 and r['contacts'] == 0]
    return (len(clean), -sum(r['offTrackRate'] for r in rows), -sum(r['raceTime'] for r in clean))
