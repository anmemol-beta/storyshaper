"""Whole-scene readiness and continuous playback files, without TTS models."""
from functools import lru_cache
from array import array
import http.client
import io
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import wave

from narration.scene_audio import RATE, decoded_pcm
from narration.server import Handler, Narrator, Server
from narration.voices import VoiceLibrary


@lru_cache(maxsize=1)
def mp3_fixture():
    return subprocess.run([
        "ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:duration=0.18", "-ac", "1", "-ar", str(RATE),
        "-f", "mp3", "pipe:1",
    ], capture_output=True, check=True).stdout


@unittest.skipUnless(shutil.which("ffmpeg"), "scene audio decoding needs ffmpeg")
class SceneAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.lines = [{"speakerId": "pig1", "text": "First."},
                      {"speakerId": "wolf", "text": "Second."},
                      {"speakerId": "narrator", "text": "What happens next?", "tone": "curious", "emotion": "curious"}]

    def narrator(self, synth=None):
        return Narrator(synth or (lambda text, settings: mp3_fixture()), self.root / "cache")

    def finish(self, narrator, lines=None, voice="default", timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = narrator.scenes.submit(lines or self.lines, voice)
            if value["status"] != "pending":
                return value
            time.sleep(.01)
        self.fail("scene did not finish")

    def test_scene_has_no_url_until_every_line_and_question_are_ready_then_joins_once(self):
        held, release = threading.Event(), threading.Event()
        calls = []

        def synth(text, settings):
            calls.append(text)
            if text == "What happens next?":
                held.set()
                release.wait(3)
            return mp3_fixture()

        self.addCleanup(release.set)
        narrator = self.narrator(synth)
        first = narrator.scenes.submit(self.lines)
        self.assertEqual(first["status"], "pending")
        self.assertIsNone(first["url"])
        self.assertTrue(held.wait(2))
        for _ in range(3):
            pending = narrator.scenes.submit(self.lines)
            self.assertEqual(pending["sceneKey"], first["sceneKey"])
            self.assertEqual(pending["status"], "pending")
            self.assertIsNone(pending["url"])
        release.set()
        result = self.finish(narrator)
        self.assertEqual((result["status"], result["ready"], result["total"]), ("ready", 3, 3))
        self.assertEqual(calls, [line["text"] for line in self.lines])
        self.assertEqual([segment["lineIndex"] for segment in result["segments"]], [0, 1, 2])
        self.assertEqual([segment["speakerId"] for segment in result["segments"]], ["pig1", "wolf", "narrator"])
        self.assertEqual(result["segments"][0]["start"], 0)
        for before, after in zip(result["segments"], result["segments"][1:]):
            self.assertEqual(before["end"], after["start"])
        path = narrator.scenes.path("default", result["sceneKey"])
        with wave.open(str(path), "rb") as audio:
            self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate()), (1, 2, RATE))
            self.assertAlmostEqual(audio.getnframes() / RATE, result["duration"])
        # A restarted manager may reuse a fully committed scene with no new line synthesis.
        restored = self.narrator(lambda *_: self.fail("ready scene synthesized again"))
        self.assertEqual(restored.scenes.submit(self.lines), result)

    def test_peek_never_queues_and_failed_scene_requires_explicit_retry(self):
        calls, fail = [], [True]

        def synth(text, settings):
            calls.append(text)
            if fail[0]:
                raise RuntimeError("controlled failure")
            return mp3_fixture()

        narrator = self.narrator(synth)
        lines = self.lines[:1]
        self.assertIsNone(narrator.scenes.submit(lines, peek=True)["url"])
        self.assertEqual(calls, [])
        narrator.scenes.submit(lines)
        failed = self.finish(narrator, lines)
        self.assertEqual(failed["status"], "failed")
        self.assertIsNone(failed["url"])
        for _ in range(3):
            self.assertEqual(narrator.scenes.submit(lines)["status"], "failed")
            self.assertEqual(narrator.scenes.submit(lines, peek=True, retry=True)["status"], "failed")
        self.assertEqual(len(calls), 1)
        fail[0] = False
        retried = narrator.scenes.submit(lines, retry=True)
        self.assertEqual(retried["sceneKey"], failed["sceneKey"])
        self.assertEqual(self.finish(narrator, lines)["status"], "ready")
        self.assertEqual(len(calls), 2)

    def test_voice_language_delivery_and_line_order_are_part_of_scene_identity(self):
        narrator = self.narrator()
        first = narrator.scenes.submit(self.lines, peek=True)
        variants = [
            narrator.scenes.submit(self.lines, "aaaaaaaaaaaa", peek=True),
            narrator.scenes.submit(self.lines, language="ko", peek=True),
            narrator.scenes.submit(self.lines, all_roles=True, peek=True),
            narrator.scenes.submit(list(reversed(self.lines)), peek=True),
            narrator.scenes.submit([{**self.lines[0], "emotion": "relieved"}, *self.lines[1:]], peek=True),
        ]
        # Voice folders isolate identities even if the default reference is the same.
        self.assertNotEqual(narrator.scenes.path("default", first["sceneKey"]),
                            narrator.scenes.path("aaaaaaaaaaaa", variants[0]["sceneKey"]))
        for variant in variants:
            self.assertNotEqual(variant["sceneKey"], first["sceneKey"])

    def test_deleted_voice_cannot_be_recreated_by_a_late_scene_join(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        narrator = self.narrator()
        original = narrator.scenes.joiner

        def delayed(paths, clips):
            entered.set()
            release.wait(3)
            try:
                return original(paths, clips)
            finally:
                finished.set()

        narrator.scenes.joiner = delayed
        voice = "aaaaaaaaaaaa"
        result = narrator.scenes.submit(self.lines, voice)
        self.assertTrue(entered.wait(2))
        narrator.forget(voice)
        release.set()
        self.assertTrue(finished.wait(2))
        time.sleep(.03)
        self.assertFalse((narrator.cache / voice).exists())
        self.assertNotIn((voice, result["sceneKey"]), narrator.scenes.jobs)

    def test_invalid_clip_never_publishes_a_partial_scene(self):
        narrator = self.narrator(lambda *_: b"invalid compressed audio")
        narrator.scenes.submit(self.lines)
        result = self.finish(narrator)
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["url"])
        self.assertFalse(narrator.scenes.path("default", result["sceneKey"]).exists())

    def test_explicit_retry_rejoins_a_damaged_ready_wav_without_synthesizing_lines(self):
        calls = []

        def synth(text, settings):
            calls.append(text)
            return mp3_fixture()

        narrator = self.narrator(synth)
        narrator.scenes.submit(self.lines)
        original = self.finish(narrator)
        path = narrator.scenes.path("default", original["sceneKey"])
        path.write_bytes(b"damaged scene file" * 10)       # greater than the old size-only readiness check
        # Ordinary requests must not automatically synthesize or rebuild a failed download.
        self.assertEqual(narrator.scenes.submit(self.lines)["sceneKey"], original["sceneKey"])
        retry = narrator.scenes.submit(self.lines, retry=True)
        self.assertEqual(retry["status"], "pending")
        repaired = self.finish(narrator)
        self.assertEqual(repaired["status"], "ready")
        self.assertEqual(repaired["sceneKey"], original["sceneKey"])
        with wave.open(str(path), "rb") as audio:
            self.assertEqual(audio.getframerate(), RATE)
        self.assertEqual(calls, [line["text"] for line in self.lines])

    def test_explicit_retry_replaces_only_the_cached_mp3_that_failed_decoding(self):
        calls = []

        def synth(text, settings):
            calls.append(text)
            return mp3_fixture()

        narrator = self.narrator(synth)
        clips = narrator.submit(self.lines)
        for clip in clips:
            self.assertEqual(narrator.wait("default", clip["key"], 3), "ready")
        narrator.path("default", clips[1]["key"]).write_bytes(b"damaged MP3 cache")
        narrator.scenes.submit(self.lines)
        failed = self.finish(narrator)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(narrator.scenes.submit(self.lines)["status"], "failed")
        self.assertEqual(len(calls), 3)
        narrator.scenes.submit(self.lines, retry=True)
        repaired = self.finish(narrator)
        self.assertEqual(repaired["status"], "ready")
        self.assertEqual(repaired["sceneKey"], failed["sceneKey"])
        self.assertEqual(calls.count(self.lines[0]["text"]), 1)
        self.assertEqual(calls.count(self.lines[1]["text"]), 2)
        self.assertEqual(calls.count(self.lines[2]["text"]), 1)

    def test_long_edge_silence_is_trimmed_but_internal_pause_is_preserved(self):
        tone = array("h", (int(4000 * math.sin(2 * math.pi * 440 * i / RATE))
                           for i in range(int(RATE * .18)))).tobytes()
        source = self.root / "padded.wav"
        with wave.open(str(source), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(RATE)
            output.writeframes(bytes(int(RATE * .6) * 2) + tone + bytes(int(RATE * .45) * 2)
                               + tone + bytes(int(RATE * .6) * 2))
        raw = subprocess.run([
            "ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(source),
            "-ac", "1", "-ar", str(RATE), "-f", "mp3", "pipe:1",
        ], capture_output=True, check=True).stdout
        path = self.root / "padded.mp3"
        path.write_bytes(raw)
        pcm = decoded_pcm(path)
        self.assertGreater(len(pcm) / (RATE * 2), .85)      # both sounds and internal pause survive
        self.assertLess(len(pcm) / (RATE * 2), 1.15)        # long edge silence is gone
        middle = array("h")
        middle.frombytes(pcm[int(RATE * .38) * 2:int(RATE * .58) * 2])
        self.assertLess(max(abs(sample) for sample in middle), 104)


@unittest.skipUnless(shutil.which("ffmpeg"), "scene audio decoding needs ffmpeg")
class SceneAudioHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.server = Server(("127.0.0.1", 0), Narrator(lambda *_: mp3_fixture(), root / "cache"),
                             VoiceLibrary(root / "profiles", lambda _: "hello"))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.host = f"127.0.0.1:{self.server.server_port}"

    def request(self, method, path, value=None):
        connection = http.client.HTTPConnection(self.host, timeout=5)
        connection.request(method, path, json.dumps(value) if value is not None else None,
                           {"Origin": "http://127.0.0.1:8000", "Content-Type": "application/json"})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_complete_scene_audio_and_segments_are_served_only_after_preparation(self):
        body = {"lines": [{"speakerId": "pig1", "text": "A complete scene."},
                          {"speakerId": "narrator", "text": "What next?"}]}
        status, _, data = self.request("POST", "/api/voice/scene", body)
        self.assertEqual(status, 200)
        result = json.loads(data)
        deadline = time.monotonic() + 5
        while result["status"] == "pending" and time.monotonic() < deadline:
            status, _, data = self.request("GET", f"/audio/default/scene-{result['sceneKey']}.wav")
            self.assertIn(status, (200, 404))
            time.sleep(.02)
            result = json.loads(self.request("POST", "/api/voice/scene", body)[2])
        self.assertEqual(result["status"], "ready")
        status, headers, audio = self.request("GET", result["url"])
        self.assertEqual((status, headers["Content-Type"]), (200, "audio/wav"))
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://127.0.0.1:8000")
        self.assertTrue(audio.startswith(b"RIFF"))
        self.assertEqual(len(result["segments"]), 2)

    def test_scene_limits_and_options_do_not_change_the_existing_line_endpoint(self):
        lines = [{"text": "Same cached sentence."}] * 21
        self.assertEqual(self.request("POST", "/api/voice/lines", {"lines": lines})[0], 400)
        self.assertEqual(self.request("POST", "/api/voice/scene", {"lines": lines, "peek": True})[0], 200)
        self.assertEqual(self.request("POST", "/api/voice/scene", {"lines": lines * 4})[0], 400)
        self.assertEqual(self.request("POST", "/api/voice/scene", {"lines": lines, "retry": "yes"})[0], 400)
        self.assertEqual(self.request("POST", "/api/voice/scene", {"lines": lines, "peek": "true"})[0], 400)

    def test_scene_caching_does_not_change_private_recording_cache_policy(self):
        for path, expected in (("/audio/default/scene-0123456789abcdef.wav", "max-age=86400"),
                               ("/api/voices/aaaaaaaaaaaa/full.wav", "no-store"),
                               ("/api/voices/aaaaaaaaaaaa/train/1.wav", "no-store")):
            handler = Handler.__new__(Handler)
            handler.path, handler.headers, handler.wfile = path, {}, io.BytesIO()
            headers = {}
            handler.send_response = lambda status: None
            handler.send_header = lambda key, value: headers.update({key: value})
            handler.end_headers = lambda: None
            handler.reply(200, b"private or scene audio", "audio/wav")
            self.assertEqual(headers["Cache-Control"], expected)


if __name__ == "__main__":
    unittest.main()
