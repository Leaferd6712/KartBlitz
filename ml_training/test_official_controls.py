import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from unittest.mock import patch
from . import server
from .official_train import TrainingControl

class ControlTests(unittest.TestCase):
    def test_stop_is_idempotent_and_does_not_reopen_finished_jobs(self):
        job_id='c'*32;control=TrainingControl();jobs={job_id:{'id':job_id,'status':'complete'}}
        with patch.object(server,'JOBS',jobs),patch.object(server,'OFFICIAL_CONTROLS',{job_id:control}),patch.object(server,'PAIRING_CODE','control-test'):
            http=ThreadingHTTPServer(('127.0.0.1',0),server.Handler);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            url=f'http://127.0.0.1:{http.server_port}/api/official/jobs/{job_id}/control'
            def send(action):
                request=Request(url,data=json.dumps({'action':action}).encode(),headers={'X-KartBlitz-Key':'control-test','Content-Type':'application/json'})
                with urlopen(request) as response:return json.load(response)
            try:
                for action in ['stop','pause','resume']:
                    result=send(action);self.assertEqual(result['status'],'complete');self.assertTrue(result['alreadyFinished'])
                self.assertFalse(control.cancelled.is_set())
                jobs[job_id]['status']='paused';control.running.clear()
                self.assertEqual(send('stop')['status'],'stopping');self.assertTrue(control.cancelled.is_set());self.assertTrue(control.running.is_set())
                self.assertEqual(send('stop')['status'],'stopping')
                with self.assertRaises(HTTPError) as error:send('resume')
                self.assertEqual(error.exception.code,400)
                self.assertFalse(control.check())
                jobs[job_id]['status']='cancelled';self.assertEqual(send('stop')['status'],'cancelled')
            finally:http.shutdown();http.server_close();thread.join()

if __name__=='__main__':unittest.main()
