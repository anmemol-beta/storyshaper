"""Voice every story line in the parent's cloned voice with Chatterbox.

    node experiments/narration_lines.mjs                                  # list lines
    voice/.venv-chatterbox/bin/python experiments/generate_narration.py    # make clips
Reads prototype/audio/lines.json and writes prototype/audio/<hash>.mp3. Existing clips are skipped,
so after editing the story only new or changed lines are generated.
"""
import json
import subprocess
import tempfile
import time
from pathlib import Path

import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "prototype" / "audio"
REF = ROOT / "voice" / "ref_clip.wav"

lines = json.loads((AUDIO / "lines.json").read_text())
todo = [l for l in lines if not (AUDIO / l["file"]).exists()]
print(f"{len(lines)} lines, {len(todo)} to generate", flush=True)
if not todo:
    raise SystemExit

device = "mps" if torch.backends.mps.is_available() else "cpu"
model = ChatterboxTTS.from_pretrained(device=device)

for i, line in enumerate(todo, 1):
    t = time.time()
    # A little more expression on exclamations ("WHOOOO!", "The End!"), calmer for plain narration.
    exaggeration = 0.7 if "!" in line["text"] else 0.5
    wav = model.generate(line["text"], audio_prompt_path=str(REF), exaggeration=exaggeration, cfg_weight=0.5)
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        ta.save(tmp.name, wav, model.sr)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", tmp.name, "-ac", "1", "-b:a", "64k",
                        str(AUDIO / line["file"])], check=True)
    print(f"[{i}/{len(todo)}] {time.time() - t:4.1f}s  {line['text']}", flush=True)
