"""Same lines as voice_clone_f5.py, read by Qwen3-TTS (Apache-2.0 code) in the parent's voice.

    /opt/homebrew/bin/python3.12 -m venv voice/.venv-qwen && voice/.venv-qwen/bin/pip install qwen-tts soundfile
    voice/.venv-qwen/bin/python experiments/voice_clone_qwen.py
"""
import json
import time
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

ROOT = Path(__file__).resolve().parent.parent
VOICE = ROOT / "voice"
OUT = VOICE / "out" / "qwen3"
OUT.mkdir(parents=True, exist_ok=True)
LINES = (ROOT / "experiments" / "voice_lines.txt").read_text().strip().splitlines()

device = "mps" if torch.backends.mps.is_available() else "cpu"
t = time.time()
model = Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-1.7B-Base", device_map=device,
                                      dtype=torch.bfloat16, attn_implementation="sdpa")
print(f"model loaded in {time.time() - t:.1f}s on {device}", flush=True)
ref_text = (VOICE / "ref_text.txt").read_text().strip()
times = []
for i, line in enumerate(LINES, 1):
    t = time.time()
    wavs, sr = model.generate_voice_clone(text=line, language="English",
                                          ref_audio=str(VOICE / "ref_clip.wav"), ref_text=ref_text)
    sf.write(str(OUT / f"line_{i}.wav"), wavs[0], sr)
    times.append(round(time.time() - t, 1))
    print(f"{times[-1]:5.1f}s  line_{i}: {line}", flush=True)
(OUT / "times.json").write_text(json.dumps(times))
