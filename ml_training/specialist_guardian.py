"""Small watchdog: no Torch import, no paid service, no browser UI automation."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import psutil
ROOT=Path(__file__).resolve().parents[1]
CURRENT=ROOT/'ml_training/runs/specialists-v3/current'
def read(path):
    try:return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError,ValueError):return {}
def alive(record):
    try:return abs(psutil.Process(record['pid']).create_time()-record['created'])<.1
    except (KeyError,psutil.Error,TypeError):return False
def main():
    owner=json.loads(sys.argv[1])
    while alive(owner):
        time.sleep(10)
        if read(CURRENT/'state.json').get('owner')!=owner:return
    state=read(CURRENT/'state.json')
    if state.get('owner')!=owner:return
    for worker in state.get('ownedWorkers',[]):
        if not alive(worker):continue
        try:
            process=psutil.Process(worker['pid'])
            if 'native-worker-v2.mjs' not in ' '.join(process.cmdline()):continue
            for child in reversed(process.children(recursive=True)):
                try:child.terminate()
                except psutil.Error:pass
            process.terminate()
        except psutil.Error:pass
    if read(CURRENT/'control.json').get('action','run')=='stop' or state.get('phase')=='complete' or state.get('guardianRestarts',0)>=3:return
    state['guardianRestarts']=state.get('guardianRestarts',0)+1
    temp=CURRENT/'guardian-state.tmp';temp.write_text(json.dumps(state),encoding='utf-8');os.replace(temp,CURRENT/'state.json')
    flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
    with (CURRENT/'manager.log').open('a',encoding='utf-8') as output,(CURRENT/'manager-errors.log').open('a',encoding='utf-8') as errors:
        subprocess.Popen([sys.executable,'-m','ml_training.specialist_campaign'],cwd=ROOT,stdout=output,stderr=errors,creationflags=flags)
if __name__=='__main__':main()
