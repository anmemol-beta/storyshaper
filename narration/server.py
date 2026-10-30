"""Local narration server. Run: voice/.venv-chatterbox/bin/python -m narration.server

Reading
POST   /api/voice/lines            {"lines": [{"speakerId", "text"}], "voiceId"?, "allRoles"?, "peek"?}  queue lines,
                                   interactive newest first ("priority":"background" for warmup;
                                   "peek": only report which are ready)
GET    /audio/<voice>/<key>.mp3    the clip; waits up to ?wait= seconds (max 30) while it is being generated
GET    /api/voice/config           roles and languages

Parent voices (narration/voices.py)
GET    /api/voices                 saved voices
POST   /api/voices[?recorded=1]    raw recording or video body -> draft voice with suggested clips
                                   (recorded=1: also check that the consent sentence was read)
GET    /api/voices/<id>/full.wav   the draft's whole audio, to listen to the suggested clips
POST   /api/voices/<id>/train/<n>  one read-aloud training sentence (audio body) -> duration, transcript, match
POST   /api/voices/<id>/sample     {"from": "practice"}: make the voice sample from practice sentences read in
                                   the parent's usual voice; {"from": "original"}: back to the first clip
POST   /api/voices/<id>/finetune   {"enabled": true|false}: read this voice's English lines with its fine-tuned T3
GET    /api/voices/<id>/train      training sentences recorded so far
POST   /api/voices/<id>/train      a home video or voice message -> clips cut at pauses, transcribed as their text
POST   /api/voices/<id>/train/<n>  JSON {"text"?, "excluded"?}: correct a clip's words or leave it out
GET    /api/voices/<id>/train/<n>.wav  a training clip, to listen while checking it
POST   /api/voices/<id>/clip       {"start", "end"} -> quality and Muse Voice Transcribe transcript
POST   /api/voices/<id>/preview    a sample story line in the chosen clip's voice
POST   /api/voices/<id>/save       {"name", "relation", "attested": true}
DELETE /api/voices/<id>            the voice, its clip and every line read with it

Clips are cached in voice/cache/<voice>/ by (role settings, reference clip, text), so a line is generated once.
The story pages call this server from another local port, so local origins are allowed (CORS).
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import itertools
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .voices import VoiceError, VoiceLibrary

ROOT = Path(__file__).resolve().parent.parent
CASTING = json.loads((Path(__file__).with_name("casting.json")).read_text(encoding="utf-8"))
CACHE = ROOT / "voice" / "cache"
PROFILES = ROOT / "voice" / "profiles"
PARENT_ROLES = ("narrator", "pig")          # roles read in the parent's voice
# The preview is the picture book's first line, so the book can start the moment the voice is saved.
PREVIEW_TEXT = {"en": "Once upon a time, a mother pig lived with her three little pigs.",
                "ko": "옛날 옛적에 엄마 돼지와 아기돼지 삼형제가 살았어요."}
MAX_BODY = 16384
MAX_UPLOAD = 100 * 1024 * 1024
MAX_LINES = 20
MAX_TEXT = 500
# English uses Chatterbox; other languages use Chatterbox Multilingual with the same reference clips.
# Korean was chosen by ear on 10/30 (voice/korean.html): the parent's English clip, cfg_weight 0.5.
LANGUAGES = ("en", "ko")
LOCAL_ORIGIN = re.compile(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$")
AUDIO = re.compile(r"^/audio/(default|[0-9a-f]{12})/([0-9a-f]{16})\.mp3$")
VOICE_ROUTE = re.compile(r"^/api/voices/([0-9a-f]{12})(?:/(full\.wav|clip|preview|save|train|finetune|sample)(?:/(\d{1,4})(\.wav)?)?)?$")
# Sentences a parent reads aloud to fine-tune their voice (voice-train.html, narration/finetune.py).
TRAINING = {s["n"]: s["text"] for s in json.loads((ROOT / "prototype" / "audio" / "training-sentences.json").read_text(encoding="utf-8"))}


class Narrator:
    """Queues lines and generates them one at a time on a single worker thread."""

    def __init__(self, synthesize, cache_dir=CACHE, casting=CASTING):
        self.synthesize, self.cache, self.casting = synthesize, Path(cache_dir), casting
        self.cache.mkdir(parents=True, exist_ok=True)
        self.cond = threading.Condition()
        self.queue, self.queued, self.failed, self.dropped = [], {}, set(), set()
        self.pending, self.active = {}, {}
        self.batch = itertools.count()
        self.seq = itertools.count()
        threading.Thread(target=self._work, daemon=True).start()

    def role(self, speaker_id):
        speaker_id = str(speaker_id or "narrator")
        if speaker_id.startswith("pig"):
            return "pig"
        return speaker_id if speaker_id in self.casting else "narrator"

    def settings(self, role, parent_ref=None, all_roles=False, language="en"):
        """A role's voice settings. Parent roles (every role with all_roles) use the parent's clip,
        keeping the role's own expression and tempo. A language entry in the casting overrides the English ones."""
        settings = {k: v for k, v in self.casting[role].items() if k not in LANGUAGES}
        settings.update(self.casting[role].get(language, {}))
        if role in PARENT_ROLES or all_roles:
            settings["ref"] = str(parent_ref) if parent_ref is not None else self.casting["narrator"]["ref"]
        return settings

    @staticmethod
    def key(settings, text):
        return hashlib.sha1(f"{json.dumps(settings, sort_keys=True)}\n{text}".encode()).hexdigest()[:16]

    def path(self, voice, key):
        return self.cache / voice / f"{key}.mp3"

    def submit(self, lines, voice="default", parent_ref=None, all_roles=False, enqueue=True, language="en", t3=None,
               priority="interactive"):
        """Queue interactive passages before warmup, newest request first within each priority.
        voice names the cache folder; parent_ref replaces the parent reference clip for that voice;
        all_roles reads every character, the wolf too, in the parent's voice.
        enqueue=False only reports which lines are ready (for progress). t3: a fine-tuned T3 file for the
        parent roles in English (narration/finetune_merge.py); it is part of the cache key.
        Repeated warmup shares the pending or active job instead of changing its position."""
        batch = -next(self.batch)
        rank = 1 if priority == "background" else 0
        clips = []
        with self.cond:
            self.dropped.discard(voice)
            for line in lines:
                text, role = line["text"].strip(), self.role(line.get("speakerId"))
                settings = self.settings(role, parent_ref, all_roles, language)
                if language != "en":            # English keys stay as before, so existing clips remain valid
                    settings["language"] = language
                elif t3 and settings["ref"] != self.casting[role]["ref"]:    # the parent's voice, not a stock one
                    settings["t3"] = t3
                key = self.key(settings, text)
                ready = self.path(voice, key).exists()
                job_key = (voice, key)
                if not ready and enqueue and self.queued.get(job_key) != self.active.get(job_key, -1):
                    previous = self.pending.get(job_key)
                    # Warmup never demotes a passage or moves repeated warmup ahead. A passage can
                    # promote an existing warmup job; an in-flight job is always reused.
                    promote = previous and (rank < previous[0] or rank == previous[0] == 0 and batch < previous[1])
                    if previous is None or promote:
                        if previous is not None:
                            self.queue.remove(previous)
                            heapq.heapify(self.queue)
                        ticket = next(self.seq)
                        job = (rank, batch, ticket, voice, key, settings, text)
                        self.failed.discard(job_key)
                        heapq.heappush(self.queue, job)
                        self.pending[job_key] = job
                        self.queued[job_key] = ticket
                clips.append({"speakerId": line.get("speakerId", "narrator"), "role": role, "text": text,
                              "key": key, "url": f"/audio/{voice}/{key}.mp3", "ready": ready})
            self.cond.notify_all()
        return clips

    def wait(self, voice, key, timeout):
        """Return "ready", "failed", "pending" (still queued after timeout) or "unknown"."""
        deadline = time.monotonic() + timeout
        with self.cond:
            while True:
                if self.path(voice, key).exists():
                    return "ready"
                if (voice, key) in self.failed:
                    return "failed"
                if (voice, key) not in self.queued:
                    return "unknown"
                left = deadline - time.monotonic()
                if left <= 0:
                    return "pending"
                self.cond.wait(left)

    def forget(self, voice):
        """Drop a voice's queued lines and delete every clip already read with it."""
        with self.cond:
            self.dropped.add(voice)
            self.queue = [item for item in self.queue if item[3] != voice]
            heapq.heapify(self.queue)
            self.queued = {k: v for k, v in self.queued.items() if k[0] != voice}
            self.pending = {k: v for k, v in self.pending.items() if k[0] != voice}
            shutil.rmtree(self.cache / voice, ignore_errors=True)
            self.cond.notify_all()

    def _work(self):
        while True:
            with self.cond:
                while not self.queue:
                    self.cond.wait()
                _, _, ticket, voice, key, settings, text = heapq.heappop(self.queue)
                job_key = (voice, key)
                self.pending.pop(job_key, None)
                if self.queued.get(job_key) != ticket:
                    continue
                if self.path(voice, key).exists():
                    self.queued.pop(job_key)
                    self.cond.notify_all()
                    continue
                self.active[job_key] = ticket
            try:
                audio = self.synthesize(text, settings)
                with self.cond:
                    if voice not in self.dropped and self.queued.get(job_key) == ticket:
                        self.path(voice, key).parent.mkdir(parents=True, exist_ok=True)
                        tmp = self.path(voice, key).with_suffix(".part")
                        tmp.write_bytes(audio)
                        tmp.replace(self.path(voice, key))
            except Exception as exc:  # one bad line must not stop the queue
                print(f"failed {voice}/{key}: {exc}", flush=True)
                with self.cond:
                    if self.queued.get(job_key) == ticket:
                        self.failed.add(job_key)
            with self.cond:
                if self.active.get(job_key) == ticket:
                    self.active.pop(job_key)
                if self.queued.get(job_key) == ticket:
                    self.queued.pop(job_key)
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
        self.send_header("Cache-Control", "max-age=86400" if content_type == "audio/mpeg" else "no-store")
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

    def body(self, limit):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= limit:
            raise VoiceError(413, "body_size", f"Request must be between 1 and {limit} bytes.")
        return self.rfile.read(length)

    def json_body(self):
        try:
            body = json.loads(self.body(MAX_BODY))
        except (ValueError, UnicodeError):
            raise VoiceError(400, "invalid_json", "Send a JSON object.")
        if not isinstance(body, dict):
            raise VoiceError(400, "invalid_json", "Send a JSON object.")
        return body

    def parent_ref(self, voice_id):
        """The voice's chosen clip, or None for the default parent voice. The clip's hash is part of the
        reference, so choosing another clip never reuses lines read with the old one. A draft can read too,
        so the first pages are ready by the time the parent presses Save."""
        if voice_id in (None, "default"):
            return "default", None
        ref = self.server.library.ref(voice_id)
        return voice_id, f"{ref}#{hashlib.sha1(ref.read_bytes()).hexdigest()[:8]}"

    def finetuned(self, voice_id):
        """The voice's merged fine-tune ("path#mtime") when it is switched on, else None."""
        if voice_id in (None, "default"):
            return None
        finetune = self.server.library.meta(voice_id).get("finetune") or {}
        path = self.server.library.folder(voice_id) / str(finetune.get("file", ""))
        if not finetune.get("enabled") or not path.is_file():
            return None
        return f"{path}#{int(path.stat().st_mtime)}"

    def handle_safely(self, action):
        if not self.guarded():
            return
        try:
            action()
        except VoiceError as exc:
            self.error(exc.status, exc.code, exc.message)
        except Exception as exc:
            print(f"error: {exc!r}", flush=True)
            self.error(500, "server_error", "The narration server could not do this.")

    def do_OPTIONS(self):
        if not self.guarded():
            return
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        self.handle_safely(self._get)

    def do_POST(self):
        self.handle_safely(self._post)

    def do_DELETE(self):
        self.handle_safely(self._delete)

    def _get(self):
        url = urlsplit(self.path)
        if url.path == "/api/voice/config":
            return self.reply(200, {"roles": sorted(self.server.narrator.casting), "languages": list(LANGUAGES)})
        if url.path == "/api/voices":
            return self.reply(200, {"voices": self.server.library.saved()})
        route = VOICE_ROUTE.match(url.path)
        if route and route.group(2) == "train" and route.group(4):
            return self.reply(200, self.server.library.training_audio(route.group(1), int(route.group(3))), "audio/wav")
        if route and route.group(2) == "train" and not route.group(3):
            return self.reply(200, {**self.server.library.training_status(route.group(1)), "total": len(TRAINING)})
        if route and route.group(2) == "full.wav":
            full = self.server.library.folder(route.group(1)) / "full.wav"
            if not full.exists():
                raise VoiceError(404, "not_found", "The full recording is deleted once a voice is saved.")
            return self.reply(200, full.read_bytes(), "audio/wav")
        match = AUDIO.match(url.path)
        if not match:
            raise VoiceError(404, "not_found", "Not found.")
        try:
            wait = min(max(float(parse_qs(url.query).get("wait", ["0"])[0]), 0), 30)
        except ValueError:
            wait = 0
        voice, key = match.groups()
        state = self.server.narrator.wait(voice, key, wait)
        if state == "ready":
            return self.reply(200, self.server.narrator.path(voice, key).read_bytes(), "audio/mpeg")
        raise VoiceError(*{"pending": (504, "not_ready", "Still generating. Ask again or use the default voice."),
                           "failed": (500, "generation_failed", "This line could not be voiced. Use the default voice."),
                           "unknown": (404, "not_found", "Queue the line with /api/voice/lines first.")}[state])

    def _post(self):
        path = urlsplit(self.path).path
        library, narrator = self.server.library, self.server.narrator
        if path == "/api/voice/lines":
            body = self.json_body()
            lines = body.get("lines")
            if (not isinstance(lines, list) or not 0 < len(lines) <= MAX_LINES
                    or not all(isinstance(l, dict) and isinstance(l.get("text"), str)
                               and 0 < len(l["text"].strip()) <= MAX_TEXT for l in lines)):
                raise VoiceError(400, "invalid_lines",
                                 f"Send 1-{MAX_LINES} lines, each with text up to {MAX_TEXT} characters.")
            language = body.get("language", "en")
            if language not in LANGUAGES:
                raise VoiceError(400, "invalid_language", f"Language must be one of {', '.join(LANGUAGES)}.")
            priority = body.get("priority", "interactive")
            if priority not in ("interactive", "background"):
                raise VoiceError(400, "invalid_priority", "Priority must be interactive or background.")
            voice, ref = self.parent_ref(body.get("voiceId"))
            return self.reply(200, {"clips": narrator.submit(lines, voice, ref, body.get("allRoles") is True,
                                                             enqueue=body.get("peek") is not True, language=language,
                                                             t3=self.finetuned(body.get("voiceId")), priority=priority)})
        if path == "/api/voices":
            kind = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
            if not kind.startswith(("audio/", "video/")):
                raise VoiceError(415, "unsupported_type", "Upload a recording or a video file.")
            recorded = parse_qs(urlsplit(self.path).query).get("recorded") == ["1"]
            return self.reply(201, library.create(self.body(MAX_UPLOAD), kind, check_consent=recorded))
        route = VOICE_ROUTE.match(path)
        if not route or not route.group(2):
            raise VoiceError(404, "not_found", "Not found.")
        voice_id, action, number, _ = route.groups()
        if action == "train" and not number:
            kind = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
            if not kind.startswith(("audio/", "video/")):
                raise VoiceError(415, "unsupported_type", "Upload a recording or a video file.")
            return self.reply(200, library.add_training_media(voice_id, self.body(MAX_UPLOAD)))
        if action == "train" and self.headers.get("Content-Type", "").startswith("application/json"):
            body = self.json_body()                 # {"text"?, "excluded"?}: correct or drop a clip
            return self.reply(200, library.update_training_clip(voice_id, int(number), body.get("text"), body.get("excluded")))
        if action == "train":
            n = int(number or 0)
            if n not in TRAINING:
                raise VoiceError(404, "not_found", "No training sentence with this number.")
            kind = self.headers.get("Content-Type", "").split(";", 1)[0].strip()
            if not kind.startswith("audio/"):
                raise VoiceError(415, "unsupported_type", "Send the recording as audio.")
            return self.reply(200, library.add_training_clip(voice_id, n, TRAINING[n], self.body(MAX_UPLOAD)))
        if action == "clip":
            body = self.json_body()
            return self.reply(200, library.choose(voice_id, body.get("start"), body.get("end")))
        if action == "preview":
            language = self.json_body().get("language", "en")
            if language not in LANGUAGES:
                raise VoiceError(400, "invalid_language", f"Language must be one of {', '.join(LANGUAGES)}.")
            [clip] = narrator.submit([{"speakerId": "narrator", "text": PREVIEW_TEXT[language]}], *self.parent_ref(voice_id),
                                     language=language, t3=self.finetuned(voice_id))
            return self.reply(200, clip)
        if action == "sample":                     # {"from": "practice" | "original"}
            if self.json_body().get("from") == "practice":
                return self.reply(200, library.sample_from_practice(voice_id))
            return self.reply(200, library.restore_sample(voice_id))
        if action == "finetune":
            return self.reply(200, library.set_finetune(voice_id, self.json_body().get("enabled") is True))
        if action == "save":
            body = self.json_body()
            return self.reply(200, library.save(voice_id, body.get("name"), body.get("relation"), body.get("attested")))
        raise VoiceError(404, "not_found", "Not found.")

    def _delete(self):
        route = VOICE_ROUTE.match(urlsplit(self.path).path)
        if not route or route.group(2) or route.group(3) or route.group(4):
            raise VoiceError(404, "not_found", "Not found.")
        self.server.library.delete(route.group(1))
        self.server.narrator.forget(route.group(1))
        self.reply(200, {"deleted": route.group(1)})


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, narrator, library):
        self.narrator, self.library = narrator, library
        super().__init__(address, Handler)


