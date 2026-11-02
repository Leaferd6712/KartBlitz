"""Independent held-out evaluation; no policy updates or automatic activation."""
import argparse
import json
import statistics
import subprocess
from pathlib import Path
import numpy as np
from .campaign import ROOT,RUNS,read_json,write_json,checkpoint_for,FLAGS

def summarize(rows):
    times=[r['lapTime'] for r in rows if r.get('finished') and r.get('lapTime') is not None]
    return {'tests':len(rows),'finishRate':sum(bool(r.get('finished')) for r in rows)/max(1,len(rows)),
        'medianLapTime':statistics.median(times) if times else None,
        'p90LapTime':float(np.percentile(times,90)) if times else None,
        'contacts':sum(r.get('contacts',0) for r in rows),
        'passes':sum(r.get('passes',0)>0 for r in rows),
        'defended':sum(r.get('defended',0)>0 for r in rows),
        'recoveriesWithin10s':sum(r.get('recoveryTime') is not None and r['recoveryTime']<=10 for r in rows)}

def evaluate(run,track,difficulty,output):
    import torch
    from stable_baselines3 import PPO
    from .official_environment import OfficialVecEnv
    torch.set_num_threads(1)
    pack=read_json(RUNS/run/f'track-{track}.kartai.json',{})
    if difficulty not in pack.get('variants',{}):raise ValueError('Missing candidate difficulty')
    checkpoint=checkpoint_for(run,track,difficulty) or checkpoint_for(run,track,difficulty,False)
    model=PPO.load(checkpoint,device='cpu');rows=[];per_mode={};scenarios={}
    folder=Path(output).parent/f'heldout-{track}-{difficulty}-{run[:8]}';folder.mkdir(parents=True,exist_ok=True)
    import gzip
    with gzip.open(folder/'attempts.jsonl.gz','wt',encoding='utf-8') as archive:
        for scenario in ['solo','passing','defending','recovery','mixed']:
            config={'trackId':track,'difficulty':difficulty,'numEnvs':1,'workers':1,'randomization':False,
                'racecraft':scenario!='solo','scenario':None if scenario=='mixed' else scenario,'seed':81271+track*1009,'mode':'ai'}
            env=OfficialVecEnv(config)
            try:
                for mode in (['ai','shootout'] if scenario=='solo' else ['ai']):
                    count=20 if scenario=='solo' else 10;group=[]
                    for i in range(count):
                        energy=[1,.5,.25,1][i%4];obs=env.fixed_reset(mode,energy=energy)
                        while True:
                            action,_=model.predict(obs,deterministic=True);obs,_,done,infos=env.step(action)
                            if done[0]:
                                row={k:v for k,v in infos[0].items() if k not in ['terminal_observation','episode','rewardComponents']}
                                row.update(testScenario=scenario,energy=energy,case=i)
                                points=env.completed_trajectory;bad_encounters=set()
                                for point in points:
                                    if point.get('defenseUsed') and point.get('defenseLane') is not None and point.get('contacts',0)==0 and abs(point.get('lateral',0)-point['defenseLane'])>env.metadata['tracks'][track]['width']*.15:bad_encounters.add(point.get('defenseEncounter'))
                                row['defensiveReversalFlags']=len(bad_encounters)
                                archive.write(json.dumps({'result':row,'points':points})+'\n')
                                rows.append(row);group.append(row);break
                    if scenario=='solo':per_mode[mode]=summarize(group)
                    else:scenarios[scenario]=summarize(group)
            finally:env.close()
    # Native browser checks use game orchestration, not the training wrapper.
    native_file=folder/'native.json'
    native=subprocess.run(['node','scripts/campaign-browser-check.mjs',str(RUNS/run/f'track-{track}.kartai.json'),difficulty,str(native_file)],cwd=ROOT,creationflags=FLAGS,timeout=140,capture_output=True,text=True)
    (folder/'native.log').write_text(native.stdout+'\n'+native.stderr,encoding='utf-8')
    native_report=read_json(native_file,{})
    reasons=[]
    if any(m['finishRate']<1 for m in per_mode.values()):reasons.append('solo completion below 20/20')
    if any(m['finishRate']<.9 for m in scenarios.values()):reasons.append('traffic/recovery completion below 90%')
    if scenarios['passing']['passes']<8:reasons.append('fewer than 8/10 passing successes')
    if scenarios['defending']['defended']<7:reasons.append('fewer than 7/10 sustained defensive successes')
    if scenarios['recovery']['recoveriesWithin10s']<8:reasons.append('fewer than 8/10 recoveries within 10 seconds')
    if sum(r['defensiveReversalFlags'] for r in rows):reasons.append('defensive lateral-reversal flags require review')
    if native.returncode or not native_report.get('passed'):reasons.append('native game acceptance did not pass')
    if not native_report.get('traffic',{}).get('passed'):reasons.append('matched native traffic/contact/defensive checks did not pass')
    if not native_report.get('beatsLegacy'):reasons.append('not faster than Legacy in both native modes')
    result={'approved':not reasons,'run':run,'track':track,'difficulty':difficulty,'conditions':'dry / stock / medium tyres',
        'solo':per_mode,'racecraft':scenarios,'native':native_report,'reasons':reasons,
        'legalRuleEvidence':'one-move constraint plus conservative lateral-reversal flags; not a full F1 rules engine',
        'archive':str(folder/'attempts.jsonl.gz'),'rawCases':rows}
    write_json(output,result)

def main():
    p=argparse.ArgumentParser();p.add_argument('--run',required=True);p.add_argument('--track',type=int,required=True);p.add_argument('--difficulty',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    evaluate(args.run,args.track,args.difficulty,args.output)

if __name__=='__main__':main()
