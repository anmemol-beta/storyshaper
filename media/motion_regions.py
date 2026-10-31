"""Find the wolf, the pigs and the house in every prepared picture with SAM 3.1, for the reader's motion layer.

The reader (prototype/story-motion.js) animates a page in place: wind leaves the wolf's mouth and hits the house,
straw flies off the house, the pigs breathe. SAM 3.1 gives where each of them is. Its boxes are plain text; its masks
need Meta's parser, so the sprites here are soft-edged crops of each box, saved as WebP with alpha. They only move a
few pixels, so the soft edge blends into the same picture underneath.

    python3 -m media.motion_regions --dry-run   # list the pictures and what is looked for
    python3 -m media.motion_regions             # needs MODEL_API_KEY in .env; writes prototype/img/motion/
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFilter

from story_agent.provider import load_env

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "prototype" / "img"
OUT = IMG / "motion"
REGISTRY = Path(__file__).with_name("scene_registry.json")
MODEL = "sam-3.1"
BOX = re.compile(r"<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>")
MOST = {"wolf": 1, "house": 1, "pig": 3}
# A house that has fallen or melted is not "a house" to SAM; these describe what is left of it.
ALSO = {"house": ["pile of wood", "melted ice cream", "ice cream", "ruined house"]}


def targets(entry, asset_key):
    """What to look for in one registry picture: its cast, and the house unless the page shows an empty plot."""
    labels = ["pig"]
    if "wolf" in entry.get("cast", []):
        labels.append("wolf")
    if not asset_key.endswith("/choose"):
        labels.append("house")
    return labels


def boxes(text, size):
    """Boxes from SAM's reply, scaled to the picture, largest first."""
    found = []
    for x1, y1, x2, y2, w, h in BOX.findall(text):
        sx, sy = size[0] / int(w), size[1] / int(h)
        box = [round(int(x1) * sx), round(int(y1) * sy), round(int(x2) * sx), round(int(y2) * sy)]
        if box[2] - box[0] >= 8 and box[3] - box[1] >= 8:
            found.append(box)
    return sorted(found, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)


def segment(api_key, path, label):
    mime = "image/png" if path.suffix == ".png" else "image/jpeg"
    image = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()
    body = {"model": MODEL, "input": [{"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": label}, {"type": "input_image", "image_url": image}]}]}
    request = urllib.request.Request("https://api.meta.ai/v1/responses", json.dumps(body).encode(),
                                     {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = json.load(response)
    return "".join(part.get("text", "") for item in data.get("output", [])
                   for part in item.get("content") or [] if isinstance(part, dict))


def sprite(picture, box, target, holes=()):
    """A soft-edged crop of the box. Sides on the picture's edge stay hard so the sprite meets the frame.
    holes: boxes of things standing in front (a pig before the house); they are left out so they don't move with it."""
    width, height = picture.size
    x1, y1, x2, y2 = box
    pad = round(0.06 * max(x2 - x1, y2 - y1))
    x1, y1, x2, y2 = max(0, x1 - pad), max(0, y1 - pad), min(width, x2 + pad), min(height, y2 + pad)
    crop = picture.crop((x1, y1, x2, y2)).convert("RGBA")
    feather = max(4, round(0.12 * min(x2 - x1, y2 - y1)))
    inset = [-feather * 2 if x1 == 0 else feather, -feather * 2 if y1 == 0 else feather,
             crop.width + (feather * 2 if x2 == width else -feather), crop.height + (feather * 2 if y2 == height else -feather)]
    mask = Image.new("L", crop.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(inset, radius=feather * 2, fill=255)
    for hx1, hy1, hx2, hy2 in holes:
        draw.rounded_rectangle([hx1 - x1, hy1 - y1, hx2 - x1, hy2 - y1], radius=feather, fill=0)
    crop.putalpha(mask.filter(ImageFilter.GaussianBlur(feather / 2)))
    crop.save(target, "WEBP", quality=84, method=6)
    return [x1, y1, x2, y2]


def write_sprites(manifest, files):
    """(Re)make the WebP sprites of these pictures from their saved boxes. No SAM requests."""
    for file in files:
        record = manifest["images"][file]
        front = [o["box"] for o in record["objects"] if o["label"] in ("pig", "wolf")]
        with Image.open(IMG / file) as picture:
            picture.load()
            counts = {}
            for item in record["objects"]:
                index = counts[item["label"]] = counts.get(item["label"], -1) + 1
                name = f"{Path(file).stem}.{item['label']}{index or ''}.webp"
                item["spriteBox"] = sprite(picture, item["box"], OUT / name, front if item["label"] == "house" else ())
                item["sprite"] = f"motion/{name}"


def save(manifest):
    manifest["model"] = MODEL
    manifest["images"] = dict(sorted(manifest["images"].items()))
    # One picture per block and one object per line, so a review diff stays readable.
    blocks = []
    for file, record in manifest["images"].items():
        objects = ",\n".join("      " + json.dumps(o, ensure_ascii=False) for o in record["objects"])
        blocks.append(f'    {json.dumps(file)}: {{"size": {json.dumps(record["size"])}, "objects": [\n{objects}\n    ]}}')
    text = '{\n  "model": "%s",\n  "images": {\n%s\n  }\n}\n' % (MODEL, ",\n".join(blocks))
    (OUT / "regions.json").write_text(text, encoding="utf-8")
    print(f"{(OUT / 'regions.json').relative_to(ROOT)}: {len(manifest['images'])} pictures. Look at every sprite before committing.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sprites-only", action="store_true", help="remake the WebP sprites from the saved boxes")
    parser.add_argument("--only", nargs="*", help="picture files, e.g. wolf_straw.jpg")
    args = parser.parse_args()
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))["images"]
    pictures = {}
    for key, entry in registry.items():
        labels = pictures.setdefault(entry["file"], set())
        labels.update(targets(entry, key))
    if args.only:
        pictures = {file: labels for file, labels in pictures.items() if file in args.only}
    jobs = [(file, label) for file, labels in sorted(pictures.items()) for label in sorted(labels)]
    if args.dry_run:
        for file, labels in sorted(pictures.items()):
            print(f"{file}: {', '.join(sorted(labels))}")
        print(f"{len(jobs)} SAM requests")
        return
    manifest_path = OUT / "regions.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"images": {}}
    if args.sprites_only:
        write_sprites(manifest, [file for file in pictures if file in manifest["images"]])
        save(manifest)
        return
    load_env(ROOT / ".env")
    api_key = os.environ["MODEL_API_KEY"]
    OUT.mkdir(exist_ok=True)

    def find(job):
        file, label = job
        started = time.time()
        with Image.open(IMG / file) as picture:
            size = picture.size
        found = boxes(segment(api_key, IMG / file, label), size)[:MOST[label]]
        for prompt in ALSO.get(label, []) if not found else []:
            # What is left of a house is many pieces; together they cover where it stood.
            pieces = boxes(segment(api_key, IMG / file, prompt), size)
            if pieces:
                found = [[min(b[0] for b in pieces), min(b[1] for b in pieces), max(b[2] for b in pieces), max(b[3] for b in pieces)]]
                break
        print(f"{time.time() - started:5.1f}s  {file} {label}: {len(found)}", flush=True)
        return file, label, size, found

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(find, jobs))
    for file in pictures:
        manifest["images"].pop(file, None)
    for file, label, size, found in results:
        record = manifest["images"].setdefault(file, {"size": list(size), "objects": []})
        record["objects"].extend({"label": label, "box": box} for box in found)
    write_sprites(manifest, list(pictures))
    save(manifest)


if __name__ == "__main__":
    main()
