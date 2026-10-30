"""Verified MP4 approval gate tests, no paid calls or network."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from media.runway_api import TaskLedger, RunwayError
from media.runway_approval import review

@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),"ffmpeg/ffprobe required")
class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        (self.root/"media").mkdir()
        (self.root/"media/scene_registry.json").write_text(json.dumps({"revision":2,
            "images":{"house1/paper/blown_away":{"file":"wolf_paper.jpg","cast":["wolf","pig1"]}},
            "clips":{}}))
        self.ledger=TaskLedger(self.root/"ledger.sqlite3")
        self.ledger.db.execute("INSERT INTO tasks(run_id,request_hash,state,file_path) VALUES(?,?,?,?)",
            ("review-001","x","downloaded",str(self.root/"source.mp4")))
        self.ledger.db.commit()
        subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-f","lavfi",
            "-i","color=c=yellow:s=320x192:r=10","-t","1","-pix_fmt","yuv420p",
            "-c:v","libx264",str(self.root/"source.mp4")],check=True,timeout=20)
    def tearDown(self):
        self.ledger.close();self.temp.cleanup()
    def test_explicit_approval_adds_reviewed_clip_only_after_human_gate(self):
        reg=self.root/"media/scene_registry.json"
        self.assertFalse(json.loads(reg.read_text())["clips"])
        row=review(self.ledger,"review-001","house1/paper/blown_away",root=self.root,approve=True)
        self.assertEqual(row["state"],"approved")
        video=self.root/"prototype/video/runway_review-001.mp4"
        self.assertTrue(video.is_file())
        data=json.loads(reg.read_text())
        self.assertEqual(data["revision"],3)
        self.assertEqual(data["clips"]["house1/paper/blown_away"],
            {"file":video.name,"reviewed":True,"cast":["wolf","pig1"]})
        with self.assertRaises(RunwayError):
            review(self.ledger,"review-001","house1/paper/blown_away",root=self.root,approve=True)
    def test_review_reject_does_not_publish(self):
        row=review(self.ledger,"review-001",None,root=self.root,approve=False)
        self.assertEqual(row["state"],"rejected_by_reviewer")
        self.assertFalse(json.loads((self.root/"media/scene_registry.json").read_text())["clips"])
        with self.assertRaises(RunwayError):
            review(self.ledger,"review-001","house1/paper/blown_away",root=self.root,approve=True)
    def test_unknown_scene_cannot_be_published(self):
        with self.assertRaises(ValueError):
            review(self.ledger,"review-001","house99/unknown/blown_away",root=self.root,approve=True)
        self.assertFalse(json.loads((self.root/"media/scene_registry.json").read_text())["clips"])

if __name__=="__main__":unittest.main()
