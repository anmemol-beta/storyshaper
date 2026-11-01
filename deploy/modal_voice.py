"""The parent-voice narration server (narration/server.py) on a Modal GPU (L4, else A10G or T4).

    voice/.venv-chatterbox/bin/modal deploy deploy/modal_voice.py
    -> https://<workspace>--storyshaper-voice.us-east.modal.run   (open pages with ?voiceServer=<that URL>)

Every page and every computer then hears the same voices at the same speed, without installing Chatterbox.
Voices, made lines and the downloaded models live on the "storyshaper-voice" Volume, so they survive the
container shutting down. One container at most: the server keeps one queue and writes one cache.
Cost: billed per second only while the container is up; it shuts down after IDLE_SECONDS without requests.
"""
import os
import subprocess
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parent.parent
LABEL = "storyshaper-voice"
IDLE_SECONDS = 300
WORKSPACE = os.environ.get("MODAL_WORKSPACE", "shj0213")
PUBLIC_HOSTS = f"{WORKSPACE}--{LABEL}.us-east.modal.run,{WORKSPACE}--{LABEL}.modal.run"   # what `modal deploy` prints

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg")
    .pip_install("chatterbox-tts==0.1.7", "librosa==0.11.0", "soundfile==0.14.0")
    .add_local_dir(ROOT / "narration", "/app/narration", ignore=["__pycache__"])
    .add_local_dir(ROOT / "story_agent", "/app/story_agent", ignore=["__pycache__"])
    .add_local_file(ROOT / "prototype/audio/training-sentences.json", "/app/prototype/audio/training-sentences.json")
    .add_local_file(ROOT / "voice/ref_clip.wav", "/app/voice/ref_clip.wav")
    .add_local_dir(ROOT / "voice/characters", "/app/voice/characters")
)
volume = modal.Volume.from_name("storyshaper-voice", create_if_missing=True)
app = modal.App(LABEL, image=image)


# L4 first; A10G or T4 when Modal has no L4 free (seen 10/31: the server waited minutes for an L4).
@app.function(gpu=["L4", "A10G", "T4"], volumes={"/data": volume}, max_containers=1, scaledown_window=IDLE_SECONDS, timeout=3600)
@modal.concurrent(max_inputs=50)
@modal.web_server(8100, startup_timeout=600, label=LABEL)
def voice():
    subprocess.Popen(
        "mkdir -p /data/cache /data/profiles /data/models"
        " && ln -sfn /data/cache /app/voice/cache && ln -sfn /data/profiles /app/voice/profiles"
        " && cd /app && exec python -m narration.server --host 0.0.0.0 --port 8100",
        shell=True,
        env={**os.environ, "HF_HOME": "/data/models", "NARRATION_PUBLIC_HOSTS": PUBLIC_HOSTS},
    )
