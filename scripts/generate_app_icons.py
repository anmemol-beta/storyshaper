"""Generate the simple code-native StoryShaper PWA icon at required sizes."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "prototype" / "icons"


def icon():
    size = 1024
    image = Image.new("RGB", (size, size), "#20313a")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((48, 48, 976, 976), radius=200, fill="#294852")
    draw.ellipse((178, 178, 846, 846), fill="#315963")
    # An open book sits inside the safe area of an Android maskable icon.
    draw.polygon([(230, 410), (496, 438), (496, 742), (230, 709)], fill="#f8efd8")
    draw.polygon([(528, 438), (794, 410), (794, 709), (528, 742)], fill="#fff7e8")
    draw.polygon([(230, 410), (496, 438), (496, 742), (230, 709)], outline="#ecd39b", width=12)
    draw.polygon([(528, 438), (794, 410), (794, 709), (528, 742)], outline="#ecd39b", width=12)
    draw.line([(512, 440), (512, 750)], fill="#d7b967", width=22)
    # A small spark above the page echoes the mark used in the reading UI.
    cx, cy, outer, inner = 512, 310, 105, 45
    points = []
    import math
    for i in range(16):
        angle = -math.pi / 2 + i * math.pi / 8
        radius = outer if i % 2 == 0 else inner
        points.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    draw.polygon(points, fill="#f4c96c")
    draw.ellipse((cx - 20, cy - 20, cx + 20, cy + 20), fill="#fff6d2")
    return image


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    source = icon()
    for size in (192, 512):
        target = OUT / f"storyshaper-{size}.png"
        source.resize((size, size), Image.Resampling.LANCZOS).save(target, "PNG", optimize=True)
        print(target.relative_to(ROOT))
