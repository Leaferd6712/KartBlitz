import json
import tempfile
import unittest
import threading
from http.server import ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from pathlib import Path
from unittest.mock import patch
from . import server

class CatalogTests(unittest.TestCase):
    def test_catalog_http_is_paired_and_read_only(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(server,'ROOT',Path(temp)),patch.object(server,'JOBS',{}),patch.object(server,'PAIRING_CODE','catalog-test'),patch.object(server,'MODEL_CATALOG_CACHE',{}):
            job='b'*32;directory=Path(temp)/'ml_training/runs/official'/job;directory.mkdir(parents=True)
            pack={'format':'kartblitz-official-track-v1','trackId':0,'trackFingerprint':'abc','variants':{'extreme':{}},'name':'Candidate'}
            file=directory/'track-0.kartai.json';file.write_text(json.dumps(pack));before=file.read_bytes()
            http=ThreadingHTTPServer(('127.0.0.1',0),server.Handler);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{http.server_port}/api/official/models'
            try:
                with self.assertRaises(HTTPError) as error:urlopen(base)
                self.assertEqual(error.exception.code,401)
                def get(url):
                    with urlopen(Request(url,headers={'X-KartBlitz-Key':'catalog-test'})) as response:return json.load(response)
                self.assertEqual(get(base)['models'][0]['jobId'],job)
                self.assertEqual(get(f'{base}/{job}/0')['package'],pack)
                self.assertEqual(file.read_bytes(),before);self.assertEqual(server.JOBS,{})
            finally:http.shutdown();http.server_close();thread.join()

    def test_saved_models_survive_server_restart_and_do_not_activate(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(server,'ROOT',Path(temp)),patch.object(server,'JOBS',{}),patch.object(server,'MODEL_CATALOG_CACHE',{}):
            job='a'*32;directory=Path(temp)/'ml_training/runs/official'/job;directory.mkdir(parents=True)
            pack={'format':'kartblitz-official-track-v1','trackId':0,'trackFingerprint':'abc','name':'Saved','variants':{'extreme':{}},'physicsHash':'test','createdAt':123}
            (directory/'track-0.kartai.json').write_text(json.dumps(pack))
            rows=server.saved_official_models();self.assertEqual(len(rows),1);self.assertEqual(rows[0]['jobId'],job)
            self.assertEqual(server.saved_official_model(job,0)['package'],pack)
            server.JOBS[job]={'status':'running'};self.assertEqual(server.saved_official_models(),[])
            server.JOBS.clear();self.assertEqual(server.saved_official_models(),rows)
            with self.assertRaises(ValueError):server.saved_official_model('../escape',0)
            with self.assertRaises(ValueError):server.saved_official_model(job,8)

if __name__=='__main__':unittest.main()
