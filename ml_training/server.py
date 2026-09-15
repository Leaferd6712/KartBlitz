from __future__ import annotations

import argparse
import json
import secrets
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .environment import load_tracks
from .train import train_model

JOBS: dict[str, dict[str, Any]] = {}
LOCK = threading.Lock()
PAIRING_CODE = ""


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


class Handler(BaseHTTPRequestHandler):
    server_version = "KartBlitzML/1.0"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*") or "*")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-KartBlitz-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(payload).encode("utf-8"); self.send_response(status); self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(encoded))); self.end_headers(); self.wfile.write(encoded)

    def _authorized(self) -> bool:
        return secrets.compare_digest(self.headers.get("X-KartBlitz-Key", ""), PAIRING_CODE)

    def do_OPTIONS(self) -> None:
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/status":
            self._json(200, {**torch_status(), "trackCount": len(load_tracks()), "pairingRequired": True, "apiVersion": 1}); return
        if path.startswith("/api/jobs/"):
            if not self._authorized(): self._json(401, {"error": "Incorrect trainer pairing code"}); return
            job_id = path.rsplit("/", 1)[-1]
            with LOCK: job = JOBS.get(job_id)
            self._json(200, job) if job else self._json(404, {"error": "Training job not found"}); return
        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/jobs": self._json(404, {"error": "Not found"}); return
        if not self._authorized(): self._json(401, {"error": "Incorrect trainer pairing code"}); return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 64_000)
            config = json.loads(self.rfile.read(length) or b"{}")
            if config.get("format") != "kartblitz-training-job-v1": raise ValueError("Unsupported training job format")
            total = max(4096, min(int(config.get("totalSteps", 150000)), 10_000_000)); job_id = uuid.uuid4().hex
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
    args = parser.parse_args(); PAIRING_CODE = args.pairing_code.strip() or f"{secrets.randbelow(1_000_000):06d}"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print("KartBlitz ML trainer is listening on loopback only")
    print(f"URL: http://127.0.0.1:{args.port}")
    print(f"PAIRING CODE: {PAIRING_CODE}")
    status = torch_status(); print(f"DEVICE: {status['deviceName']}")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__ == "__main__": main()

