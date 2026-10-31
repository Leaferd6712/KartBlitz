from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .environment import load_tracks
from .train import split_training_budget, train_model

JOBS: dict[str, dict[str, Any]] = {}
LOCK = threading.Lock()
PAIRING_CODE = ""
OFFICIAL_CONTROLS: dict[str, Any] = {}
ROOT = Path(__file__).resolve().parents[1]
MAX_JOB_BYTES = 10 * 1024 * 1024
MODEL_CATALOG_CACHE: dict[str, Any] = {}


def saved_official_model(job_id: str, track_id: int) -> dict[str, Any]:
    if len(job_id)!=32 or not all(c in '0123456789abcdef' for c in job_id) or track_id not in range(8):
        raise ValueError('Invalid saved model id')
    directory=(ROOT/'ml_training/runs/official').resolve()
    file=(directory/job_id/f'track-{track_id}.kartai.json').resolve()
    if not file.is_relative_to(directory):raise ValueError('Model path is outside the run archive')
    raw=file.read_bytes();pack=json.loads(raw)
    return {'id':hashlib.sha256(raw).hexdigest(),'package':pack}


def saved_official_models() -> list[dict[str, Any]]:
    directory=ROOT/'ml_training/runs/official';models=[]
    for file in directory.glob('*/track-*.kartai.json'):
        job_id=file.parent.name
        if len(job_id)!=32 or not all(c in '0123456789abcdef' for c in job_id):continue
        with LOCK:active=JOBS.get(job_id,{}).get('status') in ['queued','running','paused','stopping']
        if active:continue
        try:
            stat=file.stat();key=str(file);version=(stat.st_mtime_ns,stat.st_size)
            with LOCK:cached=MODEL_CATALOG_CACHE.get(key)
            if cached and cached[0]==version:models.append(cached[1]);continue
            track_id=int(file.name.split('-')[1].split('.')[0]);data=saved_official_model(job_id,track_id);pack=data['package']
            if pack.get('format')!='kartblitz-official-track-v1' or not pack.get('trackFingerprint'):continue
            row={'id':data['id'],'jobId':job_id,'trackId':track_id,'name':pack.get('name'),'createdAt':pack.get('createdAt'),
                'physicsHash':pack.get('physicsHash'),'variants':list(pack.get('variants',{}))}
            with LOCK:
                if len(MODEL_CATALOG_CACHE)>256:MODEL_CATALOG_CACHE.clear()
                MODEL_CATALOG_CACHE[key]=(version,row)
            models.append(row)
        except (OSError,ValueError,KeyError):continue
    return sorted(models,key=lambda row:row.get('createdAt') or 0,reverse=True)


def torch_status() -> dict[str, Any]:
    try:
        import torch
        cuda = torch.cuda.is_available()
        return {"torchInstalled": True, "torchVersion": f"PyTorch {torch.__version__}", "cudaAvailable": cuda, "deviceName": torch.cuda.get_device_name(0) if cuda else "CPU"}
    except ImportError:
        return {"torchInstalled": False, "torchVersion": None, "cudaAvailable": False, "deviceName": "PyTorch not installed"}


def run_job(job_id: str, config: dict[str, Any]) -> None:
    def progress(update: dict[str, Any]) -> None:
        with LOCK: JOBS[job_id].update(update)
    try:
        result = train_model(config, progress)
        with LOCK: JOBS[job_id].update({"status": "complete", "step": JOBS[job_id]["totalSteps"], **result})
    except Exception as exc:
        with LOCK: JOBS[job_id].update({"status": "failed", "error": str(exc), "logs": [traceback.format_exc()]})

def run_official_job(job_id: str, config: dict[str, Any]) -> None:
    try:
        from .official_train import train_official, benchmark_official
        def update(fields):
            with LOCK: JOBS[job_id].update(fields)
        result=benchmark_official(config,update,OFFICIAL_CONTROLS[job_id]) if config.get('benchmarkOnly') else train_official(config,update,OFFICIAL_CONTROLS[job_id],ROOT/'ml_training/runs/official'/job_id)
        update(result)
    except Exception as exc:
        with LOCK:JOBS[job_id].update(status='failed',error=str(exc),logs=[traceback.format_exc()])


