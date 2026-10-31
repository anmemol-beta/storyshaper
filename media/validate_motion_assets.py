"""Check prepared motion sprites before they are used in the reader.

Run ``python -m media.validate_motion_assets`` after ``media.motion_regions``.
This checks file integrity and coverage; a person must still review the cutouts
and the motion in a browser for seams, duplicated backgrounds, and story fit.
"""

import json
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from media.motion_regions import IMG, OUT, REGISTRY, targets


def validate(registry_path=REGISTRY, manifest_path=OUT / "regions.json", image_root=IMG):
    errors = []
    registry = json.loads(Path(registry_path).read_text(encoding="utf-8"))["images"]
    expected = {}
    for key, entry in registry.items():
        expected.setdefault(entry["file"], set()).update(targets(entry, key))

    if not Path(manifest_path).is_file():
        return [f"missing manifest: {manifest_path}"]
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    records = manifest.get("images", {})
    for file in sorted(expected.keys() - records.keys()):
        errors.append(f"{file}: no region record")
    for file in sorted(records.keys() - expected.keys()):
        errors.append(f"{file}: picture is not in the scene registry")

    for file, record in records.items():
        if file not in expected:
            continue
        source = image_root / file
        if not source.is_file():
            errors.append(f"{file}: source picture is missing")
            continue
        try:
            with Image.open(source) as image:
                size = image.size
        except (OSError, UnidentifiedImageError) as exc:
            errors.append(f"{file}: source picture cannot be decoded: {exc}")
            continue
        if record.get("size") != list(size):
            errors.append(f"{file}: manifest dimensions differ from source {size}")
        found = {obj.get("label") for obj in record.get("objects", [])}
        for label in sorted(expected[file] - found):
            errors.append(f"{file}: {label} region is missing")
        for index, obj in enumerate(record.get("objects", [])):
            label = obj.get("label", "?")
            name = f"{file} [{index}] {label}"
            if label not in expected[file]:
                errors.append(f"{name}: label is not expected for this picture")
            box = obj.get("box")
            sprite_box = obj.get("spriteBox")
            if not all(isinstance(b, list) and len(b) == 4 and all(isinstance(n, int) for n in b)
                       and 0 <= b[0] < b[2] <= size[0] and 0 <= b[1] < b[3] <= size[1]
                       for b in (box, sprite_box)):
                errors.append(f"{name}: invalid region or sprite bounds")
                continue
            if not (sprite_box[0] <= box[0] < box[2] <= sprite_box[2]
                    and sprite_box[1] <= box[1] < box[3] <= sprite_box[3]):
                errors.append(f"{name}: sprite crop does not contain the detected region")
            rel = obj.get("sprite", "")
            if not isinstance(rel, str) or not rel.startswith("motion/") or Path(rel).suffix.lower() != ".webp":
                errors.append(f"{name}: invalid sprite path")
                continue
            sprite = image_root / rel
            if not sprite.is_file() or sprite.stat().st_size == 0:
                errors.append(f"{name}: sprite file is missing or empty ({rel})")
                continue
            try:
                with Image.open(sprite) as image:
                    image.load()
                    if image.format != "WEBP":
                        errors.append(f"{name}: sprite is not WebP")
                    crop_size = (sprite_box[2] - sprite_box[0], sprite_box[3] - sprite_box[1])
                    if image.size != crop_size:
                        errors.append(f"{name}: sprite dimensions {image.size} differ from crop {crop_size}")
                    if "A" not in image.getbands():
                        errors.append(f"{name}: sprite has no alpha channel")
                    else:
                        minimum, maximum = image.getchannel("A").getextrema()
                        if minimum == 255:
                            errors.append(f"{name}: sprite has no transparent pixels")
                        if maximum == 0:
                            errors.append(f"{name}: sprite is fully transparent")
            except (OSError, UnidentifiedImageError) as exc:
                errors.append(f"{name}: sprite cannot be decoded: {exc}")
    return errors


if __name__ == "__main__":
    problems = validate()
    if problems:
        print(f"Motion asset validation failed ({len(problems)} issues):")
        for problem in problems:
            print(f"- {problem}")
        raise SystemExit(1)
    print("Motion asset files, dimensions, alpha, and scene coverage are valid. Visual review is still required.")
