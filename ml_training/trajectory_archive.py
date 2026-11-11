"""Bounded trajectory spooling and replay-compatible streaming gzip members."""
import gzip
import json
import shutil
import tempfile
from collections.abc import Sequence
from pathlib import Path

class DiskTrajectory(Sequence):
    def __init__(self,path,count):self.path=Path(path);self.count=count
    def __len__(self):return self.count
    def __iter__(self):
        with self.path.open(encoding='utf-8') as source:
            for line in source:yield json.loads(line)
    def __getitem__(self,index):
        if isinstance(index,slice):return [p for i,p in enumerate(self) if i in range(*index.indices(len(self))) ]
        if index<0:index+=len(self)
        for i,p in enumerate(self):
            if i==index:return p
        raise IndexError(index)

class TrajectorySpool:
    def __init__(self,root,retain=2):
        Path(root).mkdir(parents=True,exist_ok=True)
        self.directory=Path(tempfile.mkdtemp(prefix='trajectory-',dir=root));self.active={};self.retained=[];self.retain=retain
    def add(self,key,points):
        path,count=self.active.setdefault(key,(self.directory/('-'.join(map(str,key))+'.jsonl'),0))
        if points:
            with path.open('a',encoding='utf-8') as output:
                for point in points:output.write(json.dumps(point,separators=(',',':'),allow_nan=False)+'\n')
        self.active[key]=(path,count+len(points))
    def finish(self,key):
        path,count=self.active.pop(key,(self.directory/('-'.join(map(str,key))+'.jsonl'),0));path.touch(exist_ok=True)
        self.retained.append(path)
        # A completed record is consumed synchronously before the next physics
        # step. Keep the last two for callers inspecting completed_trajectory.
        while len(self.retained)>self.retain:
            self.retained.pop(0).unlink(missing_ok=True)
        return DiskTrajectory(path,count)
    def close(self):
        try:shutil.rmtree(self.directory)
        except OSError:pass # Retained spool fragments may be inspected after a crash.

def write_record(output,metadata,points,*,append=True,index=True):
    """One complete JSON line/member, without creating one giant JSON string."""
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    offset=output.stat().st_size if append and output.exists() else 0
    with gzip.open(output,'at' if append else 'wt',encoding='utf-8') as archive:
        archive.write('{"points":[')
        for i,point in enumerate(points):
            if i:archive.write(',')
            archive.write(json.dumps(point,separators=(',',':'),allow_nan=False))
        archive.write(']')
        for key,value in metadata.items():archive.write(','+json.dumps(key)+':'+json.dumps(value,separators=(',',':'),allow_nan=False))
        archive.write('}\n')
    summary=metadata.get('result',metadata)
    entry={k:summary[k] for k in ['attempt','trackId','difficulty','mode','specialist','finished','interrupted','raceTime','lapTime','offTrackRate','contacts'] if k in summary}
    entry.update(archive=output.name,offset=offset,bytes=output.stat().st_size-offset)
    if index:
        with (output.parent/'attempt-index.jsonl').open('a',encoding='utf-8') as target:target.write(json.dumps(entry,allow_nan=False)+'\n')
    return entry

def read_group(sources,cohort='final',track_id=None,limit=1000):
    """Bounded replay selection across immutable training chunks."""
    from collections import deque
    import math
    if cohort not in ['early','middle','final']:raise ValueError('Unknown replay cohort')
    selected=deque(maxlen=max(1,min(1000,int(limit))));number=0
    for source in map(Path,sources):
        index=source.parent/'attempt-index.jsonl'
        if not index.exists() or not source.exists():continue
        with index.open(encoding='utf-8') as stream:
            for line in stream:
                try:entry=json.loads(line)
                except ValueError:continue
                if entry.get('archive',source.name)!=source.name or entry.get('interrupted'):continue
                if track_id is not None and entry.get('trackId')!=int(track_id):continue
                number+=1
                if cohort=='early' and number>1000 or cohort=='middle' and not 3001<=number<=4000:continue
                selected.append((source,entry,number))
    result=[]
    for source,entry,number in selected:
        with source.open('rb') as stream:
            stream.seek(entry['offset']);row=json.loads(gzip.decompress(stream.read(entry['bytes'])))
        points=row.pop('points',[]);stride=max(1,math.ceil(len(points)/240));sampled=points[::stride]
        if points and sampled[-1] is not points[-1]:sampled.append(points[-1])
        keys=['t','x','y','a','speed','offTrack','ersCharge','ersActive','ersPower','drsActive','drsAvailable','drsInZone','lapTime','lapIndex','opponents']
        row.update(attempt=number,points=[{k:p[k] for k in keys if k in p} for p in sampled]);result.append(row)
    return result
