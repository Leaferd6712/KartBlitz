"""Bounded process supervision; never changes the campaign's absolute deadline."""
import argparse
import os
import subprocess
import sys
import time
import psutil
from .campaign import CURRENT,ROOT,FLAGS,parse_deadline,read_json,write_json
from .campaign_resources import terminate_tree

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--deadline',required=True);args=parser.parse_args()
    deadline=parse_deadline(args.deadline);CURRENT.mkdir(parents=True,exist_ok=True)
    old=read_json(CURRENT/'guardian.json',{})
    if old.get('pid'):
        try:
            p=psutil.Process(old['pid'])
            if p.is_running() and abs(p.create_time()-old['created'])<.1:print('Guardian is already running',flush=True);return
        except psutil.Error:pass
    write_json(CURRENT/'guardian.json',{'pid':os.getpid(),'created':psutil.Process().create_time(),'deadline':deadline,'restarts':0})
    for restart in range(3):
        if time.time()>=deadline-900:return
        output=(CURRENT/'manager.log').open('a',encoding='utf-8');errors=(CURRENT/'manager-errors.log').open('a',encoding='utf-8')
        command=[sys.executable,'-m','ml_training.campaign','--deadline',args.deadline]
        if time.time()>=deadline-3600:command.append('--validate-only')
        process=subprocess.Popen(command,cwd=ROOT,creationflags=FLAGS,stdout=output,stderr=errors);output.close();errors.close()
        created=psutil.Process(process.pid).create_time()
        while process.poll() is None and time.time()<deadline-60:time.sleep(1)
        if process.poll() is None:terminate_tree(process.pid,created);return
        code=process.wait();state=read_json(CURRENT/'state.json',{})
        if code==0 or read_json(CURRENT/'control.json',{}).get('action')=='stop':return
        write_json(CURRENT/'guardian.json',{'pid':os.getpid(),'created':psutil.Process().create_time(),'deadline':deadline,'restarts':restart+1,'lastExitCode':code})
        if restart<2:time.sleep(12)

if __name__=='__main__':main()
