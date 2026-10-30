"""Human-review gate; a successful Runway task is never auto-published."""
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from .runway_api import RunwayError, validate_mp4

def review(ledger, run_id, scene_key, root=".", approve=False):
    row=ledger.get(run_id)
    if row["state"]!="downloaded" or not row["file_path"]:
        raise RunwayError("not_downloaded")
    if not approve:
        ledger.update(run_id,"rejected_by_reviewer",error_code="human_review_rejected")
        return ledger.get(run_id)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}",run_id):
        raise ValueError("invalid_run_id")
    root=Path(root)
    original=Path(row["file_path"])
    validate_mp4(original)
    registry_path=root/"media/scene_registry.json"
    data=json.loads(registry_path.read_text(encoding="utf-8"))
    asset=data.get("images",{}).get(scene_key)
    if not asset or scene_key in data.get("clips",{}):
        raise ValueError("unknown_or_registered_scene")
    dest=root/"prototype/video"/("runway_"+run_id+".mp4")
    dest.parent.mkdir(parents=True,exist_ok=True)
    if dest.exists(): raise FileExistsError(dest)
    temp_video=None
    temp_registry=None
    try:
        with tempfile.NamedTemporaryFile(dir=dest.parent,prefix=".review-",delete=False) as f:
            temp_video=Path(f.name)
        shutil.copyfile(original,temp_video)
        data["clips"][scene_key]={"file":dest.name,"reviewed":True,"cast":asset["cast"]}
        data["revision"]+=1
        with tempfile.NamedTemporaryFile(mode="w",encoding="utf-8",dir=registry_path.parent,delete=False) as f:
            temp_registry=Path(f.name)
            json.dump(data,f,ensure_ascii=False,indent=2)
            f.write("\n")
        os.link(temp_video,dest)
        try:
            os.replace(temp_registry,registry_path)
            temp_registry=None
        except Exception:
            dest.unlink(missing_ok=True)
            raise
        ledger.update(run_id,"approved",file_path=str(dest))
        return ledger.get(run_id)
    finally:
        if temp_video:temp_video.unlink(missing_ok=True)
        if temp_registry:temp_registry.unlink(missing_ok=True)
