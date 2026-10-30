"""Narration server queue, cache, voice registration and HTTP checks with fakes (no Chatterbox or Meta API)."""
import http.client
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from narration.server import CASTING, Narrator, Server, chatterbox_synthesizer, lazy_synthesizer
from narration.voices import SR, VoiceError, VoiceLibrary, clip_quality, consent_heard, suggest_clips, write_wav


class SpokenConsentTest(unittest.TestCase):
    def test_model_loading_does_not_block_registration_server_startup(self):
        calls = []

        def factory():
            calls.append('load')
            return lambda text, settings: text.encode()

        synthesize = lazy_synthesizer(factory)
        self.assertEqual(calls, [])
        self.assertEqual(synthesize('first', {}), b'first')
        self.assertEqual(synthesize('second', {}), b'second')
        self.assertEqual(calls, ['load'])

    def test_consent_in_each_recording_language(self):
        for transcript in (
            "I'm happy for my voice to read stories to my child.",
            "푸른 하늘을 꿈꾸었답니다. 제 목소리로 아이에게 동화를 읽어 주는 것에 동의합니다.",
            "제목소리로 아이에게 동화를 읽어주는 것에 동의합니다!",
        ):
            with self.subTest(transcript=transcript):
                self.assertTrue(consent_heard(transcript))
        for transcript in (None, "", "잠꾸러기 곰 보가 살았어요.",
                           "제 목소리로 아이에게 동화를 읽어 주는 것에 동의하지 않습니다."):
            with self.subTest(transcript=transcript):
                self.assertFalse(consent_heard(transcript))


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


