"""No paid API traffic: fake-key 401, mock successful authorization and duplicate submission."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import uuid
from media.runway_api import RunwayClient,RunwayError,TaskLedger,submit_once,poll_once
from media.runway_poc import main

TASK_ID=str(uuid.uuid4())
REQUEST={"model":"gen4_turbo","promptImage":"https://example.org/image.jpg",
         "promptText":"Gentle wind moves a paper house","ratio":"1280:720","duration":5}

class Response:
    def __init__(self,value):self.value=json.dumps(value).encode()
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def read(self,n):return self.value

class MockHTTP:
    def __init__(self,items):self.items=list(items);self.calls=[]
    def __call__(self,request,timeout):
        self.calls.append(request)
        val=self.items.pop(0)
        if isinstance(val,Exception):raise val
        return Response(val)

class RunwayFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.db=Path(self.temp.name)/"ledger.sqlite"
        self.ledger=TaskLedger(self.db)
    def tearDown(self):
        self.ledger.close();self.temp.cleanup()

    def test_fake_key_401_is_rejected_and_never_resubmitted(self):
        bad=urllib.error.HTTPError("https://api.dev.runwayml.com",401,"Unauthorized",{},io.BytesIO(b"bad"))
        mock=MockHTTP([bad]);client=RunwayClient("1q2w3e4r",opener=mock)
        with self.assertRaises(RunwayError) as seen:
            submit_once(client,self.ledger,"case401",REQUEST)
        self.assertEqual(seen.exception.code,"authentication_failed")
        self.assertEqual(self.ledger.get("case401")["state"],"rejected")
        submit_once(client,self.ledger,"case401",REQUEST)
        self.assertEqual(len(mock.calls),1)

    def test_authenticated_success_path_with_polling_and_review_gate(self):
        mock=MockHTTP([{"id":TASK_ID},{"id":TASK_ID,"status":"PENDING"},
            {"id":TASK_ID,"status":"RUNNING"},{"id":TASK_ID,"status":"SUCCEEDED","output":["https://cdn.example.org/video.mp4"]}])
        client=RunwayClient("mock-valid",opener=mock)
        self.assertEqual(submit_once(client,self.ledger,"ok",REQUEST)["state"],"submitted")
        self.assertEqual(mock.calls[0].get_method(),"POST")
        self.assertEqual(mock.calls[0].get_header("Authorization"),"Bearer mock-valid")
        self.assertEqual(poll_once(client,self.ledger,"ok")["state"],"running")
        self.assertEqual(poll_once(client,self.ledger,"ok")["state"],"running")
        self.assertEqual(poll_once(client,self.ledger,"ok")["state"],"needs_review")
        self.assertIsNone(self.ledger.get("ok")["file_path"])
        self.assertEqual(submit_once(client,self.ledger,"ok",REQUEST)["state"],"needs_review")
        self.assertEqual(sum(request.get_method()=="POST" for request in mock.calls),1)

    def test_unknown_submission_never_gets_submitted_again(self):
        mock=MockHTTP([urllib.error.URLError("lost")])
        client=RunwayClient("mock-valid",opener=mock)
        with self.assertRaises(RunwayError) as e:
            submit_once(client,self.ledger,"lost",REQUEST)
        self.assertTrue(e.exception.submission_unknown)
        self.assertEqual(submit_once(client,self.ledger,"lost",REQUEST)["state"],"submission_unknown")
        self.assertEqual(len(mock.calls),1)

    def test_paid_submit_requires_explicit_confirmation(self):
        request=Path(self.temp.name)/"request.json";request.write_text(json.dumps(REQUEST))
        with patch.dict("os.environ",{"RUNWAYML_API_SECRET":"1q2w3e4r"}):
            self.assertEqual(main(["--ledger",str(self.db),"submit","--request",str(request),"--run-id","unconfirmed"]),2)
        with self.assertRaises(KeyError):
            self.ledger.get("unconfirmed")

if __name__=="__main__":unittest.main()
