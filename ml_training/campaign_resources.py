"""Read-only laptop telemetry and conservative parallel-training admission."""
import ctypes
import os
import re
import subprocess
import time
from pathlib import Path
import psutil

GiB=1024**3

class SharedGpuMemory:
    """English PDH counters work independently of the Windows display language."""
    def __init__(self):
        self.query=None;self.counter=ctypes.c_void_p()
        if os.name!='nt':return
        try:
            self.pdh=ctypes.WinDLL('pdh');query=ctypes.c_void_p()
            if self.pdh.PdhOpenQueryW(None,0,ctypes.byref(query)):return
            self.query=query
            if self.pdh.PdhAddEnglishCounterW(query,r'\GPU Process Memory(*)\Shared Usage',0,ctypes.byref(self.counter)):
                self.pdh.PdhCloseQuery(query);self.query=None
            else:self.pdh.PdhCollectQueryData(query)
        except (OSError,AttributeError):self.query=None
    def sample(self,pids):
        if not self.query:return None
        class Number(ctypes.Union):_fields_=[('large',ctypes.c_longlong),('double',ctypes.c_double)]
        class Value(ctypes.Structure):_fields_=[('status',ctypes.c_uint32),('number',Number)]
        class Item(ctypes.Structure):_fields_=[('name',ctypes.c_wchar_p),('value',Value)]
        try:
            if self.pdh.PdhCollectQueryData(self.query):return None
            size=ctypes.c_uint32();count=ctypes.c_uint32()
            status=self.pdh.PdhGetFormattedCounterArrayW(self.counter,0x400,ctypes.byref(size),ctypes.byref(count),None)
            if status&0xffffffff!=0x800007d2:return None
            buffer=ctypes.create_string_buffer(size.value)
            if self.pdh.PdhGetFormattedCounterArrayW(self.counter,0x400,ctypes.byref(size),ctypes.byref(count),buffer):return None
            rows=ctypes.cast(buffer,ctypes.POINTER(Item));total=0
            for i in range(count.value):
                match=re.search(r'pid_(\d+)_',rows[i].name or '')
                if match and int(match[1]) in pids and rows[i].value.status in (0,1):total+=max(0,rows[i].value.number.large)
            return total
        except (OSError,ValueError):return None
    def close(self):
        if self.query:self.pdh.PdhCloseQuery(self.query);self.query=None

class ResourceMonitor:
    def __init__(self):self.shared=SharedGpuMemory();psutil.cpu_percent()
    def sample(self,pids=()):
        memory=psutil.virtual_memory();battery=psutil.sensors_battery()
        row={'at':time.time(),'cpuPercent':psutil.cpu_percent(),'ramAvailableGiB':memory.available/GiB,
             'ramPercent':memory.percent,'onMains':battery is None or battery.power_plugged,
             'diskFreeGiB':psutil.disk_usage(str(Path.cwd())).free/GiB,
             'sharedGpuMiB':None}
        # Windows venv executables can launch the real learner as a child.
        # Count the entire owned process tree, including that CUDA process.
        owners=set(pids);gpu_pids=set(owners)
        for pid in tuple(gpu_pids):
            try:gpu_pids.update(child.pid for child in psutil.Process(pid).children(recursive=True))
            except psutil.Error:pass
        shared=self.shared.sample(gpu_pids)
        if shared is not None:
            row['sharedGpuMiB']=shared/1024**2
            # Measured on this laptop: a 4 KiB CUDA tensor alone uses 76 MiB
            # of WDDM shared bookkeeping. It is not model offload. Allow at
            # most 96 MiB per independent learner, then guard further growth.
            row['sharedGpuAllowanceMiB']=96*len(owners)
            row['sharedGpuExcessMiB']=max(0,row['sharedGpuMiB']-row['sharedGpuAllowanceMiB'])
        try:
            r=subprocess.run(['nvidia-smi','--id=0','--query-gpu=memory.total,memory.used,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=3,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            if r.returncode==0:
                total,used,util,temp=map(float,r.stdout.strip().splitlines()[0].split(','))
                row.update(gpuTotalMiB=total,gpuUsedMiB=used,gpuUtilPercent=util,gpuTempC=temp)
        except (OSError,ValueError,subprocess.SubprocessError):pass
        return row
    def close(self):self.shared.close()

def admission(row):
    return (row.get('onMains',False) and row.get('diskFreeGiB',0)>=20 and
            row.get('ramAvailableGiB',0)>=2 and row.get('ramPercent',100)<90 and
            row.get('sharedGpuMiB') is not None and
            row.get('sharedGpuExcessMiB',row.get('sharedGpuMiB',0))<64 and row.get('gpuTempC',100)<82 and
            row.get('gpuUtilPercent',100)<95 and row.get('gpuUsedMiB',99999)<6400)

def pressure(row):
    if not row.get('onMains',False):return 'unplugged'
    if row.get('diskFreeGiB',0)<20:return 'disk-reserve'
    if row.get('ramAvailableGiB',0)<1 or row.get('ramPercent',100)>=95:return 'ram-pressure'
    if row.get('sharedGpuMiB') is not None and row.get('sharedGpuExcessMiB',row['sharedGpuMiB'])>=64:return 'shared-gpu-memory'
    if 'gpuUsedMiB' not in row:return 'gpu-telemetry-unavailable'
    if row['gpuUsedMiB']>=min(7168,row['gpuTotalMiB']-512):return 'vram-pressure'
    if row['gpuTempC']>=85:return 'temperature'
    return None

def terminate_tree(pid,created=None):
    """Only terminate the exact owned campaign process, never a recycled PID."""
    try:
        p=psutil.Process(pid)
        if created is not None and abs(p.create_time()-created)>.1:return
        command=p.cmdline()
        if 'ml_training.campaign' not in ' '.join(command):return
        if '--worker' in command or 'ml_training.campaign_validation' in ' '.join(command):
            children=p.children(recursive=True)
        else:
            # A manager also launches visible Edge windows and its independent
            # watchdog. Neither is an owned learner to kill recursively.
            children=[]
            for child in p.children(recursive=True):
                if child.pid==os.getpid():continue
                try:
                    args=child.cmdline();text=' '.join(args)
                    if ('ml_training.campaign' in text and '--worker' in args) or 'ml_training.campaign_validation' in text:
                        children.extend([*child.children(recursive=True),child])
                except psutil.Error:pass
        for child in children:
            try:child.terminate()
            except psutil.Error:pass
        p.terminate();_,alive=psutil.wait_procs([*children,p],timeout=3)
        for child in alive:
            try:child.kill()
            except psutil.Error:pass
    except psutil.Error:pass
