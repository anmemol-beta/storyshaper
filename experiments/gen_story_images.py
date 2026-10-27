"""Generate the full Three Little Pigs page set for the prototype with Muse Image.

Every page is an edit of an earlier page so style and characters stay consistent.
Needs experiments/out/1_straw_house.webp and 2_paper_house.webp (api_smoke_test.py),
and experiments/out/ref_wolf.webp as the wolf character reference.
Delete experiments/out/story_<name>.webp to regenerate a page.
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
# Appended to every prompt so the pigs' props stay consistent; each page says who is in it.
CAST = (" How the pigs look: the oldest pig is plain pink with no clothes or accessories;"
        " the middle pig wears a knitted blue beanie; the youngest pig wears a red bandana.")
WOLF = ("the grey cartoon wolf from the second image (no clothes, hats or goggles), with big puffed cheeks,"
        " blowing a strong gust of wind")
SURPRISED = "looking surprised with a round open mouth"
WORRIED = "worried faces with a frown, eyebrows tilted up and the corners of the mouth turned down"

# name: (source page, edit prompt). Sources must be generated in an earlier wave.
PAGES = [
    {"empty1": ("straw", "Remove the straw house completely, leaving an empty sunny grassy plot with a small pile of building materials behind the pig."),
     "intro": ("straw", "Change the scene: a mother pig in an apron waving goodbye to the three little pigs carrying small bundles on sticks, in front of a cozy cottage. In this picture: the mother pig and the three little pigs only, no other animals. The pigs look excited and a little nervous about leaving home."),
     "wolf_paper": ("paper", f"Add {WOLF} from the left; the paper roof is lifting off the house and paper sheets are fluttering away like leaves in the breeze; the little pig is holding onto its ears, {SURPRISED}. In this picture: only the oldest pig and the wolf.", ["wolf"]),
     "wolf_straw": ("straw", f"Add {WOLF} from the left; the straw roof is lifting off the house and bundles of straw are fluttering away like leaves in the breeze; the little pig is holding onto its ears, {SURPRISED}. In this picture: only the oldest pig and the wolf.", ["wolf"])},
    {"pig2_empty": ("empty1", "Make the pig wear a small blue cap, and change the background to the edge of a forest with a pile of wooden logs."),
     "pig3_empty": ("empty1", "Make the pig wear a red bandana, and put a neat stack of red bricks and a bucket of mortar behind the pig.")},
    {"wood": ("pig2_empty", "Build a small cozy wooden log cabin behind the pig with the blue cap, using the logs."),
     "brick": ("pig3_empty", "Build a sturdy red brick house with a chimney behind the pig with the red bandana, using the bricks.")},
    {"wolf_wood": ("wood", f"Add {WOLF} from the left. The wooden cabin has tumbled into a messy pile of logs. Two little pigs hurry away toward the right, looking back over their shoulders with {WORRIED}. In this picture: only the middle pig in the blue beanie, the plain oldest pig, and the wolf.", ["wolf"]),
     "brick_empty": ("brick", "Remove the pig from the yard so the yard in front of the brick house is empty. Keep the house, bucket and everything else the same."),
     "ending": ("brick", "Three little pigs (one with a blue cap, one with a red bandana) dancing happily in front of the brick house; a tiny wolf is walking away over a far hill, scratching his head.")},
    {"wolf_brick": ("brick_empty", f"Add {WOLF} from the left, his face turning red from the effort. The brick house stands firm, not a single brick moves. The yard stays empty. All three little pigs are inside the house, peeking out of the window with nervous but hopeful faces. In this picture: the three pigs in the window and the wolf, no pig outside.", ["wolf"])},
]

src = {"straw": OUT / "1_straw_house.webp", "paper": OUT / "2_paper_house.webp", "wolf": OUT / "ref_wolf.webp"}


def edit(name, source, prompt, refs=()):
    path = OUT / f"story_{name}.webp"
    if path.exists():
        return name, path
    images = [{"image_url": "data:image/webp;base64," + base64.b64encode(src[s].read_bytes()).decode()}
              for s in (source, *refs)]
    t = time.time()
    # The content filter is inconsistent on the same prompt (rejections are not billed), so retry a few times,
    # dropping the cast notes on the later tries.
    for attempt, text in enumerate([prompt + CAST + KEEP] * 2 + [prompt + KEEP] * 2):
        r = client.post("/images/edits", json={"model": "muse-image-1.0", "prompt": text, "images": images})
        if r.status_code == 200:
            break
        print(f"  {name}: attempt {attempt + 1} rejected ({r.json().get('error', {}).get('code')})", flush=True)
    else:
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
