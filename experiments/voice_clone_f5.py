"""Read story lines in a parent's voice with F5-TTS (zero-shot voice cloning).

Setup (isolated env, git-ignored):
    python3 -m venv voice/.venv && voice/.venv/bin/pip install f5-tts
Inputs (git-ignored, personal data): voice/ref_clip.wav (5-10 s of the parent) and voice/ref_text.txt (its exact words).
    voice/.venv/bin/python experiments/voice_clone_f5.py
Writes voice/out/f5/line_*.wav and times.json.
"""
import json
import time
from pathlib import Path

from f5_tts.api import F5TTS

ROOT = Path(__file__).resolve().parent.parent
VOICE = ROOT / "voice"
OUT = VOICE / "out" / "f5"
OUT.mkdir(parents=True, exist_ok=True)

LINES = (ROOT / "experiments" / "voice_lines.txt").read_text().strip().splitlines()

t = time.time()
tts = F5TTS()
print(f"model loaded in {time.time() - t:.1f}s (device: {tts.device})", flush=True)
ref_text = (VOICE / "ref_text.txt").read_text().strip()
times = []
for i, line in enumerate(LINES, 1):
    t = time.time()
    tts.infer(ref_file=str(VOICE / "ref_clip.wav"), ref_text=ref_text, gen_text=line,
              file_wave=str(OUT / f"line_{i}.wav"), remove_silence=True)
    times.append(round(time.time() - t, 1))
    print(f"{times[-1]:5.1f}s  line_{i}: {line}", flush=True)
(OUT / "times.json").write_text(json.dumps(times))
