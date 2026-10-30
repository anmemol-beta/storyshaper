"""Story agent + local media + push-to-talk answers on one server: python -m speech.server.

Unlike media.server, this reads MODEL_API_KEY from .env, because speech recognition needs it.
The same key also enables the live story mode.
"""
import argparse
from http.server import ThreadingHTTPServer
import os
import shutil
from urllib.parse import urlsplit

from media.server import MediaHandler, MediaPlayground
from story_agent.provider import load_env
from story_agent.server import ROOT, APIError
from .transcribe import AUDIO_TYPES, MIN_SPEECH_MS, MuseTranscriber, SpeechError, duration_ms, to_wav

# One answer is at most 8 s (the page stops recording there); 2 MB holds even uncompressed WAV.
MAX_AUDIO = 2 * 1024 * 1024


class SpeechPlayground(MediaPlayground):
    def __init__(self, *args, transcriber=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.transcriber = transcriber

    def config(self):
        return {**super().config(), "speechAvailable": self.transcriber is not None}

    def transcribe(self, raw, content_type):
        """Text of one recorded answer. An empty transcript means nothing was heard: the page sends it
        as the answer so the story counts a missed try. Errors here are service problems and never
        count against the child."""
        if self.transcriber is None:
            raise APIError(503, "missing_api_key", "Set MODEL_API_KEY on the server to use the microphone.")
        try:
            wav_bytes = to_wav(raw, content_type)
            if duration_ms(wav_bytes) < MIN_SPEECH_MS:
                return {"transcript": ""}
            return {"transcript": self.transcriber.transcribe(wav_bytes)}
        except SpeechError as exc:
            code = str(exc)
            if code == "audio_unreadable":
                raise APIError(400, code, "The recording could not be read. Please record again.")
            raise APIError(429 if code == "speech_rate_limited" else 502, code,
                           "Speech recognition is unavailable right now. Try again or answer another way.")


class SpeechHandler(MediaHandler):
    def do_POST(self):
        if urlsplit(self.path).path != "/api/transcribe":
            return super().do_POST()
        try:
            self.guard()
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type not in AUDIO_TYPES:
                raise APIError(415, "content_type", "Send a WebM, Ogg, MP4 or WAV recording.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise APIError(400, "invalid_length", "Invalid request size.")
            if not 0 < length <= MAX_AUDIO:
                raise APIError(413, "body_size", "A recording must be between 1 byte and 2 MB.")
            self.reply(200, self.server.playground.transcribe(self.rfile.read(length), content_type))
        except APIError as exc:
            self.error(exc)


class SpeechServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, playground):
        self.playground = playground
        super().__init__(address, SpeechHandler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    assert shutil.which("ffmpeg"), "ffmpeg converts browser recordings to WAV; install it first (brew install ffmpeg)."
    load_env(ROOT / ".env")
    key = os.environ.get("MODEL_API_KEY", "")
    app = SpeechPlayground(key, os.environ.get("STORY_AGENT_MODEL", "muse-spark-1.3"),
                           transcriber=MuseTranscriber(key) if key else None)
    try:
        with SpeechServer(("127.0.0.1", args.port), app) as server:
            print(f"Story + media + speech: http://127.0.0.1:{server.server_port}/prototype/agent.html", flush=True)
            print("Speech and live story: " + ("configured" if key else "not configured; set MODEL_API_KEY in .env"), flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.media.close()


if __name__ == "__main__":
    main()
