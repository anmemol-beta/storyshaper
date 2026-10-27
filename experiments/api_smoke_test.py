"""Meta Model API smoke test: call each capability once and record latency.

Usage: put MODEL_API_KEY=... in .env at the repo root, then
    python3 experiments/api_smoke_test.py
Outputs (images, raw responses) go to experiments/out/.
"""
import base64
import json
import os
import subprocess
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "experiments" / "out"
OUT.mkdir(parents=True, exist_ok=True)

for line in (ROOT / ".env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"'))

BASE = "https://api.meta.ai/v1"
HEADERS = {"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"}
client = httpx.Client(base_url=BASE, headers=HEADERS, timeout=300)
results = []


def run(name, fn):
    t = time.time()
    try:
        summary = fn()
        status = "OK"
    except Exception as e:
        summary = f"{type(e).__name__}: {e}"[:600]
        status = "FAIL"
    secs = time.time() - t
    results.append((name, status, secs, summary))
    print(f"\n=== {name} [{status}] {secs:.1f}s\n{summary}")


def save(name, data):
    (OUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2))


def post_json(path, body, name):
    r = client.post(path, json=body)
    data = r.json() if "json" in r.headers.get("content-type", "") else {"raw": r.text}
    save(name, data)
    r.raise_for_status()
    return data


def output_text(data):
    for item in data.get("output", []):
        if item.get("type") == "message":
            return "".join(c.get("text", "") for c in item["content"] if c.get("type") == "output_text")
    return json.dumps(data, ensure_ascii=False)[:400]


def save_image(data, name):
    """Save first image from an ImagesResponse (API returns webp as b64_json)."""
    img = data["data"][0]
    raw = base64.b64decode(img["b64_json"]) if img.get("b64_json") else httpx.get(img["url"]).content
    path = OUT / f"{name}.webp"
    path.write_bytes(raw)
    return path


def data_url(path):
    return "data:image/webp;base64," + base64.b64encode(path.read_bytes()).decode()


# 1. Models
def models():
    data = client.get("/models").json()
    save("models", data)
    return ", ".join(m["id"] for m in data.get("data", []))


# 2-3. Text (Responses API)
STORY = "아기돼지 삼형제 동화에서, 아이가 '첫째 돼지 집은 종이로 만들었어'라고 답했어. 이 답을 반영해서 다음 장면을 3문장으로 이어줘. 5살 아이 눈높이로."


def spark():
    return output_text(post_json("/responses", {"model": "muse-spark-1.3", "input": STORY}, "spark"))


def wonder():
    body = {"model": "muse-wonder-1.0", "reasoning": {"effort": "low"}, "input": STORY}
    return output_text(post_json("/responses", body, "wonder"))


# 4. Chat Completions
def chat():
    body = {"model": "muse-spark-1.3", "messages": [{"role": "user", "content": "아기돼지 삼형제를 한 문장으로 요약해줘."}]}
    data = post_json("/chat/completions", body, "chat")
    return data["choices"][0]["message"]["content"]


# 5. Image generation
IMG = {}


def image_gen():
    body = {"model": "muse-image-1.0", "n": 1,
            "prompt": "children's picture book illustration, a cute little pig standing proudly in front of a small straw house, soft watercolor, warm colors"}
    data = post_json("/images/generations", body, "image_gen")
    IMG["straw"] = save_image(data, "1_straw_house")
    return f"saved {IMG['straw'].name}"


# 6. Image edit (core feature: straw house -> paper house)
def image_edit():
    body = {"model": "muse-image-1.0", "n": 1,
            "prompt": "change the straw house into a house made of paper and folded origami, keep the pig, style and composition the same",
            "images": [{"image_url": data_url(IMG["straw"])}]}
    data = post_json("/images/edits", body, "image_edit")
    return f"saved {save_image(data, '2_paper_house').name}"


# 7. Image understanding
def vision():
    body = {"model": "muse-spark-1.3", "input": [{"role": "user", "content": [
        {"type": "input_text", "text": "이 그림을 5살 아이에게 설명하듯 한 문장으로 말해줘."},
        {"type": "input_image", "image_url": data_url(IMG["straw"])}]}]}
    return output_text(post_json("/responses", body, "vision"))


# 8. Speech to text (synthesize a Korean child-like answer with macOS `say`)
def asr():
    aiff, wav = OUT / "answer.aiff", OUT / "answer.wav"
    subprocess.run(["say", "-v", "Yuna", "-o", str(aiff), "종이로 만들었어요! 바람이 불면 날아갈 것 같아요."], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(aiff), str(wav)], check=True)
    req = {"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "PUSH_TO_TALK"}
    r = client.post("/asr/transcribe", headers={"Accept": "application/json"},
                    files={"request": (None, json.dumps(req), "application/json"),
                           "audio": ("answer.wav", wav.read_bytes(), "audio/wav")})
    data = r.json() if "json" in r.headers.get("content-type", "") else {"raw": r.text}
    save("asr", data)
    r.raise_for_status()
    return json.dumps(data, ensure_ascii=False)[:400]


# 9. SAM 3.1 segmentation
def sam():
    body = {"model": "sam-3.1", "input": [{"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": "pig"},
        {"type": "input_image", "image_url": data_url(IMG["straw"])}]}]}
    data = post_json("/responses", body, "sam")
    text = output_text(data)
    return f"{len(text)} chars, starts: {text[:200]}"


run("1. models", models)
run("2. muse-spark-1.3 text", spark)
run("3. muse-wonder-1.0 text", wonder)
run("4. chat completions", chat)
run("5. image generation", image_gen)
if "straw" in IMG:
    run("6. image edit (straw->paper)", image_edit)
    run("7. image understanding", vision)
    run("9. SAM 3.1", sam)
run("8. speech to text", asr)

print("\n\n## Summary")
for name, status, secs, _ in results:
    print(f"{status:4}  {secs:6.1f}s  {name}")