def muse_transcriber(api_key):
    """Return transcribe(wav16k_bytes) -> text, using Muse Voice Transcribe."""
    def transcribe(wav):
        boundary = uuid.uuid4().hex
        request = json.dumps({"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "PUSH_TO_TALK"})
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"request\"\r\n"
                f"Content-Type: application/json\r\n\r\n{request}\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"clip.wav\"\r\n"
                f"Content-Type: audio/wav\r\n\r\n").encode() + wav + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request("https://api.meta.ai/v1/asr/transcribe", data=body, method="POST", headers={
            "Authorization": f"Bearer {api_key}", "Accept": "application/json",
            "Content-Type": f"multipart/form-data; boundary={boundary}"})
        # A 10 s clip normally takes about 3 s; one call once hung past 30 s, so give up sooner and retry once.
        for attempt in (1, 2):
            try:
                with urllib.request.urlopen(req, timeout=20) as res:
                    return json.load(res).get("transcript", "")
            except TimeoutError:
                if attempt == 2:
                    raise
    return transcribe


def load_api_key():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "MODEL_API_KEY":
                return value.strip().strip("\"'")
    return os.environ.get("MODEL_API_KEY", "")


def chatterbox_synthesizer():
    """Load only the requested language's engine, once, and return its MP3 bytes."""
    import torch
    import torchaudio as ta
    from chatterbox.tts import ChatterboxTTS

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    model = None
    multilingual = None
    tuned = {}                                      # fine-tuned T3 file -> engine sharing S3Gen, VE and tokenizer

    def tuned_model(t3_file):
        if t3_file not in tuned:
            from chatterbox.models.t3 import T3
            from safetensors.torch import load_file
            t3 = T3()
            t3.load_state_dict({k: v.float() for k, v in load_file(t3_file).items()})
            t3.to(device).eval()
            tuned.clear()                           # keep one fine-tune in memory (~2 GB)
            tuned[t3_file] = ChatterboxTTS(t3, model.s3gen, model.ve, model.tokenizer, device, conds=model.conds)
        return tuned[t3_file]

    # Chatterbox re-analyses the reference clip on every line when given audio_prompt_path; the result only
    # depends on the clip, so it is kept per engine and clip ("path#hash", so a re-chosen clip is analysed again).
    # Measured on the Mac: English 3.1 -> 2.5 s per line, Korean 6.3 -> 4.7 s (experiments/narration_speed.py).
    conds = {}

    def generate(engine, text, ref_key, exaggeration, cfg_weight, **kw):
        key = (id(engine), ref_key)
        if key not in conds:
            engine.prepare_conditionals(str(ROOT / ref_key.split("#", 1)[0]), exaggeration=exaggeration)
            if len(conds) >= 16:
                conds.pop(next(iter(conds)))
            conds[key] = engine.conds
        engine.conds = conds[key]
        return engine.generate(text, exaggeration=exaggeration, cfg_weight=cfg_weight, **kw)

    def synthesize(text, voice):
        nonlocal model, multilingual
        exaggeration = voice["exclaim_exaggeration"] if "!" in text else voice["exaggeration"]
        # casting refs are repo-relative, profile refs absolute (ROOT / absolute = absolute)
        language = voice.get("language", "en")
        if language == "en":
            if model is None:
                model = ChatterboxTTS.from_pretrained(device=device)
            engine = tuned_model(voice["t3"].split("#", 1)[0]) if voice.get("t3") else model
            wav = generate(engine, text, voice["ref"], exaggeration, voice["cfg_weight"])
        else:
            if multilingual is None:                     # loaded on the first non-English line
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS
                multilingual = ChatterboxMultilingualTTS.from_pretrained(device=device)   # a string, see mtl_tts
            engine = multilingual
            wav = generate(engine, text, voice["ref"], exaggeration, voice["cfg_weight"], language_id=language)
        with tempfile.TemporaryDirectory() as tmp:
            src, out = Path(tmp) / "line.wav", Path(tmp) / "line.mp3"
            ta.save(str(src), wav, engine.sr)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-filter:a", f"atempo={voice['tempo']}",
                            "-ac", "1", "-b:a", "64k", str(out)], check=True)
            return out.read_bytes()

    return synthesize


