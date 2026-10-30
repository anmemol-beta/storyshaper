"""Narration server queue, cache, voice registration and HTTP checks with fakes (no Chatterbox or Meta API)."""
import http.client
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

import numpy as np

from narration.server import Narrator, Server
from narration.voices import SR, VoiceLibrary, clip_quality, suggest_clips, write_wav


class FakeVoice:
    """Records the order lines are voiced; blocks until released so queue order can be observed."""

    def __init__(self, hold=False):
        self.order, self.gate = [], threading.Event()
        if not hold:
            self.gate.set()

    def __call__(self, text, voice):
        self.gate.wait(5)
        if text == "boom":
            raise RuntimeError("model error")
        self.order.append(text)
        return b"ID3" + f"{voice['ref']}|{text}".encode()


def speech_like(seconds_on_off, sr=SR, noise=0.002, seed=0):
    """Alternate 'talking' (a loud 220 Hz tone) and quiet room noise, e.g. [(0, 2), (1, 6), (0, 3)]."""
    rng = np.random.default_rng(seed)
    parts = []
    for loud, seconds in seconds_on_off:
        t = np.arange(int(seconds * sr)) / sr
        part = rng.normal(0, noise, len(t))
        if loud:
            part += 0.3 * np.sin(2 * np.pi * 220 * t)
        parts.append(part)
    return np.concatenate(parts).astype(np.float32)


class NarratorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def key(self, n, role, text, ref=None):
        return n.key(n.settings(role, ref), text)

    def test_roles_follow_casting(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        self.assertEqual([n.role(s) for s in ["narrator", "pig1", "pig3", "wolf", "mother", None]],
                         ["narrator", "pig", "pig", "wolf", "narrator", "narrator"])

    def test_clip_is_generated_once_and_cached(self):
        voice = FakeVoice()
        n = Narrator(voice, self.tmp.name)
        [clip] = n.submit([{"speakerId": "wolf", "text": "Let me come in!"}])
        self.assertFalse(clip["ready"])
        self.assertEqual(n.wait("default", clip["key"], 5), "ready")
        self.assertIn(b"wolf_libritts_1188.wav", n.path("default", clip["key"]).read_bytes())
        [again] = n.submit([{"speakerId": "wolf", "text": "Let me come in!"}])
        self.assertTrue(again["ready"])
        self.assertEqual(voice.order, ["Let me come in!"])

    def test_registered_voice_replaces_parent_roles_only(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        narrator, pig, wolf = n.submit([{"speakerId": "narrator", "text": "Hi."}, {"speakerId": "pig2", "text": "Hi."},
                                        {"speakerId": "wolf", "text": "Hi."}], "abcdef123456", "/profiles/dad.wav")
        for clip in (narrator, pig, wolf):
            self.assertEqual(n.wait("abcdef123456", clip["key"], 5), "ready")
        read = lambda c: n.path("abcdef123456", c["key"]).read_bytes()
        self.assertIn(b"/profiles/dad.wav", read(narrator))
        self.assertIn(b"/profiles/dad.wav", read(pig))
        self.assertIn(b"wolf_libritts_1188.wav", read(wolf))
        self.assertEqual(narrator["url"], f"/audio/abcdef123456/{narrator['key']}.mp3")

    def test_all_roles_reads_the_wolf_in_the_parent_voice(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        [usual] = n.submit([{"speakerId": "wolf", "text": "Let me in!"}], "abcdef123456", "/profiles/dad.wav")
        [every] = n.submit([{"speakerId": "wolf", "text": "Let me in!"}], "abcdef123456", "/profiles/dad.wav", True)
        [default] = n.submit([{"speakerId": "wolf", "text": "Let me in!"}], all_roles=True)
        for voice, clip in (("abcdef123456", usual), ("abcdef123456", every), ("default", default)):
            self.assertEqual(n.wait(voice, clip["key"], 5), "ready")
        self.assertIn(b"wolf_libritts_1188.wav", n.path("abcdef123456", usual["key"]).read_bytes())
        self.assertIn(b"/profiles/dad.wav", n.path("abcdef123456", every["key"]).read_bytes())
        self.assertIn(b"voice/ref_clip.wav", n.path("default", default["key"]).read_bytes())

    def test_korean_lines_use_the_same_parent_clip_with_their_own_cache(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        [en] = n.submit([{"text": "Hello."}], "abcdef123456", "/profiles/dad.wav")
        [ko] = n.submit([{"text": "Hello."}], "abcdef123456", "/profiles/dad.wav", language="ko")
        [en_again] = n.submit([{"text": "Hello."}], "abcdef123456", "/profiles/dad.wav", language="en")
        self.assertNotEqual(en["key"], ko["key"])
        self.assertEqual(en["key"], en_again["key"])        # English keys are unchanged by the language option
        for clip in (en, ko):
            self.assertEqual(n.wait("abcdef123456", clip["key"], 5), "ready")
            self.assertIn(b"/profiles/dad.wav", n.path("abcdef123456", clip["key"]).read_bytes())

    def test_newest_request_is_voiced_first_in_line_order(self):
        voice = FakeVoice(hold=True)
        n = Narrator(voice, self.tmp.name)
        n.submit([{"text": "old 1"}, {"text": "old 2"}])
        n.submit([{"text": "new 1"}, {"text": "new 2"}])
        voice.gate.set()
        for text in ["old 1", "old 2", "new 1", "new 2"]:
            self.assertEqual(n.wait("default", self.key(n, "narrator", text), 5), "ready")
        # "old 1" may already be in progress when the new request arrives; the rest follows priority.
        order = voice.order
        self.assertLess(order.index("new 1"), order.index("new 2"))
        self.assertLess(order.index("new 2"), order.index("old 2"))

    def test_failure_is_reported_and_queue_continues(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        bad, good = n.submit([{"text": "boom"}, {"text": "fine"}])
        self.assertEqual(n.wait("default", bad["key"], 5), "failed")
        self.assertEqual(n.wait("default", good["key"], 5), "ready")

    def test_wait_times_out_while_pending(self):
        voice = FakeVoice(hold=True)
        n = Narrator(voice, self.tmp.name)
        [clip] = n.submit([{"text": "slow"}])
        self.assertEqual(n.wait("default", clip["key"], 0.05), "pending")
        self.assertEqual(n.wait("default", "0" * 16, 0), "unknown")
        voice.gate.set()
        self.assertEqual(n.wait("default", clip["key"], 5), "ready")

    def test_forget_drops_queue_and_clips_of_a_voice(self):
        voice = FakeVoice(hold=True)
        n = Narrator(voice, self.tmp.name)
        [done] = n.submit([{"text": "kept?"}], "aaaaaaaaaaaa", "/x.wav")
        voice.gate.set()
        self.assertEqual(n.wait("aaaaaaaaaaaa", done["key"], 5), "ready")
        voice.gate.clear()
        [queued] = n.submit([{"text": "never"}], "aaaaaaaaaaaa", "/x.wav")
        n.forget("aaaaaaaaaaaa")
        voice.gate.set()
        self.assertFalse((Path(self.tmp.name) / "aaaaaaaaaaaa").exists())
        self.assertEqual(n.wait("aaaaaaaaaaaa", queued["key"], 0.5), "unknown")


class FillerListTest(unittest.TestCase):
    def test_warm_script_uses_the_same_fillers_as_the_page(self):
        import re
        from narration.warm import FILLERS
        page = (Path(__file__).resolve().parent.parent / "prototype" / "narration.js").read_text(encoding="utf-8")
        from narration.warm import FILLERS_KO
        for name, expected in (("FILLERS", FILLERS), ("FILLERS_KO", FILLERS_KO)):
            block = re.search(rf"const {name} = \[(.*?)\];", page, re.S).group(1)
            self.assertEqual(re.findall(r'"([^"]+)"', block), expected)


class ClipAnalysisTest(unittest.TestCase):
    def test_suggests_the_part_with_the_most_talking(self):
        audio = speech_like([(0, 4), (1, 1), (0, 6), (1, 12), (0, 4)])
        [first, *rest] = suggest_clips(audio, SR)
        self.assertAlmostEqual(first["start"], 11, delta=0.3)
        self.assertAlmostEqual(first["end"] - first["start"], 10, delta=0.1)
        self.assertGreater(first["speech"], 0.95)

    def test_quality_flags_short_quiet_and_noisy_clips(self):
        good = speech_like([(1, 10)] + [(0, 0.5), (1, 2)])
        whole = np.concatenate([speech_like([(0, 3)]), good])
        self.assertTrue(clip_quality(good, SR, whole)["ok"])
        short = clip_quality(good[: SR * 3], SR, whole)
        self.assertIn("shorter", " ".join(short["problems"]))
        sparse = speech_like([(1, 2), (0, 8)])
        self.assertIn("speech", " ".join(clip_quality(sparse, SR, np.concatenate([sparse, sparse]))["problems"]))
        noisy = speech_like([(1, 10), (0, 3)], noise=0.15)
        self.assertIn("noise", " ".join(clip_quality(noisy, SR, noisy)["problems"]))


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class VoiceLibraryTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.heard = []
        self.library = VoiceLibrary(self.root / "profiles", lambda wav: self.heard.append(len(wav)) or "once upon a time")
        write_wav(self.root / "talk.wav", speech_like([(0, 2), (1, 12), (0, 2)]))
        # A "video": a black picture with the recording as its sound track.
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=black:s=64x64:d=16",
                        "-i", str(self.root / "talk.wav"), "-shortest", "-c:v", "libx264", "-c:a", "aac",
                        str(self.root / "dad.mp4")], check=True)

    def test_register_from_video_then_save_keeps_only_the_clip(self):
        draft = self.library.create((self.root / "dad.mp4").read_bytes(), "video/mp4")
        self.assertEqual((draft["status"], draft["source"]), ("draft", "video"))
        clip = draft["suggestions"][0]
        meta = self.library.choose(draft["id"], clip["start"], clip["end"])
        self.assertEqual(meta["transcript"], "once upon a time")
        self.assertTrue(meta["quality"]["ok"], meta["quality"])
        self.assertEqual(len(self.heard), 1)
        saved = self.library.save(draft["id"], "Dad", "family_consented", True)
        self.assertEqual(saved["consent"]["relation"], "family_consented")
        folder = self.root / "profiles" / draft["id"]
        self.assertEqual(sorted(p.name for p in folder.iterdir()), ["meta.json", "ref.wav"])
        self.assertEqual([v["name"] for v in self.library.saved()], ["Dad"])
        self.library.delete(draft["id"])
        self.assertFalse(folder.exists())

    def test_recorded_consent_sentence_is_heard(self):
        library = VoiceLibrary(self.root / "p2", lambda wav: "and dreamed of honey. I'm happy for my voice to read stories to my child.")
        draft = library.create((self.root / "talk.wav").read_bytes(), "audio/webm", check_consent=True)
        self.assertTrue(draft["consentHeard"])
        library.choose(draft["id"], 2, 12)
        self.assertTrue(library.save(draft["id"], "Dad", "me", True)["consent"]["spoken"])
        quiet = VoiceLibrary(self.root / "p3", lambda wav: "once upon a time")
        self.assertFalse(quiet.create((self.root / "talk.wav").read_bytes(), "audio/webm", check_consent=True)["consentHeard"])
        self.assertNotIn("consentHeard", quiet.create((self.root / "talk.wav").read_bytes(), "video/mp4"))

    def test_consent_and_bad_files_are_refused(self):
        draft = self.library.create((self.root / "talk.wav").read_bytes(), "audio/wav")
        self.library.choose(draft["id"], 2, 12)
        for args in [("Dad", "celebrity", True), ("Dad", "me", False), ("", "me", True)]:
            with self.assertRaises(Exception):
                self.library.save(draft["id"], *args)
        self.assertEqual(self.library.saved(), [])
        with self.assertRaises(Exception):
            self.library.create(b"not audio at all", "audio/wav")
        self.assertEqual([p.name for p in (self.root / "profiles").iterdir()], [draft["id"]])


class HttpTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        library = VoiceLibrary(Path(tmp.name) / "profiles", lambda wav: "hello")
        self.server = Server(("127.0.0.1", 0), Narrator(FakeVoice(), Path(tmp.name) / "cache"), library)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.host = f"127.0.0.1:{self.server.server_port}"
        self.wav = Path(tmp.name) / "talk.wav"
        write_wav(self.wav, speech_like([(0, 1), (1, 11), (0, 1)]))

    def request(self, method, path, body=None, headers=None, raw=None):
        conn = http.client.HTTPConnection(self.host, timeout=20)
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        conn.request(method, path, data, {"Host": self.host, "Content-Type": "application/json", **(headers or {})})
        res = conn.getresponse()
        return res.status, dict(res.getheaders()), res.read()

    def test_queue_then_fetch_audio_from_a_local_page(self):
        origin = {"Origin": "http://127.0.0.1:8000"}
        status, headers, body = self.request("POST", "/api/voice/lines",
                                             {"lines": [{"speakerId": "pig2", "text": "Not by the hair!"}]}, origin)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://127.0.0.1:8000")
        clip = json.loads(body)["clips"][0]
        self.assertEqual(clip["role"], "pig")
        status, headers, audio = self.request("GET", clip["url"] + "?wait=5", headers=origin)
        self.assertEqual((status, headers["Content-Type"]), (200, "audio/mpeg"))
        self.assertTrue(audio.startswith(b"ID3"))

    @unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
    def test_register_preview_save_read_and_delete_a_voice(self):
        status, _, body = self.request("POST", "/api/voices", raw=self.wav.read_bytes(),
                                       headers={"Content-Type": "audio/wav"})
        self.assertEqual(status, 201, body)
        draft = json.loads(body)
        vid = draft["id"]
        self.assertEqual(self.request("GET", f"/api/voices/{vid}/full.wav")[0], 200)
        # A draft without a chosen clip cannot read yet.
        self.assertEqual(self.request("POST", "/api/voice/lines", {"lines": [{"text": "Hi"}], "voiceId": vid})[0], 409)
        status, _, body = self.request("POST", f"/api/voices/{vid}/clip", draft["suggestions"][0])
        self.assertEqual((status, json.loads(body)["transcript"]), (200, "hello"))
        status, _, body = self.request("POST", f"/api/voices/{vid}/preview", {})
        preview = json.loads(body)
        self.assertEqual(self.request("GET", preview["url"] + "?wait=5")[0], 200)
        # The preview is the book's first line in the same voice, so the book starts without waiting.
        status, _, body = self.request("POST", "/api/voice/lines", {"lines": [{"text": preview["text"]}], "voiceId": vid, "peek": True})
        self.assertEqual(json.loads(body)["clips"][0]["key"], preview["key"])
        self.assertTrue(json.loads(body)["clips"][0]["ready"])
        status, _, body = self.request("POST", "/api/voice/lines", {"lines": [{"text": "Not yet read."}], "voiceId": vid, "peek": True})
        self.assertFalse(json.loads(body)["clips"][0]["ready"])
        self.assertEqual(self.request("GET", json.loads(body)["clips"][0]["url"])[0], 404)  # peek queues nothing
        self.assertEqual(self.request("POST", f"/api/voices/{vid}/save", {"name": "Dad", "relation": "me"})[0], 400)
        status, _, _ = self.request("POST", f"/api/voices/{vid}/save", {"name": "Dad", "relation": "me", "attested": True})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(self.request("GET", "/api/voices")[2])["voices"][0]["name"], "Dad")
        status, _, body = self.request("POST", "/api/voice/lines", {"lines": [{"text": "Hi"}], "voiceId": vid})
        clip = json.loads(body)["clips"][0]
        self.assertEqual(self.request("GET", clip["url"] + "?wait=5")[0], 200)
        self.assertEqual(self.request("DELETE", f"/api/voices/{vid}")[0], 200)
        self.assertEqual(self.request("GET", clip["url"])[0], 404)
        self.assertEqual(json.loads(self.request("GET", "/api/voices")[2])["voices"], [])

    @unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
    def test_training_sentences_are_stored_with_their_text_and_checked(self):
        status, _, body = self.request("POST", "/api/voices", raw=self.wav.read_bytes(), headers={"Content-Type": "audio/wav"})
        vid = json.loads(body)["id"]
        status, _, body = self.request("POST", f"/api/voices/{vid}/train/1", raw=self.wav.read_bytes(),
                                       headers={"Content-Type": "audio/wav"})
        clip = json.loads(body)
        self.assertEqual((status, clip["n"]), (200, 1))
        self.assertTrue(clip["text"].startswith("Once upon a time"))
        self.assertEqual(clip["heard"], "hello")               # the fake transcriber
        self.assertLess(clip["match"], 0.5)                     # "hello" is not the sentence
        self.assertEqual(self.request("POST", f"/api/voices/{vid}/train/999", raw=b"x", headers={"Content-Type": "audio/wav"})[0], 404)
        self.assertEqual(self.request("POST", f"/api/voices/{vid}/train/2", raw=b"x", headers={"Content-Type": "text/plain"})[0], 415)
        status, _, body = self.request("GET", f"/api/voices/{vid}/train")
        progress = json.loads(body)
        self.assertEqual(([c["n"] for c in progress["clips"]], progress["total"]), ([1], 100))
        self.assertGreater(progress["seconds"], 10)
        self.assertEqual(self.request("DELETE", f"/api/voices/{vid}")[0], 200)

    def test_preflight_allows_local_origin_only(self):
        status, headers, _ = self.request("OPTIONS", "/api/voice/lines", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(status, 204)
        self.assertIn("DELETE", headers["Access-Control-Allow-Methods"])
        status, _, _ = self.request("OPTIONS", "/api/voice/lines", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_rejects_bad_requests(self):
        self.assertEqual(self.request("POST", "/api/voice/lines", {"lines": []})[0], 400)
        self.assertEqual(self.request("POST", "/api/voice/lines", {"lines": [{"text": "Hi"}], "language": "fr"})[0], 400)
        self.assertEqual(self.request("POST", "/api/voice/lines", {"lines": [{"text": "x" * 501}]})[0], 400)
        self.assertEqual(self.request("POST", "/api/voices", raw=b"hello", headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("GET", "/audio/../../.env")[0], 404)
        self.assertEqual(self.request("GET", "/audio/default/" + "0" * 16 + ".mp3")[0], 404)
        self.assertEqual(self.request("GET", "/api/voices/" + "0" * 12 + "/full.wav")[0], 404)
        status, _, _ = self.request("GET", "/api/voice/config", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
