"""Script performance reaches real controls and checked audio datasets, without model calls."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import numpy as np

from narration.finetune import dataset_from_voice, training_scope
from narration.practice import current_performance, training_catalog, training_sample
from narration.server import Narrator, Server, chatterbox_synthesizer
from narration.voices import SR, VoiceError, VoiceLibrary, write_wav


class VoiceDirectionTests(unittest.TestCase):
    def test_delivery_controls_reach_chatterbox_and_tempo_filter(self):
        prepared, generated, encoded = [], [], []

        class Engine:
            sr = 24000
            conds = None

            def prepare_conditionals(self, path, exaggeration):
                prepared.append((path, exaggeration))
                self.conds = (path, exaggeration)

            def generate(self, text, **kwargs):
                generated.append((text, kwargs))
                return b"wav"

        engine = Engine()
        modules = {
            "torch": SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
                                      cuda=SimpleNamespace(is_available=lambda: False)),
            "torchaudio": SimpleNamespace(save=lambda *args: None),
            "chatterbox.tts": SimpleNamespace(ChatterboxTTS=SimpleNamespace(from_pretrained=lambda device: engine)),
        }

        def ffmpeg(arguments, **kwargs):
            encoded.append(arguments)
            Path(arguments[-1]).write_bytes(b"mp3")

        with tempfile.TemporaryDirectory() as tmp, patch.dict("sys.modules", modules), patch("narration.server.subprocess.run", side_effect=ffmpeg):
            narrator = Narrator(lambda *args: b"unused", tmp)
            exciting = narrator.line_settings({"speakerId": "pig1", "text": "Hello!", "tone": "lively", "emotion": "excited"})
            worried = narrator.line_settings({"speakerId": "pig1", "text": "Hello!", "tone": "gentle", "emotion": "worried"})
            synthesize = chatterbox_synthesizer()
            for settings in (exciting, worried, exciting):
                self.assertEqual(synthesize("Only the spoken words!", settings), b"mp3")
            self.assertEqual(len(prepared), 2)
            self.assertEqual([entry[1]["exaggeration"] for entry in generated],
                             [exciting["exaggeration"], worried["exaggeration"], exciting["exaggeration"]])
            self.assertEqual(generated[0][1]["cfg_weight"], exciting["cfg_weight"])
            self.assertIn(f"atempo={exciting['tempo']}", encoded[0])
            self.assertEqual([entry[0] for entry in generated], ["Only the spoken words!"] * 3)

    def test_character_and_emotion_change_real_settings_and_audio_cache(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            narrator = Narrator(lambda text, settings: calls.append(settings) or b"audio", tmp)
            lines = [
                {"speakerId": "pig1", "text": "Let's build together!", "tone": "lively", "emotion": "excited"},
                {"speakerId": "pig2", "text": "Let's build together!", "tone": "lively", "emotion": "excited"},
                {"speakerId": "pig1", "text": "Let's build together!", "tone": "gentle", "emotion": "worried"},
            ]
            clips = narrator.submit(lines)
            self.assertEqual(len({clip["key"] for clip in clips}), 3)
            for clip in clips:
                self.assertEqual(narrator.wait("default", clip["key"], 3), "ready")
            self.assertEqual([call["performance"]["speakerId"] for call in calls], ["pig1", "pig2", "pig1"])
            self.assertNotEqual(calls[0]["tempo"], calls[1]["tempo"])
            self.assertNotEqual(calls[0]["exaggeration"], calls[2]["exaggeration"])
            self.assertEqual(calls[0]["exaggeration"], clips[0]["performance"]["exaggeration"])
            self.assertTrue(all("personality" in call["performance"] for call in calls))

    def test_scoped_adapter_only_affects_matching_character_and_emotion(self):
        with tempfile.TemporaryDirectory() as tmp:
            narrator = Narrator(lambda text, settings: b"audio", tmp)
            lines = [{"speakerId": sid, "text": "Hello!", "tone": "warm", "emotion": mood}
                     for sid, mood in (("narrator", "happy"), ("pig1", "happy"), ("narrator", "worried"), ("wolf", "happy"))]
            plain = narrator.submit(lines, "abcdef123456", "/dad.wav", all_roles=True)
            tuned = narrator.submit(lines, "abcdef123456", "/dad.wav", all_roles=True, t3="/t3.safetensors#1",
                                    t3_scope={"language": "en", "speakerId": "narrator", "emotion": "happy"})
            self.assertNotEqual(plain[0]["key"], tuned[0]["key"])
            self.assertEqual([c["key"] for c in plain[1:]], [c["key"] for c in tuned[1:]])
            for clip in plain + tuned:
                self.assertEqual(narrator.wait("abcdef123456", clip["key"], 3), "ready")


class ScriptRecordingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.voice_id = "abcdef123456"
        profile = self.root / "profiles" / self.voice_id
        profile.mkdir(parents=True)
        (profile / "meta.json").write_text(json.dumps({"status": "saved", "consent": {"attested": True}}))
        self.sample = next(s for s in training_catalog("en")["samples"] if s["speakerId"] == "narrator")
        self.library = VoiceLibrary(self.root / "profiles", lambda wav: self.sample["text"])
        self.wav = self.root / "sample.wav"
        write_wav(self.wav, np.sin(2 * np.pi * 220 * np.arange(SR * 2) / SR) * .2)

    def record(self, sample=None):
        sample = sample or self.sample
        self.library.transcribe = lambda wav: sample["text"]
        return self.library.add_training_clip(self.voice_id, sample["n"], sample["text"], self.wav.read_bytes(), performance=sample)

    def export(self, **kwargs):
        with patch("narration.finetune.PROFILES", self.root / "profiles"), patch("narration.finetune.DATA", self.root / "datasets"):
            return dataset_from_voice(self.voice_id, **kwargs)

    def test_recordings_need_current_revision_transcript_and_listening_review(self):
        clip = self.record()
        self.assertEqual(clip["performanceReview"], "unreviewed")
        self.assertEqual(clip["desiredPerformance"]["scriptLineId"], self.sample["id"])
        self.assertIsNotNone(current_performance(clip))
        with self.assertRaises(ValueError):
            self.export(performance_only=True)
        self.library.update_training_clip(self.voice_id, clip["n"], performance_reviewed=True)
        out = self.export(performance_only=True)
        row = json.loads((out / "performance.jsonl").read_text().strip())
        self.assertEqual(row["desiredPerformance"]["emotion"], self.sample["emotion"])
        self.assertTrue((out / row["audio"]).is_file())
        self.assertEqual((out / "metadata.csv").read_text().split("|")[1], self.sample["text"])
        self.assertEqual(training_scope(out)["speakerId"], "narrator")
        self.assertEqual(training_scope(out)["emotion"], None)
        with self.assertRaises(ValueError):
            training_scope(out, speaker="pig1")
        with self.assertRaises(ValueError):
            training_scope(out, language="ko")
        self.library.update_training_clip(self.voice_id, clip["n"], text="Different words.")
        with self.assertRaises(VoiceError):
            self.library.update_training_clip(self.voice_id, clip["n"], performance_reviewed=True)
        with self.assertRaises(ValueError):
            self.export(performance_only=True)

    def test_language_character_and_stale_revision_never_mix(self):
        pig = next(s for s in training_catalog("en")["samples"] if s["speakerId"] == "pig1")
        self.record(pig)
        self.library.update_training_clip(self.voice_id, pig["n"], performance_reviewed=True)
        with self.assertRaises(ValueError):
            self.export(performance_only=True)               # narrator default is not a wildcard
        with self.assertRaises(ValueError):
            self.export(language="ko", speaker="pig1", performance_only=True)
        out = self.export(speaker="pig1", emotion=pig["emotion"], performance_only=True)
        self.assertEqual(training_scope(out), {"language": "en", "speakerId": "pig1", "emotion": pig["emotion"]})
        with self.assertRaises(VoiceError):
            training_sample(pig["id"], "old-revision")
        clips_path = self.root / "profiles" / self.voice_id / "train" / "clips.json"
        clips = json.loads(clips_path.read_text())
        clips[str(pig["n"])]["desiredPerformance"]["revision"] = "old-revision"
        clips_path.write_text(json.dumps(clips))
        with self.assertRaises(ValueError):
            self.export(speaker="pig1", performance_only=True)

    def test_empty_profile_has_actionable_export_error_and_no_dataset(self):
        with self.assertRaisesRegex(ValueError, "Record the story roles"):
            self.export(performance_only=True)
        self.assertFalse((self.root / "datasets").exists())

    def test_deleting_voice_removes_scoped_datasets_and_preserves_other_voices(self):
        names = [self.voice_id, self.voice_id + "-en-pig1-happy", "111111111111-en-pig1-happy"]
        for name in names:
            dataset = self.root / "finetune-data" / name
            dataset.mkdir(parents=True)
            (dataset / "performance.jsonl").write_text("private labels")
            run = self.root / "finetune-runs" / name
            run.mkdir(parents=True)
            (run / "train.json").write_text(json.dumps({"data": str(dataset)}))
        self.library.delete(self.voice_id)
        for name in names[:2]:
            self.assertFalse((self.root / "finetune-data" / name).exists())
            self.assertFalse((self.root / "finetune-runs" / name).exists())
        self.assertTrue((self.root / "finetune-data" / names[2]).exists())
        self.assertTrue((self.root / "finetune-runs" / names[2]).exists())

    def test_catalog_and_upload_api_resolve_server_owned_performance(self):
        server = Server(("127.0.0.1", 0), Narrator(lambda *args: b"audio", self.root / "cache"), self.library)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def request(method, path, body=None):
            conn = http.client.HTTPConnection("127.0.0.1", server.server_port)
            conn.request(method, path, body=body, headers={"Content-Type": "audio/wav"})
            response = conn.getresponse()
            result = response.status, json.loads(response.read())
            conn.close()
            return result

        status, catalog = request("GET", "/api/voice/training-script?language=en")
        self.assertEqual(status, 200)
        self.assertTrue(all(s["recordingPrompt"] and s["personality"] for s in catalog["samples"]))
        sample = self.sample
        query = f"?scriptLineId={sample['id']}&revision={sample['revision']}"
        status, clip = request("POST", f"/api/voices/{self.voice_id}/train/{sample['n']}" + query, self.wav.read_bytes())
        self.assertEqual(status, 200)
        self.assertEqual(clip["desiredPerformance"]["speakerId"], sample["speakerId"])
        self.assertEqual(clip["performanceReview"], "unreviewed")
        status, error = request("POST", f"/api/voices/{self.voice_id}/train/{sample['n']}?scriptLineId={sample['id']}&revision=old", self.wav.read_bytes())
        self.assertEqual((status, error["error"]["code"]), (409, "script_changed"))


if __name__ == "__main__":
    unittest.main()