def lazy_synthesizer(factory=chatterbox_synthesizer):
    """Accept registrations immediately; the narration worker loads models on first use."""
    synthesize = None

    def generate(text, settings):
        nonlocal synthesize
        if synthesize is None:
            synthesize = factory()
        return synthesize(text, settings)

    return generate


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8100)
    args = parser.parse_args()
    api_key = load_api_key()
    print("Muse Voice Transcribe: " + ("configured" if api_key else "no MODEL_API_KEY; clips are not transcribed"),
          flush=True)
    os.environ.setdefault("HF_HOME", str(ROOT / "voice" / ".models"))
    print("Voice models load in the background; voice registration is ready immediately.", flush=True)
    narrator = Narrator(lazy_synthesizer())
    # Load the models now, not when the child first answers: cached lines never load them, and the Korean model
    # alone takes ~20 s. "_preload" is cleared so these lines are always generated; real requests are newer, so
    # they still go first.
    shutil.rmtree(narrator.cache / "_preload", ignore_errors=True)
    for language in LANGUAGES:
        narrator.submit([{"text": "Hello."}], "_preload", language=language)
    library = VoiceLibrary(PROFILES, muse_transcriber(api_key) if api_key else lambda wav: None)
    with Server(("127.0.0.1", args.port), narrator, library) as server:
        print(f"Narration server: http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
