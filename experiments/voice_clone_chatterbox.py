"""Same lines as voice_clone_f5.py, read by Chatterbox (MIT) in the parent's voice.

    python3 -m venv voice/.venv-chatterbox && voice/.venv-chatterbox/bin/pip install chatterbox-tts
    voice/.venv-chatterbox/bin/python experiments/voice_clone_chatterbox.py
"""
import json
import time
from pathlib import Path

import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS

ROOT = Path(__file__).resolve().parent.parent
VOICE = ROOT / "voice"
OUT = VOICE / "out" / "chatterbox"
OUT.mkdir(parents=True, exist_ok=True)
LINES = (ROOT / "experiments" / "voice_lines.txt").read_text().strip().splitlines()

device = "mps" if torch.backends.mps.is_available() else "cpu"
t = time.time()
model = ChatterboxTTS.from_pretrained(device=device)
print(f"model loaded in {time.time() - t:.1f}s on {device}", flush=True)
times = []
for i, line in enumerate(LINES, 1):
    t = time.time()
    wav = model.generate(line, audio_prompt_path=str(VOICE / "ref_clip.wav"), exaggeration=0.6, cfg_weight=0.5)
    ta.save(str(OUT / f"line_{i}.wav"), wav, model.sr)
    times.append(round(time.time() - t, 1))
    print(f"{times[-1]:5.1f}s  line_{i}: {line}", flush=True)
(OUT / "times.json").write_text(json.dumps(times))
