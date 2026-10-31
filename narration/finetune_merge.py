"""Bake a fine-tune into a standalone T3 for one voice, so the narration server can use it without PEFT.

    voice/.venv-ft/bin/python -m narration.finetune_merge --run dad-51 --voice bf192b5989f2

Only for runs trained with the English tokenizer: the merged T3 then has exactly the shape of the narration
server's English T3 (Chatterbox 0.1.7). Writes voice/profiles/<voice>/t3_finetuned.safetensors (float16,
~1 GB, deleted with the voice) and records the run in the voice's meta.json under "finetune" (off until enabled).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "voice" / "finetune-kit"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--enable", action="store_true", help="read this voice's English lines with the fine-tune")
    args = parser.parse_args()
    run = ROOT / "voice" / "finetune-runs" / args.run
    trained = json.loads((run / "train.json").read_text())
    if trained.get("tokenizer") != "en" or trained.get("scope", {}).get("language", "en") != "en":
        sys.exit("Only English-tokenizer runs can be merged for the narration server.")
    profile = ROOT / "voice" / "profiles" / args.voice
    meta_path = profile / "meta.json"
    meta = json.loads(meta_path.read_text())

    os.chdir(KIT)
    sys.path.insert(0, str(KIT))
    import torch
    from peft import PeftModel
    from safetensors.torch import save_file
    from src.chatterbox_.models.t3.t3 import T3
    from src.chatterbox_.tts import ChatterboxTTS
    from src.model import resize_and_load_t3_weights

    base = ChatterboxTTS.from_local(trained["model_dir"], device="cpu")
    hp = base.t3.hp
    hp.text_tokens_dict_size = trained["vocab"]
    t3 = resize_and_load_t3_weights(T3(hp=hp), base.t3.state_dict())
    merged = PeftModel.from_pretrained(t3, str(run / "new_lang_adapter")).merge_and_unload()
    state = {k: v.detach().to(torch.float16).contiguous() for k, v in merged.state_dict().items()}
    out = profile / "t3_finetuned.safetensors"
    save_file(state, str(out))
    evaluation = run / "eval" / "eval.json"
    meta["finetune"] = {"run": args.run, "file": out.name, "mergedAt": int(time.time()), "enabled": args.enable,
                        "scope": trained.get("scope"),
                        "sentences": trained.get("data") and len((Path(trained["data"]) / "metadata.csv").read_text().splitlines()),
                        "eval": json.loads(evaluation.read_text())["summary"] if evaluation.exists() else None}
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"{out} ({out.stat().st_size / 1e9:.2f} GB), enabled={args.enable}", flush=True)


if __name__ == "__main__":
    main()
