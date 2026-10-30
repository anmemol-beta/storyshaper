"""Compare four ways to voice the wolf and a pig, for choosing how characters should sound.

    voice/.venv-chatterbox/bin/python experiments/character_voices.py

A  parent voice as is            (same settings as the narration)
B  parent voice, pitch only      (wolf -4, pig +4 semitones after generation)
C  parent voice, acted           (Chatterbox exaggeration / cfg_weight, plus tempo)
D  a different stock voice       (LibriTTS-R speaker, CC BY 4.0, see voice/characters/SOURCES.md)

Writes voice/out/characters/<role>_<variant>.mp3.
"""
import subprocess
import tempfile
import time
from pathlib import Path

import librosa
import soundfile as sf
import torch
from chatterbox.tts import ChatterboxTTS

ROOT = Path(__file__).resolve().parent.parent
PARENT = ROOT / "voice" / "ref_clip.wav"
OUT = ROOT / "voice" / "out" / "characters"
OUT.mkdir(parents=True, exist_ok=True)

ROLES = {
    "wolf": {
        "text": "Little pig, little pig, let me come in! Then I'll huff, and I'll puff, and I'll blow your house in!",
        "stock": ROOT / "voice" / "characters" / "wolf_libritts_1188.wav",
        "semitones": -4, "acted": (0.9, 0.3, 0.9),   # exaggeration, cfg_weight, tempo
    },
    "pig": {
        "text": "Not by the hair of my chinny chin chin! You can't come in!",
        "stock": ROOT / "voice" / "characters" / "pig_libritts_237.wav",
        "semitones": 4, "acted": (0.8, 0.4, 1.1),
    },
}

device = "mps" if torch.backends.mps.is_available() else "cpu"
model = ChatterboxTTS.from_pretrained(device=device)


def save_mp3(wav, sr, name, tempo=1.0):
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        sf.write(tmp.name, wav, sr)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", tmp.name, "-filter:a", f"atempo={tempo}",
                        "-ac", "1", "-b:a", "64k", str(OUT / f"{name}.mp3")], check=True)


for role, r in ROLES.items():
    t = time.time()
    plain = model.generate(r["text"], audio_prompt_path=str(PARENT), exaggeration=0.7, cfg_weight=0.5)[0].cpu().numpy()
    save_mp3(plain, model.sr, f"{role}_A")
    save_mp3(librosa.effects.pitch_shift(plain, sr=model.sr, n_steps=r["semitones"]), model.sr, f"{role}_B")
    ex, cfg, tempo = r["acted"]
    acted = model.generate(r["text"], audio_prompt_path=str(PARENT), exaggeration=ex, cfg_weight=cfg)[0].cpu().numpy()
    save_mp3(acted, model.sr, f"{role}_C", tempo)
    stock = model.generate(r["text"], audio_prompt_path=str(r["stock"]), exaggeration=0.7, cfg_weight=0.5)[0].cpu().numpy()
    save_mp3(stock, model.sr, f"{role}_D")
    print(f"{role}: {time.time() - t:.1f}s", flush=True)