class SynthesizerLoadingTest(unittest.TestCase):
    def test_korean_preview_does_not_load_english_weights(self):
        loaded, saved_rates = [], []

        class Engine:
            def __init__(self, language, sr):
                self.language, self.sr, self.conds = language, sr, None

            def prepare_conditionals(self, path, exaggeration):
                self.conds = path

            def generate(self, text, **settings):
                return b"wav"

        def load(language, sr):
            loaded.append(language)
            return Engine(language, sr)

        fake_torch = SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
                                     cuda=SimpleNamespace(is_available=lambda: False))
        modules = {
            "torch": fake_torch,
            "torchaudio": SimpleNamespace(save=lambda path, wav, sr: saved_rates.append(sr)),
            "chatterbox.tts": SimpleNamespace(ChatterboxTTS=SimpleNamespace(from_pretrained=lambda device: load("en", 24000))),
            "chatterbox.mtl_tts": SimpleNamespace(ChatterboxMultilingualTTS=SimpleNamespace(from_pretrained=lambda device: load("ko", 22050))),
        }
        with patch.dict('sys.modules', modules), patch('narration.server.subprocess.run',
                side_effect=lambda arguments, **kwargs: Path(arguments[-1]).write_bytes(b"mp3")):
            synthesize = chatterbox_synthesizer()
            self.assertEqual(loaded, [], "Constructing the synthesizer must not preload English")
            settings = {**CASTING["narrator"], "language": "ko"}
            self.assertEqual(synthesize("한국어 문장", settings), b"mp3")
            self.assertEqual(loaded, ["ko"])
            self.assertEqual(saved_rates, [22050])
            self.assertEqual(synthesize("Another Korean line", settings), b"mp3")
            self.assertEqual(loaded, ["ko"])
            self.assertEqual(synthesize("English line", CASTING["narrator"]), b"mp3")
            self.assertEqual(loaded, ["ko", "en"])
            self.assertEqual(saved_rates, [22050, 22050, 24000])


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

    def test_fine_tuned_t3_only_reads_the_parent_roles_in_english(self):
        n = Narrator(FakeVoice(), self.tmp.name)
        lines = [{"speakerId": "narrator", "text": "Hi."}, {"speakerId": "wolf", "text": "Hi."}]
        plain = n.submit(lines, "abcdef123456", "/profiles/dad.wav")
        tuned = n.submit(lines, "abcdef123456", "/profiles/dad.wav", t3="/profiles/t3.safetensors#1")
        korean = n.submit(lines, "abcdef123456", "/profiles/dad.wav", language="ko", t3="/profiles/t3.safetensors#1")
        self.assertNotEqual(plain[0]["key"], tuned[0]["key"])      # narrator: new key with the fine-tune
        self.assertEqual(plain[1]["key"], tuned[1]["key"])         # wolf: stock voice, unchanged
        korean_plain = n.submit(lines, "abcdef123456", "/profiles/dad.wav", language="ko")
        self.assertEqual(korean[0]["key"], korean_plain[0]["key"])  # Korean is not fine-tuned
        for clip in plain + tuned + korean:          # let every queued line finish before the folder is removed
            self.assertEqual(n.wait("abcdef123456", clip["key"], 5), "ready")
        self.assertIn(b"/profiles/dad.wav", n.path("abcdef123456", tuned[0]["key"]).read_bytes())

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

    def test_warmup_requested_after_a_passage_does_not_delay_its_lines(self):
        entered, release = threading.Event(), threading.Event()
        order = []

        def synthesize(text, settings):
            if text == "already running":
                entered.set()
                release.wait(2)
            order.append(text)
            return b"ID3" + text.encode()

        n = Narrator(synthesize, self.tmp.name)
        n.submit([{"text": "already running"}])
        self.assertTrue(entered.wait(1))
        passage = n.submit([{"text": "read now 1"}, {"text": "read now 2"}])
        warmup = n.submit([{"text": "prepare later 1"}, {"text": "prepare later 2"}], priority="background")
        release.set()
        for clip in passage + warmup:
            self.assertEqual(n.wait("default", clip["key"], 2), "ready")
        self.assertLess(order.index("read now 2"), order.index("prepare later 1"), order)

    def test_repeated_requests_reuse_the_in_flight_clip(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def synthesize(text, settings):
            entered.set()
            release.wait(2)
            calls.append(text)
            return b"ID3" + text.encode()

        n = Narrator(synthesize, self.tmp.name)
        [clip] = n.submit([{"text": "same line"}])
        self.assertTrue(entered.wait(1))
        for _ in range(20):
            n.submit([{"text": "same line"}])
            n.submit([{"text": "same line"}], priority="background")
        with n.cond:
            self.assertEqual(len(n.queue), 0, 'An in-flight clip must not gain queued duplicates')
        release.set()
        self.assertEqual(n.wait("default", clip["key"], 2), "ready")
        self.assertEqual(calls, ["same line"])

    def test_passage_promotes_pending_warmup_and_repeated_warmup_cannot_demote_it(self):
        entered, release = threading.Event(), threading.Event()
        order = []

        def synthesize(text, settings):
            if text == "already running":
                entered.set()
                release.wait(2)
            order.append(text)
            return b"ID3" + text.encode()

        n = Narrator(synthesize, self.tmp.name)
        n.submit([{"text": "already running"}])
        self.assertTrue(entered.wait(1))
        [target] = n.submit([{"text": "next passage"}], priority="background")
        [other] = n.submit([{"text": "another warmup"}], priority="background")
        n.submit([{"text": "next passage"}])
        for _ in range(20):
            n.submit([{"text": "next passage"}], priority="background")
        with n.cond:
            self.assertEqual(len(n.queue), 2)
        release.set()
        for clip in (target, other):
            self.assertEqual(n.wait("default", clip["key"], 2), "ready")
        self.assertEqual(order, ["already running", "next passage", "another warmup"])

    def test_deleted_in_flight_job_cannot_replace_a_new_request_for_the_same_voice(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def synthesize(text, settings):
            calls.append(text)
            if len(calls) == 1:
                entered.set()
                release.wait(2)
                return b"old audio"
            return b"replacement audio"

        n = Narrator(synthesize, self.tmp.name)
        [clip] = n.submit([{"text": "same line"}], "aaaaaaaaaaaa", "/ref.wav")
        self.assertTrue(entered.wait(1))
        n.forget("aaaaaaaaaaaa")
        n.submit([{"text": "same line"}], "aaaaaaaaaaaa", "/ref.wav")
        release.set()
        self.assertEqual(n.wait("aaaaaaaaaaaa", clip["key"], 2), "ready")
        self.assertEqual(n.path("aaaaaaaaaaaa", clip["key"]).read_bytes(), b"replacement audio")

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
    def test_warm_script_marks_generation_as_background(self):
        from narration.warm import lines_for
        with patch('narration.warm.call', return_value={"clips": []}) as call:
            lines_for("default", ["warm this line"])
        self.assertEqual(call.call_args.args[1]["priority"], "background")

    def test_warm_script_uses_the_same_fillers_as_the_page(self):
        import re
        from narration.warm import FILLERS
        page = (Path(__file__).resolve().parent.parent / "prototype" / "narration.js").read_text(encoding="utf-8")
        from narration.warm import FILLERS_KO
        for name, expected in (("FILLERS", FILLERS), ("FILLERS_KO", FILLERS_KO)):
            block = re.search(rf"const {name} = \[(.*?)\];", page, re.S).group(1)
            self.assertEqual(re.findall(r'"([^"]+)"', block), expected)

    def test_warm_script_voices_the_choice_prompt_the_live_page_reads(self):
        from narration.warm import CHOICE_PROMPT
        page = (Path(__file__).resolve().parent.parent / "prototype" / "live-book.js").read_text(encoding="utf-8")
        self.assertIn(f't("{CHOICE_PROMPT["en"]}", "{CHOICE_PROMPT["ko"]}")', page)


class FinetuneDatasetTest(unittest.TestCase):
    def test_dataset_uses_corrected_text_and_skips_excluded_and_misread_clips(self):
        import narration.finetune as ft
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            train = root / "profiles" / "abcdef123456" / "train"
            train.mkdir(parents=True)
            clips = {
                "1": {"n": 1, "file": "001.wav", "text": "Read well.", "seconds": 2.0, "match": 0.95},
                "2": {"n": 2, "file": "002.wav", "text": "Misread.", "seconds": 2.0, "match": 0.4},
                "1001": {"n": 1001, "file": "m1001.wav", "text": "Fixed words.", "seconds": 3.0, "match": None, "edited": True},
                "1002": {"n": 1002, "file": "m1002.wav", "text": "Left out.", "seconds": 3.0, "match": None, "excluded": True},
            }
            for c in clips.values():
                (train / c["file"]).write_bytes(b"RIFF")
            (train / "clips.json").write_text(json.dumps(clips))
            ft.PROFILES, ft.DATA = root / "profiles", root / "data"
            out = ft.dataset_from_voice("abcdef123456")
            self.assertEqual((out / "metadata.csv").read_text().splitlines(),
                             ["s0001|Read well.|Read well.", "s1001|Fixed words.|Fixed words."])
            self.assertEqual(sorted(p.name for p in (out / "wavs").iterdir()), ["s0001.wav", "s1001.wav"])


class ClipAnalysisTest(unittest.TestCase):
    def test_suggests_the_part_with_the_most_talking(self):
        audio = speech_like([(0, 4), (1, 1), (0, 6), (1, 12), (0, 4)])
        [first, *rest] = suggest_clips(audio, SR)
        self.assertAlmostEqual(first["start"], 11, delta=0.3)
        self.assertAlmostEqual(first["end"] - first["start"], 10, delta=0.1)
        self.assertGreater(first["speech"], 0.95)

    def test_split_utterances_cuts_at_pauses_and_caps_length(self):
        from narration.voices import split_utterances
        audio = speech_like([(0, 1), (1, 3), (0, 0.6), (1, 2), (0, 0.2), (1, 1), (0, 1), (1, 0.8), (0, 1), (1, 30), (0, 1)])
        spans = split_utterances(audio, SR)
        lengths = [round(b - a) for a, b in spans]
        self.assertEqual(len(spans), 5)            # 3 s | 2 s + 1 s joined over a short gap | (0.8 s dropped) | 30 s cut in 12+12+6
        self.assertTrue(all(b - a <= 12.4 for a, b in spans))
        self.assertAlmostEqual(spans[0][0], 0.85, delta=0.1)

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

    def test_voice_sample_from_practice_sentences_in_the_usual_voice_and_back(self):
        draft = self.library.create((self.root / "talk.wav").read_bytes(), "audio/wav")
        self.library.choose(draft["id"], 2, 12)
        folder = self.root / "profiles" / draft["id"]
        first = (folder / "ref.wav").read_bytes()
        with self.assertRaises(VoiceError):                 # nothing read yet
            self.library.sample_from_practice(draft["id"])

        def sentence(hz, wobble, seconds=3):                # a voiced "sentence": a tone whose pitch moves +-wobble
            t = np.arange(int(seconds * SR)) / SR
            phase = 2 * np.pi * np.cumsum(hz * 2 ** (wobble / 12 * np.sin(2 * np.pi * 0.7 * t))) / SR
            return np.concatenate([np.zeros(SR // 4), 0.3 * np.sin(phase), np.zeros(SR // 4)]).astype(np.float32)
        (folder / "train").mkdir()
        readings = {1: (120, 2), 2: (124, 2), 3: (118, 2), 4: (122, 2), 5: (200, 2), 6: (120, 9), 7: (120, 2)}
        clips = {}
        for n, (hz, wobble) in readings.items():
            write_wav(folder / "train" / f"{n:03d}.wav", sentence(hz, wobble))
            clips[str(n)] = {"n": n, "file": f"{n:03d}.wav", "source": "read", "text": "x", "seconds": 3.5,
                             "match": 0.5 if n == 7 else 1.0}        # 7 was misread
        (folder / "train" / "clips.json").write_text(json.dumps(clips))

        sample = self.library.sample_from_practice(draft["id"])
        self.assertEqual(len(sample["sentences"]), 3)              # three 3 s sentences fill the 10 s sample
        self.assertLessEqual(set(sample["sentences"]), {1, 2, 3, 4})  # not the high one, the lively one or the misread one
        self.assertEqual(self.library.training_status(draft["id"])["sample"], sample)
        self.assertNotEqual((folder / "ref.wav").read_bytes(), first)
        self.assertEqual((folder / "ref_original.wav").read_bytes(), first)
        self.library.sample_from_practice(draft["id"])              # again: the first clip is still the one kept
        self.assertEqual((folder / "ref_original.wav").read_bytes(), first)
        self.library.restore_sample(draft["id"])
        self.assertEqual((folder / "ref.wav").read_bytes(), first)
        self.assertFalse((folder / "ref_original.wav").exists())
        self.assertIsNone(self.library.training_status(draft["id"])["sample"])

    def test_recorded_consent_sentence_is_heard(self):
        library = VoiceLibrary(self.root / "p2", lambda wav: "and dreamed of honey. I'm happy for my voice to read stories to my child.")
        draft = library.create((self.root / "talk.wav").read_bytes(), "audio/webm", check_consent=True)
        self.assertTrue(draft["consentHeard"])
        library.choose(draft["id"], 2, 12)
        self.assertTrue(library.save(draft["id"], "Dad", "me", True)["consent"]["spoken"])
        quiet = VoiceLibrary(self.root / "p3", lambda wav: "once upon a time")
        self.assertFalse(quiet.create((self.root / "talk.wav").read_bytes(), "audio/webm", check_consent=True)["consentHeard"])
        self.assertNotIn("consentHeard", quiet.create((self.root / "talk.wav").read_bytes(), "video/mp4"))

    def test_deleting_a_voice_also_deletes_what_was_trained_from_it(self):
        draft = self.library.create((self.root / "talk.wav").read_bytes(), "audio/wav")
        vid = draft["id"]
        data = self.root / "finetune-data" / vid
        (data / "wavs").mkdir(parents=True)
        mine, other = self.root / "finetune-runs" / "dad-run", self.root / "finetune-runs" / "someone-else"
        for run, source in ((mine, data), (other, self.root / "finetune-data" / "aaaaaaaaaaaa")):
            run.mkdir(parents=True)
            (run / "train.json").write_text(json.dumps({"data": str(source)}))
        self.library.delete(vid)
        self.assertFalse((self.root / "profiles" / vid).exists())
        self.assertFalse(data.exists())
        self.assertFalse(mine.exists())
        self.assertTrue(other.exists())

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

    def test_http_background_warmup_cannot_overtake_an_interactive_passage(self):
        entered, release = threading.Event(), threading.Event()
        order = []

        def synthesize(text, settings):
            if text == "occupied":
                entered.set()
                release.wait(2)
            order.append(text)
            return b"ID3" + text.encode()

        self.server.narrator = Narrator(synthesize, self.server.narrator.cache)
        self.request("POST", "/api/voice/lines", {"lines": [{"text": "occupied"}]})
        self.assertTrue(entered.wait(1))
        try:
            status, _, body = self.request("POST", "/api/voice/lines", {"lines": [{"text": "read now"}]})
            self.assertEqual(status, 200)
            now = json.loads(body)["clips"][0]
            status, _, body = self.request("POST", "/api/voice/lines",
                {"lines": [{"text": "warm later"}], "priority": "background"})
            self.assertEqual(status, 200)
            later = json.loads(body)["clips"][0]
        finally:
            release.set()
        for clip in (now, later):
            self.assertEqual(self.request("GET", clip["url"] + "?wait=2")[0], 200)
        self.assertEqual(order, ["occupied", "read now", "warm later"])
        status, _, body = self.request("POST", "/api/voice/lines",
            {"lines": [{"text": "wrong priority"}], "priority": "unknown"})
        self.assertEqual((status, json.loads(body)["error"]["code"]), (400, "invalid_priority"))

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
        # No fine-tune yet: it cannot be switched on. With a merged file, switching it on changes the English keys.
        self.assertEqual(self.request("POST", f"/api/voices/{vid}/finetune", {"enabled": True})[0], 409)
        self.request("POST", f"/api/voices/{vid}/clip", {"start": 1, "end": 11})
        self.request("POST", f"/api/voices/{vid}/save", {"name": "Dad", "relation": "me", "attested": True})
        before = json.loads(self.request("POST", "/api/voice/lines", {"lines": [{"text": "Hi"}], "voiceId": vid, "peek": True})[2])
        folder = self.server.library.folder(vid)
        (folder / "t3_finetuned.safetensors").write_bytes(b"weights")
        meta = json.loads((folder / "meta.json").read_text())
        meta["finetune"] = {"run": "test", "file": "t3_finetuned.safetensors", "enabled": False}
        (folder / "meta.json").write_text(json.dumps(meta))
        status, _, body = self.request("POST", f"/api/voices/{vid}/finetune", {"enabled": True})
        self.assertEqual((status, json.loads(body)["enabled"]), (200, True))
        after = json.loads(self.request("POST", "/api/voice/lines", {"lines": [{"text": "Hi"}], "voiceId": vid, "peek": True})[2])
        self.assertNotEqual(before["clips"][0]["key"], after["clips"][0]["key"])
        self.assertTrue(json.loads(self.request("GET", "/api/voices")[2])["voices"][0]["finetune"]["enabled"])
        self.assertEqual(self.request("DELETE", f"/api/voices/{vid}")[0], 200)
        self.assertFalse(folder.exists())

    @unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
    def test_home_video_becomes_transcribed_training_clips(self):
        status, _, body = self.request("POST", "/api/voices", raw=self.wav.read_bytes(), headers={"Content-Type": "audio/wav"})
        vid = json.loads(body)["id"]
        long = Path(self.wav).with_name("home.wav")
        write_wav(long, speech_like([(0, 1), (1, 4), (0, 1), (1, 5), (0, 1)]))
        status, _, body = self.request("POST", f"/api/voices/{vid}/train", raw=long.read_bytes(), headers={"Content-Type": "audio/wav"})
        result = json.loads(body)
        self.assertEqual((status, result["added"]), (200, 2))
        self.assertEqual({c["source"] for c in result["clips"]}, {"media"})
        self.assertEqual([c["text"] for c in result["clips"]], ["hello", "hello"])   # the transcript is the text
        progress = json.loads(self.request("GET", f"/api/voices/{vid}/train")[2])
        self.assertEqual([c["n"] for c in progress["clips"]], [1001, 1002])
        # The parent listens, corrects a mistranscribed clip and leaves another one out.
        status, headers, audio = self.request("GET", f"/api/voices/{vid}/train/1001.wav")
        self.assertEqual((status, headers["Content-Type"], audio[:4]), (200, "audio/wav", b"RIFF"))
        fixed = json.loads(self.request("POST", f"/api/voices/{vid}/train/1001", {"text": "Once upon a time."})[2])
        self.assertEqual((fixed["text"], fixed["edited"]), ("Once upon a time.", True))
        self.assertTrue(json.loads(self.request("POST", f"/api/voices/{vid}/train/1002", {"excluded": True})[2])["excluded"])
        self.assertEqual(self.request("POST", f"/api/voices/{vid}/train/1003", {"excluded": True})[0], 404)
        self.assertEqual(self.request("POST", f"/api/voices/{vid}/train/1001", {"text": ""})[0], 400)

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
