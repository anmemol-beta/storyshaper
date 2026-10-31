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
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "voice" / "finetune-kit"
RUNS = ROOT / "voice" / "finetune-runs"
DATA = ROOT / "voice" / "finetune-data"
PROFILES = ROOT / "voice" / "profiles"
MIN_MATCH = 0.8          # training sentences whose transcript matched at least this well (voices.text_error)


def training_scope(data, *, language="en", speaker=None, emotion=None):
    """Keep the dataset's actual character/emotion filter when an adapter is trained."""
    manifest = Path(data) / "dataset.json"
    dataset = json.loads(manifest.read_text()) if manifest.exists() else {}
    if dataset.get("language", "en") != language:
        raise ValueError("Dataset language does not match --language; do not mix languages in an English adapter.")
    for key, requested in (("speakerId", speaker), ("emotion", emotion)):
        if requested is not None and manifest.exists() and dataset.get(key) != requested:
            raise ValueError(f"Dataset {key} does not match the requested training scope.")
    return {"language": language, "speakerId": dataset.get("speakerId", speaker),
            "emotion": dataset.get("emotion", emotion)}


def dataset_from_voice(voice_id: str, *, language="en", speaker=None, emotion=None, performance_only=False) -> Path:
    """LJSpeech folder (wavs/ + metadata.csv) from the sentences recorded on voice-train.html."""
    folder = PROFILES / voice_id / "train"
    if not (folder / "clips.json").is_file():
        raise ValueError("No practice recordings yet. Record the story roles and listen to confirm their performance first.")
    clips = json.loads((folder / "clips.json").read_text())
    meta_path = folder.parent / "meta.json"
    profile = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    from .practice import current_performance
    usable, performances = [], {}
    for clip in clips.values():
        if clip.get("excluded") or (clip.get("match") is not None and clip["match"] < MIN_MATCH):
            continue
        if clip.get("desiredPerformance"):
            sample = current_performance(clip)
            if (not sample or clip.get("performanceReview") != "confirmed"
                    or profile.get("status") != "saved" or profile.get("consent", {}).get("attested") is not True
                    or clip.get("match") is None or clip["match"] < MIN_MATCH
                    or sample["language"] != language
                    or sample["speakerId"] != (speaker or "narrator")
                    or emotion is not None and sample["emotion"] != emotion):
                continue
            performances[clip["n"]] = sample
        elif performance_only or emotion is not None or speaker not in (None, "narrator") or language != "en":
            continue
        filename = clip.get("file", f"{clip['n']:03d}.wav")
        if Path(filename).name != filename or not (folder / filename).is_file():
            continue
        if clip.get("desiredPerformance"):
            from .voices import read_wav
            try:
                samples, rate = read_wav(folder / filename)
                if len(samples) < rate:
                    continue
            except (OSError, ValueError, EOFError, wave.Error):
                continue
        usable.append(clip)
    if not usable:
        raise ValueError("No matching reviewed recordings. Record and check the script performance first.")
    suffix = "" if (language == "en" and speaker is None and emotion is None and not performance_only) else (
        f"-{language}-{speaker or 'narrator'}" + (f"-{emotion}" if emotion else ""))
    out = DATA / (voice_id + suffix)
    shutil.rmtree(out, ignore_errors=True)
    (out / "wavs").mkdir(parents=True)
    rows, labels = [], []
    for c in sorted(usable, key=lambda c: c["n"]):
        name = f"s{c['n']:04d}"
        shutil.copy(folder / c.get("file", f"{c['n']:03d}.wav"), out / "wavs" / f"{name}.wav")
        text = c["text"].replace("|", " ").replace("\n", " ")
        rows.append(f"{name}|{text}|{text}")
        sample = performances.get(c["n"])
        labels.append({"id": name, "audio": f"wavs/{name}.wav", "text": text,
                       "language": language, "speakerId": sample["speakerId"] if sample else "narrator",
                       "desiredPerformance": sample, "performanceReview": c.get("performanceReview"),
                       "source": c.get("source", "read")})
    (out / "metadata.csv").write_text("\n".join(rows) + "\n")
    (out / "performance.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in labels), encoding="utf-8")
    (out / "dataset.json").write_text(json.dumps({
        "voiceId": voice_id, "language": language, "speakerId": speaker or ("narrator" if performances else None), "emotion": emotion,
        "performanceOnly": performance_only, "clips": len(usable),
        "conditioning": "Performance labels describe reviewed recordings. The current LoRA kit consumes plain text and audio, not emotion tokens.",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(usable)} of {len(clips)} clips used ({sum(c.get('source') == 'media' for c in usable)} from videos) "
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
    parser.add_argument("--language", choices=["en", "ko"], default="en", help="language of the recorded script")
    parser.add_argument("--speaker", choices=["narrator", "pig1", "pig2", "pig3", "wolf"], help="keep one character's performed recordings")
    parser.add_argument("--emotion", choices=["calm", "excited", "curious", "confident", "surprised", "worried", "relieved", "happy", "determined", "disappointed"])
    parser.add_argument("--performance-only", action="store_true", help="use only current script recordings whose performance was reviewed")
    parser.add_argument("--export-only", action="store_true", help="prepare the checked audio/text dataset without loading or training a model")
    args = parser.parse_args()

    if args.language != "en" and not args.export_only:
        parser.error("The current narration runtime supports only English adapters; Korean recordings can be exported for a compatible training pipeline.")
    try:
        data = dataset_from_voice(args.voice, language=args.language, speaker=args.speaker, emotion=args.emotion,
                                  performance_only=args.performance_only) if args.voice else Path(args.data).resolve()
        scope = training_scope(data, language=args.language, speaker=args.speaker, emotion=args.emotion)
    except ValueError as exc:
        parser.error(str(exc))
    if args.export_only:
        print(data, flush=True)
        return
    name = args.name or data.name
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
        "scope": scope,
        "vocab": 704 if args.tokenizer == "en" else 2454,
        "device": "mps" if apple else "cuda" if torch.cuda.is_available() else "cpu", "seconds": round(took)}, indent=2))
    print(f"Done in {took / 60:.1f} min -> {out / 'new_lang_adapter'}", flush=True)


if __name__ == "__main__":
    main()
