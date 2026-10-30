"""Can the parent's voice read the Korean picture book? Chatterbox Multilingual, cross-language cloning.

    voice/.venv-chatterbox/bin/python experiments/korean_narration.py                     # parent's English clip
    voice/.venv-chatterbox/bin/python experiments/korean_narration.py --ref k.wav --name ko_ref --cfg 0.5

The reference clip is the parent speaking English (voice/ref_clip.wav). Each Korean line is made twice:
cfg_weight 0.5 (default) and 0 (Chatterbox's advice when the reference is in another language, to reduce
accent carry-over). Each clip is transcribed back with Muse Voice Transcribe and compared with the text
(character error rate, spaces and punctuation ignored).
Writes voice/out/korean/<n>_cfg<w>.mp3 and voice/out/korean/results.json; listen on voice/korean.html.
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import torchaudio as ta
import torch
from chatterbox.mtl_tts import ChatterboxMultilingualTTS

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from experiments.korean_lines import LINES, cer  # noqa: E402
from narration.server import load_api_key, muse_transcriber  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--ref", default=str(ROOT / "voice" / "ref_clip.wav"), help="reference clip to clone")
parser.add_argument("--name", default="", help="prefix for output files and results (default: the English-reference run)")
parser.add_argument("--cfg", type=float, nargs="+", default=[0.5, 0.0])
args = parser.parse_args()
REF = Path(args.ref)
OUT = ROOT / "voice" / "out" / "korean"
OUT.mkdir(parents=True, exist_ok=True)
PREFIX = f"{args.name}_" if args.name else ""




device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
t = time.time()
model = ChatterboxMultilingualTTS.from_pretrained(device=device)  # a string: the loader maps CUDA weights to CPU only for "cpu"/"mps"
print(f"model loaded in {time.time() - t:.0f}s", flush=True)
transcribe = muse_transcriber(load_api_key())
results = []
for n, text in enumerate(LINES, 1):
    for cfg in args.cfg:
        t = time.time()
        exaggeration = 0.7 if "!" in text else 0.5
        wav = model.generate(text, language_id="ko", audio_prompt_path=str(REF), exaggeration=exaggeration, cfg_weight=cfg)
        took = time.time() - t
        name = f"{PREFIX}{n}_cfg{cfg:g}"
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "line.wav"
            ta.save(str(src), wav, model.sr)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-b:a", "64k",
                            str(OUT / f"{name}.mp3")], check=True)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000",
                            "-c:a", "pcm_s16le", str(Path(tmp) / "asr.wav")], check=True)
            heard = transcribe((Path(tmp) / "asr.wav").read_bytes())
        results.append({"line": n, "text": text, "cfg": cfg, "file": f"{name}.mp3", "seconds": round(took, 1),
                        "heard": heard, "cer": round(cer(text, heard), 3)})
        print(f"{name}: {took:4.1f}s  CER {results[-1]['cer']:.2f}  heard: {heard}", flush=True)
(OUT / f"{PREFIX}results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
for cfg in args.cfg:
    rows = [r for r in results if r["cfg"] == cfg]
    print(f"cfg {cfg:g}: mean CER {sum(r['cer'] for r in rows) / len(rows):.3f}, "
          f"mean {sum(r['seconds'] for r in rows) / len(rows):.1f}s per line", flush=True)
