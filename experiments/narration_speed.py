"""How long does one narration line take, and what makes it faster without hurting it?

    voice/.venv-chatterbox/bin/python experiments/narration_speed.py

For English (Chatterbox) and Korean (Chatterbox Multilingual), the same three picture-book lines are made with:
  A  the reference clip passed on every line (how narration/server.py worked until now)
  B  the reference prepared once and reused (prepare_conditionals is the same for every line of a voice)
  C  B with T3 in float16 (Korean only, MPS)
Each clip is transcribed back with Muse Voice Transcribe; the match shows whether speed cost quality.
Prints seconds per line and match per method.
"""
import sys
import tempfile
import time
from pathlib import Path

import torch
import torchaudio as ta

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from narration.server import load_api_key, muse_transcriber  # noqa: E402
from narration.voices import text_error  # noqa: E402

REF = str(ROOT / "voice" / "ref_clip.wav")
LINES = {
    "en": ["The oldest pig found a sunny meadow.", "Then along came a hungry wolf.", "The pigs danced in front of their brick house."],
    "ko": ["첫째 돼지는 햇살이 따뜻한 풀밭을 찾았어요.", "그때 배고픈 늑대가 나타났어요.", "돼지들은 벽돌집 앞에서 춤을 추었어요."],
}
device = "mps" if torch.backends.mps.is_available() else "cpu"
transcribe = muse_transcriber(load_api_key())


def heard(wav, sr):
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        ta.save(tmp.name, torch.as_tensor(wav).reshape(1, -1), sr)
        import subprocess
        with tempfile.NamedTemporaryFile(suffix=".wav") as t16:
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", tmp.name, "-ar", "16000", "-ac", "1", t16.name], check=True)
            return transcribe(Path(t16.name).read_bytes())


def run(name, make, lines, sr, lang_label):
    times, matches = [], []
    for i, text in enumerate(lines):
        torch.manual_seed(i)
        if device == "mps":
            torch.mps.synchronize()
        t = time.time()
        wav = make(text)
        if device == "mps":
            torch.mps.synchronize()
        times.append(time.time() - t)
        matches.append(1 - text_error(text, heard(wav.squeeze(0).cpu().numpy(), sr)))
    print(f"{lang_label} {name}: {sum(times) / len(times):.2f} s/line  (first {times[0]:.2f})  match {sum(matches) / len(matches):.2f}", flush=True)


from chatterbox.tts import ChatterboxTTS  # noqa: E402
en = ChatterboxTTS.from_pretrained(device=device)
run("A per-line reference", lambda s: en.generate(s, audio_prompt_path=REF, exaggeration=0.5, cfg_weight=0.5), LINES["en"], en.sr, "en")
t = time.time(); en.prepare_conditionals(REF, exaggeration=0.5); print(f"en prepare_conditionals once: {time.time() - t:.2f} s", flush=True)
run("B prepared once", lambda s: en.generate(s, exaggeration=0.5, cfg_weight=0.5), LINES["en"], en.sr, "en")
del en

from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # noqa: E402
ko = ChatterboxMultilingualTTS.from_pretrained(device=device)
run("A per-line reference", lambda s: ko.generate(s, language_id="ko", audio_prompt_path=REF, exaggeration=0.5, cfg_weight=0.5), LINES["ko"], ko.sr, "ko")
t = time.time(); ko.prepare_conditionals(REF, exaggeration=0.5); print(f"ko prepare_conditionals once: {time.time() - t:.2f} s", flush=True)
run("B prepared once", lambda s: ko.generate(s, language_id="ko", exaggeration=0.5, cfg_weight=0.5), LINES["ko"], ko.sr, "ko")
try:
    ko.t3.half()
    ko.conds.t3 = ko.conds.t3.to(device=device)
    run("C prepared once + T3 fp16", lambda s: ko.generate(s, language_id="ko", exaggeration=0.5, cfg_weight=0.5), LINES["ko"], ko.sr, "ko")
except Exception as exc:  # float16 may not be supported by every op on MPS
    print(f"ko C failed: {exc!r}"[:300], flush=True)
