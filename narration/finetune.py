"""Fine-tune the parent's voice: a LoRA on Chatterbox's T3 (rhythm, accent, phrasing), on a Mac or a GPU.

    voice/.venv-ft/bin/python -m narration.finetune --voice <id>          # sentences recorded on voice-train.html
    voice/.venv-ft/bin/python -m narration.finetune --data voice/finetune-data/smoke --name smoke --epochs 30

Uses the Apache-2.0 kit in voice/finetune-kit (gokhaneraslan/chatterbox-finetuning @ fac31c4, git-ignored; set it
up with its setup.py). The kit's code is not changed: this runner swaps in our settings, and on Apple silicon turns
off bf16, worker processes and pinned memory, which the kit assumes for CUDA. Timbre still comes from the reference
clip (S3Gen is frozen); the adapter makes the parent's way of speaking more like them.

Tokenizer: by default the English one (704 tokens, voice/finetune-kit/pretrained_models_en), so training starts from
exactly the model the narration server uses. `--tokenizer multilingual` is the kit's default (2,454 tokens, the
English T3 resized with mean-initialised new tokens); in a 20 s test that start was clearly worse than the English
model (similarity 0.835 vs 0.897, transcription match 0.73 vs 0.97), so it only makes sense for new languages.

Output: voice/finetune-runs/<name>/new_lang_adapter (LoRA adapter + resized embeddings) and train.json (settings, timing).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "voice" / "finetune-kit"
RUNS = ROOT / "voice" / "finetune-runs"
DATA = ROOT / "voice" / "finetune-data"
PROFILES = ROOT / "voice" / "profiles"
MIN_MATCH = 0.8          # training sentences whose transcript matched at least this well (voices.text_error)


def dataset_from_voice(voice_id: str) -> Path:
    """LJSpeech folder (wavs/ + metadata.csv) from the sentences recorded on voice-train.html."""
    folder = PROFILES / voice_id / "train"
    clips = json.loads((folder / "clips.json").read_text())
    usable = [c for c in clips.values() if c.get("match") is None or c["match"] >= MIN_MATCH]
    out = DATA / voice_id
    shutil.rmtree(out, ignore_errors=True)
    (out / "wavs").mkdir(parents=True)
    rows = []
    for c in sorted(usable, key=lambda c: c["n"]):
        name = f"s{c['n']:03d}"
        shutil.copy(folder / f"{c['n']:03d}.wav", out / "wavs" / f"{name}.wav")
        text = c["text"].replace("|", " ").replace("\n", " ")
        rows.append(f"{name}|{text}|{text}")
    (out / "metadata.csv").write_text("\n".join(rows) + "\n")
    print(f"{len(usable)} of {len(clips)} recorded sentences used "
          f"({sum(c['seconds'] for c in usable) / 60:.1f} min)", flush=True)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--voice", help="voice id whose voice-train.html sentences to use")
    source.add_argument("--data", help="LJSpeech folder: wavs/ and metadata.csv (ID|text|text)")
    parser.add_argument("--name", help="run name (default: the voice id or data folder name)")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch", type=int, default=4)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--rank", type=int, default=32, help="LoRA rank (the kit default 128 is for hours of data)")
    parser.add_argument("--tokenizer", choices=["en", "multilingual"], default="en")
    args = parser.parse_args()

    data = dataset_from_voice(args.voice) if args.voice else Path(args.data).resolve()
    name = args.name or args.voice or data.name
    out = RUNS / name
    out.mkdir(parents=True, exist_ok=True)

    os.chdir(KIT)                      # the kit uses paths relative to its folder and imports `src`
    sys.path.insert(0, str(KIT))
    import torch
    import transformers
    import train as kit_train
    from src.config import TrainConfig

    def config():
        cfg = TrainConfig()
        cfg.csv_path = str(data / "metadata.csv")
        cfg.wav_dir = str(data / "wavs")
        cfg.preprocessed_dir = str(out / "preprocess")
        cfg.output_dir = str(out)
        cfg.ljspeech, cfg.json_format, cfg.preprocess = True, False, True
        cfg.is_turbo, cfg.is_lora, cfg.is_inference = False, True, False
        cfg.lora_r, cfg.lora_alpha = args.rank, args.rank * 2
        cfg.batch_size, cfg.grad_accum = args.batch, 1
        cfg.learning_rate, cfg.num_epochs = args.lr, args.epochs
        cfg.save_steps, cfg.save_total_limit = 10_000, 1
        cfg.dataloader_num_workers = 0
        if args.tokenizer == "en":
            cfg.model_dir, cfg.new_vocab_size = "./pretrained_models_en", 704
        return cfg

    apple = not torch.cuda.is_available() and torch.backends.mps.is_available()

    def training_arguments(**kw):
        if not torch.cuda.is_available():
            kw.update(bf16=False, fp16=False, dataloader_pin_memory=False)
        kw.update(dataloader_num_workers=0, dataloader_persistent_workers=False, report_to=[],
                  logging_strategy="steps", logging_steps=5)
        return transformers.TrainingArguments(**kw)

    kit_train.TrainConfig = config
    kit_train.TrainingArguments = training_arguments
    print(f"Training '{name}' on {'Apple MPS' if apple else 'CUDA' if torch.cuda.is_available() else 'CPU'} "
          f"with {sum(1 for _ in (data / 'wavs').glob('*.wav'))} clips, {args.epochs} epochs, batch {args.batch}, "
          f"LoRA rank {args.rank}", flush=True)
    started = time.time()
    kit_train.main()
    took = time.time() - started
    (out / "train.json").write_text(json.dumps({
        "name": name, "data": str(data), "epochs": args.epochs, "batch": args.batch, "lr": args.lr, "rank": args.rank,
        "tokenizer": args.tokenizer, "model_dir": "./pretrained_models_en" if args.tokenizer == "en" else "./pretrained_models",
        "vocab": 704 if args.tokenizer == "en" else 2454,
        "device": "mps" if apple else "cuda" if torch.cuda.is_available() else "cpu", "seconds": round(took)}, indent=2))
    print(f"Done in {took / 60:.1f} min -> {out / 'new_lang_adapter'}", flush=True)


if __name__ == "__main__":
    main()