class Handler(BaseHTTPRequestHandler):
    server_version = "KartBlitzML/1.0"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*") or "*")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-KartBlitz-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(payload,separators=(',',':')).encode("utf-8"); self.send_response(status); self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(encoded))); self.end_headers(); self.wfile.write(encoded)

    def _authorized(self) -> bool:
        return secrets.compare_digest(self.headers.get("X-KartBlitz-Key", ""), PAIRING_CODE)

    def do_OPTIONS(self) -> None:
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path=='/api/official/models' or path.startswith('/api/official/models/'):
            if not self._authorized():self._json(401,{'error':'Incorrect trainer pairing code'});return
            try:
                if path=='/api/official/models':self._json(200,{'models':saved_official_models()})
                else:
                    parts=path.split('/')
                    if len(parts)!=6:raise ValueError('Invalid saved model URL')
                    self._json(200,saved_official_model(parts[4],int(parts[5])))
            except (OSError,ValueError) as exc:self._json(404,{'error':str(exc)})
            return
        if path == '/api/official/status':
            import importlib.util
            status=torch_status()
            status.update({'ready':all(importlib.util.find_spec(name) for name in ['torch','gymnasium','stable_baselines3']),
                'capabilities':['actual-game-physics','per-track','five-difficulties','live-batches','checkpoint-resume'],
                'trackCount':8,'defaultTrack':0,'apiVersion':1})
            self._json(200,status);return
        if path.startswith('/api/official/jobs/'):
            if not self._authorized():self._json(401,{'error':'Incorrect trainer pairing code'});return
            parts=path.split('/');job_id=parts[4]
            with LOCK:job=dict(JOBS[job_id]) if job_id in JOBS else None
            if not job:self._json(404,{'error':'Training job not found'});return
            if len(parts)==5:self._json(200,job);return
            if parts[5]=='model':
                from urllib.parse import parse_qs
                query=parse_qs(urlparse(self.path).query)
                try:
                    track=int(query.get('trackId',['0'])[0])
                    file=ROOT/'ml_training/runs/official'/job_id/f'track-{track}.kartai.json'
                    self._json(200,json.loads(file.read_text(encoding='utf-8')))
                except Exception as exc:self._json(404,{'error':str(exc)})
                return
            if parts[5]=='replays':
                from urllib.parse import parse_qs
                from .official_train import read_replays
                query=parse_qs(urlparse(self.path).query)
                try:self._json(200,{'attempts':read_replays(ROOT/'ml_training/runs/official'/job_id,OFFICIAL_CONTROLS[job_id],query.get('cohort',['early'])[0],query.get('trackId',[None])[0])})
                except (ValueError,KeyError) as exc:self._json(400,{'error':str(exc)})
                return
            self._json(404,{'error':'Not found'});return
        if path == "/api/status":
            self._json(200, {**torch_status(), "trackCount": len(load_tracks()), "pairingRequired": True, "apiVersion": 2, "capabilities": ["continuous-control", "imitation", "curriculum", "human-demos"]}); return
        if path.startswith("/api/jobs/"):
            if not self._authorized(): self._json(401, {"error": "Incorrect trainer pairing code"}); return
            job_id = path.rsplit("/", 1)[-1]
            with LOCK: job = JOBS.get(job_id)
            self._json(200, job) if job else self._json(404, {"error": "Training job not found"}); return
        # The local trainer can host the same game assets, so its progress window
        # needs no second web server and no production deployment.
        from urllib.parse import unquote
        import mimetypes
        relative=unquote(path).lstrip('/')
        if not relative:
            self.send_response(302);self.send_header('Location','/index.html?tool=official-ml');self.end_headers();return
        allowed=relative in ['index.html','rb6.glb','online.js','online-codec.js','online-sim.js'] or relative.startswith(('ui/','sim/','core/','ml/'))
        file=(ROOT/relative).resolve()
        if allowed and file.is_relative_to(ROOT) and file.suffix in ['.html','.js','.mjs','.css','.json','.svg','.png','.webp','.woff2','.glb'] and file.is_file():
            data=file.read_bytes();self.send_response(200);self.send_header('Content-Type',mimetypes.guess_type(file.name)[0] or 'application/octet-stream');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data);return
        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        path=urlparse(self.path).path
        if path.startswith('/api/official/'):
            if not self._authorized():self._json(401,{'error':'Incorrect trainer pairing code'});return
            try:
                length=int(self.headers.get('Content-Length','0'))
                if length<=0 or length>MAX_JOB_BYTES:raise ValueError('Job request must be between 1 byte and 10 MB')
                config=json.loads(self.rfile.read(length))
                if path=='/api/official/shutdown':
                    for control in OFFICIAL_CONTROLS.values():control.cancelled.set();control.running.set()
                    def shutdown():
                        import time
                        deadline=time.monotonic()+60
                        while time.monotonic()<deadline and any(j.get('official') and j.get('status') in ['queued','running','paused','stopping'] for j in JOBS.values()):time.sleep(.2)
                        self.server.shutdown()
                    threading.Thread(target=shutdown,daemon=True).start();self._json(200,{'ok':True});return
                if path=='/api/official/jobs':
                    from .official_train import TrainingControl
                    if config.get('format')!='kartblitz-official-job-v1':raise ValueError('Unsupported official job format')
                    with LOCK:
                        if any(j.get('official') and j.get('status') in ['queued','running','paused','stopping'] for j in JOBS.values()):raise ValueError('An official training job is already active; use its parallel workers or stop it first')
                    if config.get('resumeJobId'):
                        resume=str(config.pop('resumeJobId'))
                        if len(resume)!=32 or not all(c in '0123456789abcdef' for c in resume):raise ValueError('Invalid resume job id')
                        config['resumeRun']=str(ROOT/'ml_training/runs/official'/resume)
                    else:config.pop('resumeRun',None)
                    job_id=uuid.uuid4().hex;job={'id':job_id,'official':True,'status':'queued','completedSteps':0,'attempts':0,'logs':['Official training queued']}
                    with LOCK:JOBS[job_id]=job;OFFICIAL_CONTROLS[job_id]=TrainingControl()
                    threading.Thread(target=run_official_job,args=(job_id,config),daemon=True).start();self._json(202,job);return
                parts=path.split('/');job_id=parts[4]
                control=OFFICIAL_CONTROLS.get(job_id)
                if control is None:raise ValueError('Training job not found')
                action=config.get('action')
                if action=='pause':control.running.clear();JOBS[job_id]['status']='paused'
                elif action=='resume':control.running.set();JOBS[job_id]['status']='running'
                elif action=='stop':control.cancelled.set();control.running.set();JOBS[job_id]['status']='stopping'
                elif action=='batch':control.batch=max(0,int(config.get('batch',0)))
                else:raise ValueError('Unknown training control')
                self._json(200,{'ok':True});return
            except Exception as exc:self._json(400,{'error':str(exc)});return
        if urlparse(self.path).path != "/api/jobs": self._json(404, {"error": "Not found"}); return
        if not self._authorized(): self._json(401, {"error": "Incorrect trainer pairing code"}); return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_JOB_BYTES:
                raise ValueError("Training job must be between 1 byte and 10 MB")
            config = json.loads(self.rfile.read(length) or b"{}")
            if config.get("format") != "kartblitz-training-job-v1": raise ValueError("Unsupported training job format")
            total, _, _ = split_training_budget(config.get("totalSteps", 3_000_000)); job_id = uuid.uuid4().hex
            job = {"id": job_id, "status": "queued", "step": 0, "totalSteps": total, "meanReward": None, "device": "—", "logs": ["Training job queued"]}
            with LOCK: JOBS[job_id] = job
            threading.Thread(target=run_job, args=(job_id, {**config, "totalSteps": total}), daemon=True).start(); self._json(202, job)
        except Exception as exc: self._json(400, {"error": str(exc)})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[trainer] {self.address_string()} {fmt % args}")


