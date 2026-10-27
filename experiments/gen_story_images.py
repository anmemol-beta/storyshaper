"""Generate the full Three Little Pigs page set for the prototype with Muse Image.

Every page is an edit of an earlier page so style and characters stay consistent.
Needs experiments/out/1_straw_house.webp and 2_paper_house.webp (api_smoke_test.py).
    python3 experiments/gen_story_images.py
Writes 1024px JPEGs to prototype/img/.
"""
import base64
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "experiments" / "out"
IMG = ROOT / "prototype" / "img"
for line in (ROOT / ".env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"'))

client = httpx.Client(base_url="https://api.meta.ai/v1", timeout=300,
                      headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"})
KEEP = " Keep the same soft watercolor children's picture book style, warm colors and composition."
WOLF = "a friendly, goofy cartoon wolf character with big puffed cheeks blowing a gust of wind"

# name: (source page, edit prompt). Sources must be generated in an earlier wave.
PAGES = [
    {"empty1": ("straw", "Remove the straw house completely, leaving an empty sunny grassy plot with a small pile of building materials behind the pig."),
     "intro": ("straw", "Change the scene: a mother pig in an apron waving goodbye to three little pigs carrying small bundles on sticks, in front of a cozy cottage."),
     "wolf_paper": ("paper", f"Add {WOLF} from the left; the sheets of the paper house are fluttering away like leaves in the breeze and the little pig is holding onto its ears, looking surprised."),
     "wolf_straw": ("straw", f"Add {WOLF} from the left; bits of straw from the house are fluttering away like leaves in the breeze and the little pig is holding onto its ears, looking surprised.")},
    {"pig2_empty": ("empty1", "Make the pig wear a small blue cap, and change the background to the edge of a forest with a pile of wooden logs."),
     "pig3_empty": ("empty1", "Make the pig wear a red bandana, and put a neat stack of red bricks and a bucket of mortar behind the pig.")},
    {"wood": ("pig2_empty", "Build a small cozy wooden log cabin behind the pig with the blue cap, using the logs."),
     "brick": ("pig3_empty", "Build a sturdy red brick house with a chimney behind the pig with the red bandana, using the bricks.")},
    {"wolf_wood": ("wood", f"Add {WOLF} from the left; the wooden cabin has tumbled into a neat pile of logs and two little pigs, one with a blue cap, are skipping off together toward the right."),
     "wolf_brick": ("brick", f"Add {WOLF} from the left, his face turning red from trying; the brick house stands firm and three little pigs are peeking out of the window, smiling."),
     "ending": ("brick", "Three little pigs (one with a blue cap, one with a red bandana) dancing happily in front of the brick house; a tiny wolf is walking away over a far hill, scratching his head.")},
]

src = {"straw": OUT / "1_straw_house.webp", "paper": OUT / "2_paper_house.webp"}


def edit(name, source, prompt):
    path = OUT / f"story_{name}.webp"
    if path.exists():
        return name, path
    data = "data:image/webp;base64," + base64.b64encode(src[source].read_bytes()).decode()
    t = time.time()
    r = client.post("/images/edits", json={"model": "muse-image-1.0", "prompt": prompt + KEEP,
                                          "images": [{"image_url": data}]})
    if r.status_code != 200:
        raise RuntimeError(f"{name}: HTTP {r.status_code} {r.text[:400]}")
    path.write_bytes(base64.b64decode(r.json()["data"][0]["b64_json"]))
    print(f"{time.time() - t:5.1f}s  {name}", flush=True)
    return name, path


for wave in PAGES:
    with ThreadPoolExecutor() as ex:
        for name, path in ex.map(lambda kv: edit(kv[0], *kv[1]), wave.items()):
            src[name] = path

IMG.mkdir(parents=True, exist_ok=True)
for name in [n for wave in PAGES for n in wave]:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src[name]),
                    "-vf", "scale=1024:-1", "-q:v", "5", str(IMG / f"{name}.jpg")], check=True)
print("saved to", IMG)
