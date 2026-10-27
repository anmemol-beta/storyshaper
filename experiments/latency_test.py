"""Measure how fast one story turn can be: image edit options and text streaming.

Needs experiments/out/1_straw_house.webp from api_smoke_test.py.
    python3 experiments/latency_test.py
"""
import base64
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "experiments" / "out"
for line in (ROOT / ".env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"'))

client = httpx.Client(base_url="https://api.meta.ai/v1", timeout=300,
                      headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"})
STRAW = "data:image/webp;base64," + base64.b64encode((OUT / "1_straw_house.webp").read_bytes()).decode()
EDIT_PROMPT = "change the straw house into a house made of paper and folded origami, keep the pig, style and composition the same"
STORY = ("아기돼지 삼형제 동화. 아이가 '첫째 돼지 집은 종이로 만들었어'라고 답했어. "
         "JSON으로만 답해: {\"narration\": 다음 장면 2문장 (5살 눈높이), "
         "\"image_edit\": 그림을 어떻게 바꿀지 영어 한 문장}")


def edit(label, **extra):
    body = {"model": "muse-image-1.0", "prompt": EDIT_PROMPT, "images": [{"image_url": STRAW}], **extra}
    t = time.time()
    r = client.post("/images/edits", json=body)
    secs = time.time() - t
    if r.status_code != 200:
        return label, secs, f"HTTP {r.status_code}: {r.text[:300]}"
    img = r.json()["data"][0]["b64_json"]
    ext = extra.get("output_format", "webp")
    (OUT / f"edit_{label}.{ext}").write_bytes(base64.b64decode(img))
    return label, secs, f"{len(img) * 3 // 4 // 1024} KB"


def text_stream(label, **extra):
    """Time to first token and total for a Responses call with streaming."""
    body = {"model": "muse-spark-1.3", "input": STORY, "stream": True, **extra}
    t = time.time()
    first, chunks = None, []
    with client.stream("POST", "/responses", json=body) as r:
        if r.status_code != 200:
            r.read()
            return label, time.time() - t, f"HTTP {r.status_code}: {r.text[:300]}"
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:]) if line[5:].strip() not in ("", "[DONE]") else {}
            if ev.get("type") == "response.output_text.delta":
                first = first or time.time() - t
                chunks.append(ev["delta"])
    return label, time.time() - t, f"first token {first:.1f}s | {''.join(chunks)[:200]}"


def show(res):
    label, secs, note = res
    print(f"{secs:6.1f}s  {label:28} {note}")


print("## Text (muse-spark-1.3, streaming, JSON narration + image instruction)")
show(text_stream("spark default"))
show(text_stream("spark reasoning low", reasoning={"effort": "low"}))

print("\n## Image edit (muse-image-1.0)")
show(edit("reasoning_low", reasoning_strength="low"))
show(edit("reasoning_low_jpeg", reasoning_strength="low", output_format="jpeg"))
show(edit("low_no_tools", reasoning_strength="low", output_format="jpeg", tool_enablement={"web_search": False}))

print("\n## Parallel: text + image edit started together")
t = time.time()
with ThreadPoolExecutor() as ex:
    ft = ex.submit(text_stream, "parallel text", reasoning={"effort": "low"})
    fi = ex.submit(edit, "parallel_image", reasoning_strength="low", output_format="jpeg")
    show(ft.result())
    show(fi.result())
print(f"{time.time() - t:6.1f}s  wall clock for both")
