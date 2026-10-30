"""Local narration server. Run: voice/.venv-chatterbox/bin/python -m narration.server

POST /api/voice/lines   {"lines": [{"speakerId": "wolf", "text": "..."}]}  queue lines, newest request first
GET  /audio/<key>.mp3   the clip; waits up to ?wait= seconds (max 30) while it is being generated
GET  /api/voice/config  roles and languages

Clips are cached in voice/cache/ by (role settings, reference clip, text), so a line is generated once.
The story pages call this server from another local port, so local origins are allowed (CORS).
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import itertools
import json
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
CASTING = json.loads((Path(__file__).with_name("casting.json")).read_text())
CACHE = ROOT / "voice" / "cache"
MAX_BODY = 16384
MAX_LINES = 20
MAX_TEXT = 500
LOCAL_ORIGIN = re.compile(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$")
KEY = re.compile(r"^/audio/([0-9a-f]{16})\.mp3$")


class Narrator:
    """Queues lines and generates them one at a time on a single worker thread."""

    def __init__(self, synthesize, cache_dir=CACHE, casting=CASTING):
        self.synthesize, self.cache, self.casting = synthesize, Path(cache_dir), casting
        self.cache.mkdir(parents=True, exist_ok=True)
        self.cond = threading.Condition()
        self.queue, self.queued, self.failed = [], {}, set()
        self.batch = itertools.count()
        self.seq = itertools.count()
        threading.Thread(target=self._work, daemon=True).start()

    def role(self, speaker_id):
        speaker_id = str(speaker_id or "narrator")
        if speaker_id.startswith("pig"):
            return "pig"
        return speaker_id if speaker_id in self.casting else "narrator"

    def key(self, role, text):
        settings = json.dumps(self.casting[role], sort_keys=True)
        return hashlib.sha1(f"{settings}\n{text}".encode()).hexdigest()[:16]

    def path(self, key):
        return self.cache / f"{key}.mp3"

    def submit(self, lines):
        """Queue lines ahead of anything queued earlier: the newest lines are the ones about to be heard."""
        batch = -next(self.batch)
        clips = []
        with self.cond:
            for line in lines:
                text, role = line["text"].strip(), self.role(line.get("speakerId"))
                key = self.key(role, text)
                ready = self.path(key).exists()
                if not ready:
                    self.failed.discard(key)
                    heapq.heappush(self.queue, (batch, next(self.seq), key, role, text))
                    self.queued[key] = batch
                clips.append({"speakerId": line.get("speakerId", "narrator"), "role": role, "text": text,
                              "key": key, "url": f"/audio/{key}.mp3", "ready": ready})
            self.cond.notify_all()
        return clips

    def wait(self, key, timeout):
        """Return "ready", "failed", "pending" (still queued after timeout) or "unknown"."""
        deadline = time.monotonic() + timeout
        with self.cond:
            while True:
                if self.path(key).exists():
                    return "ready"
                if key in self.failed:
                    return "failed"
                if key not in self.queued:
                    return "unknown"
                left = deadline - time.monotonic()
                if left <= 0:
                    return "pending"
                self.cond.wait(left)

    def _work(self):
        while True:
            with self.cond:
                while not self.queue:
                    self.cond.wait()
                batch, _, key, role, text = heapq.heappop(self.queue)
                # A line can sit in the queue twice (asked for again later); skip stale or finished copies.
                if self.queued.get(key) != batch or self.path(key).exists():
                    continue
            try:
                audio = self.synthesize(text, self.casting[role])
                tmp = self.path(key).with_suffix(".part")
                tmp.write_bytes(audio)
                tmp.replace(self.path(key))
            except Exception as exc:  # one bad line must not stop the queue
                print(f"failed {key} ({role}): {exc}", flush=True)
                with self.cond:
                    self.failed.add(key)
            with self.cond:
                self.queued.pop(key, None)
                self.cond.notify_all()


class Handler(BaseHTTPRequestHandler):
    server_version = "StoryShaperNarration/1"

    def log_message(self, *args):
        pass

    def cors(self):
        origin = self.headers.get("Origin")
        if origin and LOCAL_ORIGIN.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def reply(self, status, body, content_type="application/json"):
        data = json.dumps(body).encode() if content_type == "application/json" else body
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if content_type == "application/json" else "max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def error(self, status, code, message):
        self.reply(status, {"error": {"code": code, "message": message}})

    def guarded(self):
        port = self.server.server_port
        if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            self.error(403, "invalid_host", "Use the local server address.")
            return False
        origin = self.headers.get("Origin")
        if origin and not LOCAL_ORIGIN.match(origin):
            self.error(403, "invalid_origin", "Only local pages can use this server.")
            return False
        return True

    def do_OPTIONS(self):
        if not self.guarded():
            return
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if not self.guarded():
            return
        url = urlsplit(self.path)
        if url.path == "/api/voice/config":
            return self.reply(200, {"roles": sorted(self.server.narrator.casting), "languages": ["en"]})
        match = KEY.match(url.path)
        if not match:
            return self.error(404, "not_found", "Not found.")
        try:
            wait = min(max(float(parse_qs(url.query).get("wait", ["0"])[0]), 0), 30)
        except ValueError:
            wait = 0
        state = self.server.narrator.wait(match.group(1), wait)
        if state == "ready":
            return self.reply(200, self.server.narrator.path(match.group(1)).read_bytes(), "audio/mpeg")
        status = {"pending": (504, "not_ready", "Still generating. Ask again or use the default voice."),
                  "failed": (500, "generation_failed", "This line could not be voiced. Use the default voice."),
                  "unknown": (404, "not_found", "Queue the line with /api/voice/lines first.")}[state]
        self.error(*status)

    def do_POST(self):
        if not self.guarded():
            return
        if urlsplit(self.path).path != "/api/voice/lines":
            return self.error(404, "not_found", "Not found.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.error(413, "body_size", f"Request must be between 1 and {MAX_BODY} bytes.")
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            return self.error(400, "invalid_json", "Send a JSON object.")
        lines = body.get("lines") if isinstance(body, dict) else None
        if (not isinstance(lines, list) or not 0 < len(lines) <= MAX_LINES
                or not all(isinstance(l, dict) and isinstance(l.get("text"), str)
                           and 0 < len(l["text"].strip()) <= MAX_TEXT for l in lines)):
            return self.error(400, "invalid_lines", f"Send 1-{MAX_LINES} lines, each with text up to {MAX_TEXT} characters.")
        self.reply(200, {"clips": self.server.narrator.submit(lines)})


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, narrator):
        self.narrator = narrator
        super().__init__(address, Handler)


def chatterbox_synthesizer():
    """Load Chatterbox once and return synthesize(text, voice) -> mp3 bytes."""
    import torch
    import torchaudio as ta
    from chatterbox.tts import ChatterboxTTS

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    model = ChatterboxTTS.from_pretrained(device=device)

    def synthesize(text, voice):
        exaggeration = voice["exclaim_exaggeration"] if "!" in text else voice["exaggeration"]
        wav = model.generate(text, audio_prompt_path=str(ROOT / voice["ref"]),
                             exaggeration=exaggeration, cfg_weight=voice["cfg_weight"])
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "line.wav", Path(tmp) / "line.mp3"
            ta.save(str(src), wav, model.sr)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-filter:a", f"atempo={voice['tempo']}",
                            "-ac", "1", "-b:a", "64k", str(out)], check=True)
            return out.read_bytes()

    return synthesize


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8100)
    args = parser.parse_args()
    print("Loading Chatterbox…", flush=True)
    narrator = Narrator(chatterbox_synthesizer())
    with Server(("127.0.0.1", args.port), narrator) as server:
        print(f"Narration server: http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
