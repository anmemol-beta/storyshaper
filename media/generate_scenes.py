"""Pre-generate every scene picture the story agent can reach, with Muse Image.

The agent only accepts authored materials (story_agent/story.json), so the pictures are a finite
set: for each house and allowed material, the finished house (build) and what happens to it
(the material's outcome). Pictures already in scene_registry.json are kept. Missing ones are made
by editing an existing page, as experiments/gen_story_images.py made the book, so the style and
the pigs stay the same. Made ahead of time, no child waits for a redraw, and a person looks at
every picture before it is committed.

    python3 -m media.generate_scenes --dry-run    # list what is missing and the prompts
    python3 -m media.generate_scenes              # needs MODEL_API_KEY in .env; writes prototype/img/scenes/
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

from story_agent.engine import STORY
from story_agent.provider import load_env

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "prototype" / "img"
REGISTRY = Path(__file__).with_name("scene_registry.json")
MODEL = "muse-image-1.0"

# Shared wording from experiments/gen_story_images.py, which made the existing pages.
KEEP = " Keep the same soft watercolor children's picture book style, warm colors and composition."
# Describe only the pigs on the page: naming all three makes the model draw all three.
LOOKS = {"pig1": "the oldest pig is plain pink with no clothes or accessories",
         "pig2": "the middle pig wears a knitted blue beanie", "pig3": "the youngest pig wears a red bandana"}
ONLY = " Draw no other pigs."
WOLF = "the grey cartoon wolf from the second image (only the wolf, no clothes, hats or goggles)"
SURPRISED = "looking surprised with a round open mouth"
WORRIED = "worried faces with a frown, eyebrows tilted up and the corners of the mouth turned down"
WOLF_REF = "wolf_paper.jpg"

WALLS = {
    "paper": "folded paper and origami sheets",
    "straw": "bundles of golden straw tied together",
    "wood": "wooden logs stacked loosely, with gaps at the joints",
    "cookie": "big round cookies and biscuits, like a gingerbread house",
    "icecream": "colorful scoops and blocks of ice cream, glistening in the warm sun",
    "stone": "heavy grey stones joined with mortar",
}
# Who is on each house's pages. After the first house falls, the oldest pig joins the middle one.
HOUSES = {
    "house1": {"builder": "the plain pink pig", "pigs": "the plain pink oldest pig",
               "build_cast": ["pig1"], "event_cast": ["pig1"]},
    "house2": {"builder": "the pig with the blue cap",
               "pigs": "the middle pig in the blue beanie and the plain pink oldest pig",
               "build_cast": ["pig2"], "event_cast": ["pig1", "pig2"]},
    "house3": {"builder": "the pig with the red bandana", "pigs": "all three pigs",
               "build_cast": ["pig3"], "event_cast": ["pig1", "pig2", "pig3", "wolf"]},
}


def recipe(house, material, action, registry):
    """(source file, prompt, extra reference files, cast) for one missing picture."""
    who, walls = HOUSES[house], WALLS[material]
    if house == "house3":
        # The brick pages already show the right cast and layout; only the walls change.
        source = registry[f"house3/brick/{action}"]["file"]
        return source, (f"Change the red brick house into a sturdy house of {walls}, keeping its shape, roof, "
                        "chimney, door and windows. Keep the pigs, the wolf if there is one, and everything else "
                        "exactly the same."), [], registry[f"house3/brick/{action}"]["cast"]
    if action == "build":
        return registry[f"{house}/choose"]["file"], (
            f"Behind {who['builder']}, build a small cozy house made of {walls}. "
            f"In this picture: only {who['builder']}."), [], who["build_cast"]
    source = registry[f"{house}/{material}/build"]["file"]
    joins = " Add the plain pink oldest pig next to the pig in the blue beanie." if house == "house2" else ""
    if action == "blown_away":
        text = (f"Add {WOLF} from the left, with big puffed cheeks, blowing a strong gust of wind; the {material} "
                f"walls are lifting off and fluttering away like leaves in the breeze.{joins} Show {who['pigs']} "
                f"stepping back, {SURPRISED}.")
    elif action == "collapsed":
        text = (f"Add {WOLF} from the left, with big puffed cheeks, blowing a strong gust of wind. The loosely "
                f"stacked log house has tumbled into a messy pile of logs.{joins} Show {who['pigs']} "
                f"hurrying away toward the right, looking back over their shoulders with {WORRIED}.")
    elif action == "eaten":
        text = (f"Add {WOLF} from the left, happily taking a big bite out of the cookie wall; the cookie house "
                f"has big bite marks and holes and is crumbling.{joins} Show {who['pigs']} "
                f"walking away safely toward the right, looking back with {WORRIED}.")
    elif action == "melted":
        text = (f"Make the sun big, bright and warm. The ice cream house is melting into a colorful puddle, with "
                f"drips running down its walls.{joins} Show {who['pigs']} "
                f"standing safely to the side, {SURPRISED}. "
                "No wolf in this picture.")
    else:
        raise ValueError(f"no recipe for {house}/{material}/{action}")
    refs = [] if action == "melted" else [WOLF_REF]
    cast = who["event_cast"] + ([] if action == "melted" else ["wolf"])
    text += " Keep the background, the trees and the house's position the same."
    return source, f"{text} In this picture: only {who['pigs']}" + (" and the wolf." if refs else "."), refs, cast


def missing(registry):
    """Asset keys the agent can produce that have no picture yet, builds before their events."""
    keys = []
    for index, house in enumerate(STORY["houses"], 1):
        for material in house["allowedMaterials"]:
            for action in ("build", STORY["materials"][material]["outcome"]):
                key = f"house{index}/{material}/{action}"
                if key not in registry:
                    keys.append(key)
    return sorted(keys, key=lambda key: key.endswith("/build"), reverse=True)


def data_url(path):
    kind = "jpeg" if path.suffix == ".jpg" else path.suffix[1:]
    return f"data:image/{kind};base64," + base64.b64encode(path.read_bytes()).decode()


def edit(api_key, source, prompt, refs, cast):
    """One Muse Image edit, as a 1024 px JPEG like the rest of the book."""
    images = [{"image_url": data_url(IMG / name)} for name in (source, *refs)]
    looks = " How the pigs look: " + "; ".join(LOOKS[who] for who in cast if who in LOOKS) + "."
    # The content filter is inconsistent on the same prompt (experiments/gen_story_images.py),
    # so retry, dropping the looks on the later tries.
    for attempt, text in enumerate([prompt + looks + ONLY + KEEP] * 2 + [prompt + ONLY + KEEP] * 2, 1):
        body = json.dumps({"model": MODEL, "prompt": text, "images": images}).encode()
        request = urllib.request.Request("https://api.meta.ai/v1/images/edits", data=body, method="POST",
                                         headers={"Authorization": "Bearer " + api_key,
                                                  "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                webp = base64.b64decode(json.loads(response.read())["data"][0]["b64_json"])
            break
        except urllib.error.HTTPError as exc:
            code = json.loads(exc.read() or b"{}").get("error", {}).get("code")
            print(f"  attempt {attempt} rejected: HTTP {exc.code} {code}", flush=True)
    else:
        raise RuntimeError(f"Muse Image rejected every attempt for {source}")
    return subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "webp_pipe", "-i", "pipe:0",
                           "-vf", "scale=1024:-1", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
                          input=webp, capture_output=True, check=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print the plan; no API calls")
    parser.add_argument("--only", nargs="*", help="asset keys to (re)make, e.g. house1/cookie/eaten")
    args = parser.parse_args()
    data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    registry = data["images"]
    keys = args.only or missing(registry)
    if args.dry_run:
        for key in keys:
            house, material, action = key.split("/")
            if action != "build" and f"{house}/{material}/build" not in registry:
                registry[f"{house}/{material}/build"] = {"file": f"scenes/{house}_{material}_build.jpg"}
            source, prompt, refs, cast = recipe(house, material, action, registry)
            print(f"{key}\n  from {source} + {refs} cast {cast}\n  {prompt}\n")
        return
    load_env(ROOT / ".env")
    api_key = os.environ["MODEL_API_KEY"]
    (IMG / "scenes").mkdir(exist_ok=True)

    def make(key):
        house, material, action = key.split("/")
        source, prompt, refs, cast = recipe(house, material, action, registry)
        started = time.time()
        (IMG / "scenes" / f"{house}_{material}_{action}.jpg").write_bytes(edit(api_key, source, prompt, refs, cast))
        print(f"{time.time() - started:5.1f}s  {key}", flush=True)
        return key, {"file": f"scenes/{house}_{material}_{action}.jpg", "cast": cast, "model": MODEL}

    # Builds first: each event page is an edit of its own build page.
    for wave in ([key for key in keys if key.endswith("/build")], [key for key in keys if not key.endswith("/build")]):
        with ThreadPoolExecutor(max_workers=4) as pool:
            for key, entry in pool.map(make, wave):
                registry[key] = entry
    data["revision"] += 1
    # One entry per line, as the file is written by hand.
    rows = ",\n".join(f"    {json.dumps(key)}: {json.dumps(entry, ensure_ascii=False)}" for key, entry in registry.items())
    REGISTRY.write_text(f'{{\n  "revision": {data["revision"]},\n  "images": {{\n{rows}\n  }},\n'
                        f'  "clips": {json.dumps(data["clips"])}\n}}\n', encoding="utf-8")
    print(f"registry revision {data['revision']}: {len(keys)} pictures. Look at every one before committing.")


if __name__ == "__main__":
    main()
