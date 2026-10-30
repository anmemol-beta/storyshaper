"""Narration server queue, cache and HTTP checks with a fake synthesizer (no Chatterbox needed)."""
import http.client
import json
import tempfile
import threading
import unittest

from narration.server import Narrator, Server


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


class NarratorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_roles_follow_casting(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        self.assertEqual([n.role(s) for s in ["narrator", "pig1", "pig3", "wolf", "mother", None]],
                         ["narrator", "pig", "pig", "wolf", "narrator", "narrator"])

    def test_clip_is_generated_once_and_cached(self):
        voice = FakeVoice()
        n = Narrator(voice, self.tmp.name)
        [clip] = n.submit([{"speakerId": "wolf", "text": "Let me come in!"}])
        self.assertFalse(clip["ready"])
        self.assertEqual(n.wait(clip["key"], 5), "ready")
        self.assertIn(b"wolf_libritts_1188.wav", n.path(clip["key"]).read_bytes())
        [again] = n.submit([{"speakerId": "wolf", "text": "Let me come in!"}])
        self.assertTrue(again["ready"])
        self.assertEqual(voice.order, ["Let me come in!"])

    def test_same_text_differs_by_role(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        a, b = n.submit([{"speakerId": "narrator", "text": "Hello!"}, {"speakerId": "wolf", "text": "Hello!"}])
        self.assertNotEqual(a["key"], b["key"])
        self.assertEqual([n.wait(c["key"], 5) for c in (a, b)], ["ready", "ready"])

    def test_newest_request_is_voiced_first_in_line_order(self):
        voice = FakeVoice(hold=True)
        n = Narrator(voice, self.tmp.name)
        n.submit([{"text": "old 1"}, {"text": "old 2"}])
        n.submit([{"text": "new 1"}, {"text": "new 2"}])
        voice.gate.set()
        for text in ["old 1", "old 2", "new 1", "new 2"]:
            self.assertEqual(n.wait(n.key("narrator", text), 5), "ready")
        # "old 1" may already be in progress when the new request arrives; the rest follows priority.
        order = voice.order
        self.assertLess(order.index("new 1"), order.index("new 2"))
        self.assertLess(order.index("new 2"), order.index("old 2"))

    def test_failure_is_reported_and_queue_continues(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        bad, good = n.submit([{"text": "boom"}, {"text": "fine"}])
        self.assertEqual(n.wait(bad["key"], 5), "failed")
        self.assertEqual(n.wait(good["key"], 5), "ready")

    def test_wait_times_out_while_pending(self):
        voice = FakeVoice(hold=True)
        n = Narrator(voice, self.tmp.name)
        [clip] = n.submit([{"text": "slow"}])
        self.assertEqual(n.wait(clip["key"], 0.05), "pending")
        self.assertEqual(n.wait("0" * 16, 0), "unknown")
        voice.gate.set()
        self.assertEqual(n.wait(clip["key"], 5), "ready")


class HttpTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.server = Server(("127.0.0.1", 0), Narrator(FakeVoice(), tmp.name))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.host = f"127.0.0.1:{self.server.server_port}"

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection(self.host, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
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

    def test_preflight_allows_local_origin_only(self):
        status, headers, _ = self.request("OPTIONS", "/api/voice/lines", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(status, 204)
        self.assertIn("POST", headers["Access-Control-Allow-Methods"])
        status, _, _ = self.request("OPTIONS", "/api/voice/lines", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)

    def test_rejects_bad_requests(self):
        self.assertEqual(self.request("POST", "/api/voice/lines", {"lines": []})[0], 400)
        self.assertEqual(self.request("POST", "/api/voice/lines", {"lines": [{"text": "x" * 501}]})[0], 400)
        self.assertEqual(self.request("GET", "/audio/../../.env")[0], 404)
        self.assertEqual(self.request("GET", "/audio/" + "0" * 16 + ".mp3")[0], 404)
        status, _, _ = self.request("GET", "/api/voice/config", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
