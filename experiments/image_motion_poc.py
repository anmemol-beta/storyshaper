#!/usr/bin/env python3
"""Local 1-image -> short MP4 motion POC, explicitly NOT generative AI video.

Produces a moving-camera animation from a still illustration. It is a visual
fallback / interface fixture only; no characters, buildings or events move.
Requires ffmpeg+ffprobe. It does not alter media/scene_registry.json.
"""
import argparse
import json
import subprocess
from pathlib import Path

def run(source: Path, target: Path, seconds: int, fps: int) -> dict:
    if not source.is_file():
        raise FileNotFoundError(source)
    if not 1 <= seconds <= 12 or not 12 <= fps <= 60:
        raise ValueError("seconds must be 1..12 and fps 12..60")
    if target.suffix.lower() != ".mp4":
        raise ValueError("Output must have an .mp4 extension")
    target.parent.mkdir(parents=True, exist_ok=True)
    frames = seconds * fps
    # zoompan uses exactly one picture and generates frames with a gentle
    # camera zoom. Does not pretend to be a model-generated character motion.
    vf = (
        "scale=1280:720:force_original_aspect_ratio=increase,"
        "crop=1280:720,"
        f"zoompan=z='min(zoom+0.00075,1.16)':d={frames}:"
        "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
        f"s=1280x720:fps={fps},"
        "format=yuv420p"
    )
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-loop", "1", "-i", str(source), "-vf", vf,
        "-frames:v", str(frames), "-an", "-c:v", "libx264",
        "-crf", "25", "-preset", "veryfast", "-movflags", "+faststart",
        str(target)
    ], check=True)
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration:stream=codec_name,width,height",
        "-of", "json", str(target)
    ], text=True, capture_output=True, check=True)
    result = json.loads(probe.stdout)
    video = next((s for s in result.get("streams", []) if s.get("codec_name") == "h264"), None)
    if not video:
        raise RuntimeError("MP4 output failed H.264 validation")
    return {"input": str(source), "output": str(target), "mode": "static_camera_motion",
            "ai_generated": False, "duration": float(result["format"]["duration"]),
            "codec": video["codec_name"], "width": video["width"], "height": video["height"]}

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("image", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--seconds", type=int, default=4)
    p.add_argument("--fps", type=int, default=24)
    args = p.parse_args()
    print(json.dumps(run(args.image,args.output,args.seconds,args.fps),ensure_ascii=False,indent=2))

if __name__ == "__main__":
    main()
