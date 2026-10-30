"""Before / after a fine-tune: the same held-out sentences, the same reference clip, with and without the adapter.

    voice/.venv-ft/bin/python -m narration.finetune_eval --run smoke --ref voice/ref_clip.wav --real voice/finetune-data/smoke/wavs

Scores (higher is better):
- similarity: cosine between Chatterbox's speaker embedding of the generated line and of the real recordings
- match: 1 - character error rate of Muse Voice Transcribe's transcript against the sentence
Writes voice/finetune-runs/<run>/eval/{before,after}_<n>.wav, eval.json and index.html (listen side by side).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "voice" / "finetune-kit"
sys.path.insert(0, str(ROOT))
from narration.voices import text_error  # noqa: E402

# Not in the training sentences or the picture book.
HELD_OUT = [
    "The little fox found a shiny red button under the old oak tree.",
    "\"Can I come too?\" asked the smallest duck, flapping her wings.",
    "When the sun went down, the whole village sang a quiet song.",
    "Grandpa told the children a story about a whale who loved to sing.",
    "Hold on tight, because this boat is going to sail far, far away!",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", required=True, help="folder name in voice/finetune-runs")
    parser.add_argument("--ref", required=True, help="reference clip both versions imitate")
    parser.add_argument("--real", required=True, help="folder of the parent's real recordings (wav) to compare with")
    args = parser.parse_args()
    run = ROOT / "voice" / "finetune-runs" / args.run
    ref, real = Path(args.ref).resolve(), Path(args.real).resolve()
    out = run / "eval"
    out.mkdir(parents=True, exist_ok=True)

    os.chdir(KIT)
    sys.path.insert(0, str(KIT))
    import librosa
    import numpy as np
    import soundfile as sf
    import torch
    from peft import PeftModel
    from src.chatterbox_.models.t3.t3 import T3
    from src.chatterbox_.tts import ChatterboxTTS
    from src.config import TrainConfig
    from src.model import resize_and_load_t3_weights
    from narration.server import load_api_key, muse_transcriber

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    cfg = TrainConfig()
    trained = json.loads((run / "train.json").read_text())       # the same base model and vocabulary as training
    cfg.model_dir, cfg.new_vocab_size = trained.get("model_dir", cfg.model_dir), trained.get("vocab", cfg.new_vocab_size)

    def engine(adapter: Path | None):
        base = ChatterboxTTS.from_local(cfg.model_dir, device="cpu")
        hp = base.t3.hp
        hp.text_tokens_dict_size = cfg.new_vocab_size
        t3 = resize_and_load_t3_weights(T3(hp=hp), base.t3.state_dict())
        base.t3 = PeftModel.from_pretrained(t3, str(adapter), is_trainable=False) if adapter else t3
        for part in (base.t3, base.s3gen, base.ve):
            part.to(device).eval()
        base.device = device
        return base

    def embed(model, wav, sr):
        return model.ve.embeds_from_wavs([librosa.resample(wav, orig_sr=sr, target_sr=16000)], sample_rate=16000)[0]

    transcribe = muse_transcriber(load_api_key())
    results = {"before": [], "after": []}
    target = None
    for label, adapter in (("before", None), ("after", run / "new_lang_adapter")):
        model = engine(adapter)
        if target is None:
            reals = [librosa.load(str(p), sr=16000)[0] for p in sorted(real.glob("*.wav"))]
            target = np.mean([model.ve.embeds_from_wavs([w], sample_rate=16000)[0] for w in reals], axis=0)
        for n, text in enumerate(HELD_OUT, 1):
            torch.manual_seed(n)
            wav = model.generate(text, audio_prompt_path=str(ref), exaggeration=0.5, cfg_weight=0.5).squeeze(0).cpu().numpy()
            path = out / f"{label}_{n}.wav"
            sf.write(path, wav, model.sr)
            e = embed(model, wav, model.sr)
            sim = float(np.dot(e, target) / (np.linalg.norm(e) * np.linalg.norm(target)))
            with tempfile.NamedTemporaryFile(suffix=".wav") as t:
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-ar", "16000", "-ac", "1", t.name], check=True)
                heard = transcribe(Path(t.name).read_bytes())
            results[label].append({"n": n, "text": text, "file": path.name, "similarity": round(sim, 3),
                                   "heard": heard, "match": round(1 - text_error(text, heard), 2)})
            print(f"{label} {n}: similarity {sim:.3f}  match {results[label][-1]['match']:.2f}", flush=True)
        del model
    summary = {k: {"similarity": round(float(np.mean([r["similarity"] for r in v])), 3),
                   "match": round(float(np.mean([r["match"] for r in v])), 2)} for k, v in results.items()}
    (out / "eval.json").write_text(json.dumps({"summary": summary, **results}, ensure_ascii=False, indent=2))
    rows = "".join(
        f"<tr><td>{html.escape(b['text'])}</td>"
        f"<td><audio controls preload=none src='{b['file']}'></audio><br>{b['similarity']:.3f} · {b['match']:.2f}</td>"
        f"<td><audio controls preload=none src='{a['file']}'></audio><br>{a['similarity']:.3f} · {a['match']:.2f}</td></tr>"
        for b, a in zip(results["before"], results["after"]))
    (out / "index.html").write_text(f"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Fine-tune: {html.escape(args.run)}</title>
<style>body{{font-family:system-ui;max-width:980px;margin:24px auto;padding:0 16px;color:#222}}td,th{{border-bottom:1px solid #ddd;padding:8px;vertical-align:top}}
table{{border-collapse:collapse;width:100%}}audio{{width:260px}}</style>
<h1>Fine-tune “{html.escape(args.run)}”: before / after</h1>
<p>Same reference clip and settings. Scores: speaker similarity to the real recordings · transcription match.
Before {summary['before']['similarity']:.3f} · {summary['before']['match']:.2f} — After {summary['after']['similarity']:.3f} · {summary['after']['match']:.2f}</p>
<table><tr><th>Sentence</th><th>Before</th><th>After</th></tr>{rows}</table>""")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