def main() -> None:
    global PAIRING_CODE
    parser = argparse.ArgumentParser(description="KartBlitz local ML Lab companion")
    parser.add_argument("--port", type=int, default=8765); parser.add_argument("--pairing-code", default="")
    parser.add_argument('--open-official',action='store_true')
    parser.add_argument('--official',action='store_true',help='Initialize official RL libraries on the main thread')
    args = parser.parse_args(); PAIRING_CODE = args.pairing_code.strip() or f"{secrets.randbelow(1_000_000):06d}"
    if args.official or args.open_official:
        os.environ.setdefault('OMP_NUM_THREADS','2')
        os.environ.setdefault('MKL_NUM_THREADS','2')
        # Initialize Torch/SB3 (including optional native dependencies) before
        # starting HTTP worker threads. Cold concurrent imports can hang on Windows.
        from .official_train import _dependencies
        torch,*_=_dependencies();torch.set_num_threads(2)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    connection=ROOT/'ml_training/runs/official'/f'connection-{args.port}.json'
    connection.parent.mkdir(parents=True,exist_ok=True)
    connection.write_text(json.dumps({'port':args.port,'pairingCode':PAIRING_CODE}),encoding='utf-8')
    print("KartBlitz ML trainer is listening on loopback only")
    print(f"URL: http://127.0.0.1:{args.port}")
    print(f"PAIRING CODE: {PAIRING_CODE}")
    status = torch_status(); print(f"DEVICE: {status['deviceName']}")
    if args.open_official:
        import webbrowser
        webbrowser.open(f'http://127.0.0.1:{args.port}/index.html?tool=official-ml&trainerCode={PAIRING_CODE}')
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__ == "__main__": main()
