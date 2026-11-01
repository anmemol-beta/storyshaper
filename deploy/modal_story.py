"""The story server (python3 -m src.server: story, pictures, speech, camera) on a Modal CPU container.

    voice/.venv-chatterbox/bin/modal secret create storyshaper-meta --from-dotenv .env   # once: MODEL_API_KEY
    voice/.venv-chatterbox/bin/modal deploy deploy/modal_story.py
    -> https://<workspace>--storyshaper-story.modal.run

The Vercel site (vercel.json) serves prototype/ and forwards /api/* here, so the pages call it from their own
address. Sessions and pictures live in this one container's memory: one container at most, and they are gone
after IDLE_SECONDS without requests (the next visit wakes a new one in about half a minute).
Cost: billed per second only while the container is up.
"""
import os
import subprocess
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
LABEL = "storyshaper-story"
IDLE_SECONDS = 1200
WORKSPACE = os.environ.get("MODAL_WORKSPACE", "shj0213")
PUBLIC_HOSTS = f"{WORKSPACE}--{LABEL}.modal.run,{WORKSPACE}--{LABEL}.us-east.modal.run"
PAGES = r"^https://storyshaper[-a-z0-9]*\.vercel\.app$"     # the Vercel site and its preview builds

image = modal.Image.debian_slim(python_version="3.10").apt_install("ffmpeg").pip_install("pillow==12.0.0")
for package in ("src", "vision", "speech", "story_agent", "media", "narration", "prototype"):
    image = image.add_local_dir(ROOT / package, f"/app/{package}", ignore=["__pycache__", "**/__pycache__"])
app = modal.App(LABEL, image=image)


@app.function(secrets=[modal.Secret.from_name("storyshaper-meta")], max_containers=1,
              scaledown_window=IDLE_SECONDS, timeout=3600)
@modal.concurrent(max_inputs=100)
@modal.web_server(8000, startup_timeout=120, label=LABEL)
def story():
    subprocess.Popen("cd /app && exec python -m src.server --host 0.0.0.0 --port 8000", shell=True,
                     env={**os.environ, "STORY_PUBLIC_HOSTS": PUBLIC_HOSTS, "STORY_PUBLIC_ORIGINS": PAGES})
