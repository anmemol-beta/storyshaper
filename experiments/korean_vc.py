"""Korean in the parent's voice by voice conversion: a correctly pronounced Korean voice, re-timbred as the parent.

    voice/.venv-chatterbox/bin/python experiments/korean_vc.py [--source Reed]

1. A Korean text-to-speech voice reads each line (macOS `say`, only for this experiment; a product would use a
   licensed Korean TTS).
2. Chatterbox VC converts that audio to the parent's voice (voice/ref_clip.wav, the parent speaking English).
Each clip is transcribed back with Muse Voice Transcribe (character error rate, as in korean_narration.py).
Writes voice/out/korean/vc_<n>.mp3 (converted) and vc_src_<n>.mp3 (before conversion), and vc_results.json.
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import torch
import torchaudio as ta
from chatterbox.vc import ChatterboxVC

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from experiments.korean_lines import LINES, cer  # noqa: E402
from narration.server import load_api_key, muse_transcriber  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--source", default="Yuna", help="macOS Korean voice that reads the text")
args = parser.parse_args()
OUT = ROOT / "voice" / "out" / "korean"
OUT.mkdir(parents=True, exist_ok=True)
REF = ROOT / "voice" / "ref_clip.wav"

device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
model = ChatterboxVC.from_pretrained(device)
transcribe = muse_transcriber(load_api_key())


def mp3(src, dst):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-b:a", "64k", str(dst)], check=True)


def heard(path):
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", tmp.name], check=True)
        return transcribe(Path(tmp.name).read_bytes())


results = []
for n, text in enumerate(LINES, 1):
    with tempfile.TemporaryDirectory() as tmp:
        aiff, src, out = Path(tmp) / "s.aiff", Path(tmp) / "s.wav", Path(tmp) / "o.wav"
        subprocess.run(["say", "-v", args.source, "-r", "150", "-o", str(aiff), text], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff), "-ac", "1", "-ar", "24000", str(src)], check=True)
        t = time.time()
        wav = model.generate(str(src), target_voice_path=str(REF))
        took = time.time() - t
        ta.save(str(out), wav, model.sr)
        mp3(src, OUT / f"vc_src_{n}.mp3")
        mp3(out, OUT / f"vc_{n}.mp3")
        h_src, h_out = heard(src), heard(out)
    results.append({"line": n, "text": text, "file": f"vc_{n}.mp3", "source": f"vc_src_{n}.mp3", "seconds": round(took, 1),
                    "heard": h_out, "cer": round(cer(text, h_out), 3), "sourceHeard": h_src, "sourceCer": round(cer(text, h_src), 3)})
    r = results[-1]
    print(f"{n}: convert {took:4.1f}s  CER {r['cer']:.2f} (source {r['sourceCer']:.2f})  heard: {h_out}", flush=True)
(OUT / "vc_results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
print(f"mean CER {sum(r['cer'] for r in results) / len(results):.3f} "
      f"(source voice {sum(r['sourceCer'] for r in results) / len(results):.3f}), "
      f"mean {sum(r['seconds'] for r in results) / len(results):.1f}s to convert a line", flush=True)
