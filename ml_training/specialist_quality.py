"""Fixed quality contracts; counters never substitute for driving reliability."""
import math
import random

def wilson_lower(successes,total):
    if not total or not 0<=successes<=total:return 0.
    p=successes/total;z=1.959963984540054
    return (p+z*z/(2*total)-z*math.sqrt(p*(1-p)/total+z*z/(4*total*total)))/(1+z*z/total)

def clean(row,specialist):
    elapsed=row.get('raceTime')
    return bool(row.get('finished') and row.get('validLap',row.get('valid',False)) and isinstance(elapsed,(int,float)) and math.isfinite(elapsed) and elapsed>0 and 0<=row.get('offTrackRate',1)<.01 and not row.get('defensiveReversalFlags',row.get('defensiveCorrections',0)) and (specialist!='shootout' or row.get('contacts',1)==0))

def cases(specialist,count,bank,seed=42):
    if specialist not in ['shootout','race'] or bank not in ['training','selection','final']:raise ValueError('Unknown specialist or seed bank')
    randomizer=random.Random(seed);base={'training':10000000,'selection':20000000,'final':30000000}[bank]
    result=[]
    for i in range(count):
        energy=[.25,.5,1.][i%3 if specialist=='shootout' else (i//6)%3];laps=1 if specialist=='shootout' else [1,2,3,5,8,10][i%6]
        scenario='solo' if specialist=='shootout' else ['solo','passing','defending','recovery','mixed'][(i//18)%5]
        result.append(dict(mode='shootout' if specialist=='shootout' else 'ai',raceLaps=laps,energy=energy,scenario=scenario,seed=base+seed*10000+i,lateralOffset=randomizer.uniform(-6,6),headingOffset=randomizer.uniform(-.025,.025)))
    return result

def quality(rows,specialist,expected,final=False):
    valid=sum(clean(r,specialist) for r in rows);rate=valid/max(1,expected);lower=wilson_lower(valid,expected)
    complete=len(rows)==expected and len({r.get('seed') for r in rows})==expected
    return dict(expected=expected,evaluated=len(rows),successful=valid,completionRate=rate,wilsonLower95=lower,
                passed=complete and (expected>=500 and lower>=.97 if final else expected>=100 and rate>=.97))

def matched_performance(candidate,baseline,specialist):
    if len(candidate)!=len(baseline) or not candidate:return False
    if sum(clean(r,specialist) for r in candidate)<sum(clean(r,specialist) for r in baseline):return False
    keys=['mode','raceLaps','energy','scenario','seed','lateralOffset','headingOffset']
    pairs=[]
    for a,b in zip(candidate,baseline):
        if any(a.get(k)!=b.get(k) for k in keys):return False
        if clean(b,specialist) and not clean(a,specialist):return False
        if not clean(a,specialist):continue
        if clean(b,specialist):pairs.append((a,b))
    if not pairs:return True # Reliability improvement over a failed baseline.
    if any(a.get('contacts',0)>b.get('contacts',0) for a,b in pairs):return False
    if specialist=='shootout' and any(a['raceTime']>b['raceTime']+.05 for a,b in pairs):return False
    if specialist=='race' and sum(a['racePosition'] for a,b in pairs)>sum(b['racePosition'] for a,b in pairs):return False
    return sum(a['raceTime'] for a,b in pairs)<=sum(b['raceTime'] for a,b in pairs)+(.05 if specialist=='shootout' else 0)
