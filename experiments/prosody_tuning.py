"""Which narration settings make the cloned voice speak like the parent: pitch, how much it moves, and pace?

    voice/.venv-chatterbox/bin/python experiments/prosody_tuning.py --voice bf192b5989f2

The parent's own read-aloud sentences (voice-train.html) give the target: median pitch, pitch movement (standard
deviation in semitones) and speaking rate (letters per second of speech). The same held-out lines are made with a
grid of exaggeration x cfg_weight on the voice's reference clip; each is measured the same way, transcribed with
Muse Voice Transcribe (clarity) and, for pace, the tempo that would match the parent is computed.
Writes voice/finetune-runs/prosody/<voice>/ (clips, results.json, index.html to listen).
"""
import argparse
import html
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from narration.finetune_eval import HELD_OUT  # noqa: E402
from narration.server import load_api_key, muse_transcriber  # noqa: E402
from narration.voices import text_error  # noqa: E402

GRID = [(0.5, 0.5), (0.7, 0.5), (0.9, 0.5), (0.5, 0.3), (0.7, 0.3), (0.9, 0.3)]


def prosody(path, text):
    y, sr = librosa.load(str(path), sr=16000)
    f0, _, _ = librosa.pyin(y, fmin=60, fmax=400, sr=sr)
    f0 = f0[~np.isnan(f0)]
    speech = sum(e - s for s, e in librosa.effects.split(y, top_db=35)) / sr
    letters = len(re.sub(r"[^a-z]", "", text.lower()))
    return {"pitch": float(np.median(f0)), "movement": float(np.std(12 * np.log2(f0 / np.median(f0)))),
            "rate": letters / speech if speech else 0.0}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voice", required=True)
    args = parser.parse_args()
    profile = ROOT / "voice" / "profiles" / args.voice
    clips = json.loads((profile / "train" / "clips.json").read_text())
    real = [prosody(profile / "train" / c.get("file", f"{c['n']:03d}.wav"), c["text"])
            for c in clips.values() if (c.get("match") or 0) >= 0.8 and c.get("source") != "media"]
    target = {k: float(np.mean([r[k] for r in real])) for k in ("pitch", "movement", "rate")}
    print(f"target from {len(real)} real sentences: pitch {target['pitch']:.1f} Hz, movement {target['movement']:.2f} st, "
          f"rate {target['rate']:.1f} letters/s", flush=True)

    out = ROOT / "voice" / "finetune-runs" / "prosody" / args.voice
    out.mkdir(parents=True, exist_ok=True)
    from chatterbox.tts import ChatterboxTTS
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = ChatterboxTTS.from_pretrained(device=device)
    transcribe = muse_transcriber(load_api_key())
    results = []
    for exaggeration, cfg in GRID:
        model.prepare_conditionals(str(profile / "ref.wav"), exaggeration=exaggeration)
        rows = []
        for n, text in enumerate(HELD_OUT, 1):
            torch.manual_seed(n)
            wav = model.generate(text, exaggeration=exaggeration, cfg_weight=cfg).squeeze(0).cpu().numpy()
            path = out / f"e{exaggeration}_c{cfg}_{n}.wav"
            sf.write(path, wav, model.sr)
            with tempfile.NamedTemporaryFile(suffix=".wav") as t:
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-ar", "16000", "-ac", "1", t.name], check=True)
                heard = transcribe(Path(t.name).read_bytes())
            rows.append({**prosody(path, text), "match": 1 - text_error(text, heard), "file": path.name, "text": text})
        mean = {k: float(np.mean([r[k] for r in rows])) for k in ("pitch", "movement", "rate", "match")}
        tempo = target["rate"] / mean["rate"]
        results.append({"exaggeration": exaggeration, "cfg_weight": cfg, **mean, "tempo_to_match": tempo, "rows": rows})
        print(f"exaggeration {exaggeration} cfg {cfg}: pitch {mean['pitch']:.1f} | movement {mean['movement']:.2f} | "
              f"rate {mean['rate']:.1f} (tempo {tempo:.2f} to match) | match {mean['match']:.2f}", flush=True)
    (out / "results.json").write_text(json.dumps({"target": target, "results": results}, ensure_ascii=False, indent=1))
    head = "".join(f"<th>exag {r['exaggeration']} · cfg {r['cfg_weight']}<br><small>{r['movement']:.2f} st · {r['rate']:.1f} l/s · {r['match']:.2f}</small></th>" for r in results)
    body = "".join("<tr><td>" + html.escape(text) + "</td>" + "".join(
        f"<td><audio controls preload=none src='{r['rows'][i]['file']}'></audio></td>" for r in results) + "</tr>"
        for i, text in enumerate(HELD_OUT))
    (out / "index.html").write_text(f"""<!doctype html><meta charset=utf-8><title>Prosody grid</title>
<style>body{{font-family:system-ui;margin:24px}}td,th{{border-bottom:1px solid #ddd;padding:6px;vertical-align:top}}audio{{width:170px}}small{{color:#777}}</style>
<h1>Prosody grid · target {target['movement']:.2f} semitones movement, {target['rate']:.1f} letters/s</h1>
<p>Each column: pitch movement · speaking rate · transcription match. Narration can slow any column with tempo (atempo).</p>
<table><tr><th>Sentence</th>{head}</tr>{body}</table>""")


if __name__ == "__main__":
    main()
