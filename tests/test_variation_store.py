"""No provider charges: story generation variants and idempotent retries."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from media.variation_store import VariationStore

H=lambda x:hashlib.sha256(x.encode()).hexdigest()

class VariantTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.clock=[1000]
        self.store=VariationStore(Path(self.tmp.name)/"variant.db",clock=lambda:self.clock[0])
        self.story=self.store.start_story("three_pigs")
    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()
    def request(self,image="old",intent="first",action="reuse",story=None,version=2):
        return self.store.request(story or self.story,"house1/paper/blown_away",version,
                                  H(image),H("prompt"),intent,action)
    def test_retry_same_intent(self):
        a=self.request()
        self.assertEqual(a["id"],self.request()["id"])
        self.assertEqual(a["id"],self.request(intent="new-retry")["id"])
    def test_regenerate_gets_new_media_revision(self):
        a=self.request()
        b=self.request(intent="again",action="regenerate")
        self.assertNotEqual(a["id"],b["id"])
        self.assertEqual(b["media_revision"],2)
        self.assertEqual(b["id"],self.request(intent="again",action="regenerate")["id"])
    def test_input_change_is_not_cached(self):
        self.request()
        self.assertEqual(self.request(image="different",intent="new")["media_revision"],2)
    def test_story_restart_is_isolated(self):
        a=self.request()
        new_story=self.store.start_story("three_pigs")
        b=self.request(story=new_story,intent="new")
        self.assertNotEqual(a["id"],b["id"])
    def test_branch_version_does_not_expose_old_media(self):
        self.request()
        self.assertEqual(self.request(intent="changed-branch",version=3)["story_version"],3)
        self.assertIsNone(self.store.selected(self.story,"house1/paper/blown_away",3))
    def test_idempotency_conflict_is_rejected(self):
        self.request()
        with self.assertRaises(ValueError):
            self.request(image="different")
    def test_review_requires_ledger_download(self):
        entry=self.request()
        with self.assertRaises(ValueError):
            self.store.review(entry["id"],"output.mp4",approve=True)
        self.assertIsNone(self.store.selected(self.story,"house1/paper/blown_away",2))
    def test_rejection_and_expiry(self):
        entry=self.request()
        self.store.review(entry["id"],"irrelevant",approve=False)
        self.assertEqual(self.store.get(entry["id"])["state"],"rejected")
        self.clock[0]+=7*86400+1
        with self.assertRaises(ValueError):
            self.request(intent="after-expiry")
if __name__=="__main__":
    unittest.main()
