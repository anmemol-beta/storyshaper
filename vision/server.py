"""Story agent + live images + voice + camera answers on one server: python -m vision.server.

Adds POST /api/see?language=en|ko to speech.server. The body is one camera frame (JPEG, PNG or
WebP); the reply is {"object": "<name>"} or {"object": ""} when no single thing is clearly shown.
Frames are sent to Muse Spark and never stored or logged here.
"""
import argparse
from http.server import ThreadingHTTPServer
import os
import shutil
from urllib.parse import parse_qs, urlsplit

from speech.server import SpeechHandler, SpeechPlayground
from media.jobs import MediaJobs
from media.image_provider import MuseImageProvider
from speech.transcribe import MuseTranscriber
from story_agent.provider import load_env
from story_agent.server import ROOT, APIError
from .see import IMAGE_TYPES, MuseVision, VisionError

# The page sends one frame of at most 768 px, about 100 KB as JPEG.
MAX_IMAGE = 4 * 1024 * 1024


class VisionPlayground(SpeechPlayground):
    def __init__(self, *args, vision=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.vision = vision

    def config(self):
        return {**super().config(), "visionAvailable": self.vision is not None}

    def see(self, image, content_type, language):
        """Name of the object in one frame. Errors here are service problems and never count
        against the child; an empty name is not an answer either, the page asks to show it again."""
        if self.vision is None:
            raise APIError(503, "missing_api_key", "Set MODEL_API_KEY on the server to use the camera.")
        try:
            return {"object": self.vision.name_object(image, content_type, language)}
        except VisionError as exc:
            code = str(exc)
            raise APIError(429 if code == "vision_rate_limited" else 502, code,
                           "The camera answer is unavailable right now. Try again or answer another way.")


class VisionHandler(SpeechHandler):
    def do_POST(self):
        parts = urlsplit(self.path)
        if parts.path != "/api/see":
            return super().do_POST()
        try:
            self.guard()
            language = parse_qs(parts.query).get("language", ["en"])[0]
            if language not in ("en", "ko"):
                raise APIError(400, "language", "language must be en or ko.")
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type not in IMAGE_TYPES:
                raise APIError(415, "content_type", "Send a JPEG, PNG or WebP image.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise APIError(400, "invalid_length", "Invalid request size.")
            if not 0 < length <= MAX_IMAGE:
                raise APIError(413, "body_size", "An image must be between 1 byte and 4 MB.")
            self.reply(200, self.server.playground.see(self.rfile.read(length), content_type, language))
        except APIError as exc:
            self.error(exc)


class VisionServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, playground):
        self.playground = playground
        super().__init__(address, VisionHandler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    assert shutil.which("ffmpeg"), "ffmpeg converts browser recordings to WAV; install it first (brew install ffmpeg)."
    load_env(ROOT / ".env")
    key = os.environ.get("MODEL_API_KEY", "")
    model = os.environ.get("STORY_AGENT_MODEL", "muse-spark-1.3")
    app = VisionPlayground(key, model, transcriber=MuseTranscriber(key) if key else None,
                           vision=MuseVision(key, model) if key else None,
                           media=MediaJobs(image_provider=MuseImageProvider(key) if key else None))
    try:
        with VisionServer(("127.0.0.1", args.port), app) as server:
            print(f"Story + media + speech + camera: http://127.0.0.1:{server.server_port}/prototype/agent.html", flush=True)
            print("Camera, speech and live story: " + ("configured" if key else "not configured; set MODEL_API_KEY in .env"), flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.media.close()


if __name__ == "__main__":
    main()
