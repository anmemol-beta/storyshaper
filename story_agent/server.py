"""Local, memory-only agent playground. Run: python3 -m story_agent.server."""
from __future__ import annotations

import argparse
from collections import OrderedDict
from copy import deepcopy
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
from urllib.parse import unquote, urlsplit
import uuid

from .engine import MockProvider, StoryEngine, SUPPORTED_LANGUAGES, PIPELINES
from .provider import EFFORTS, MetaProvider, load_env

ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 8192
SESSION_TTL = 7200


def runtime_options():
    """Shared settings for text, speech, and camera servers; no credentials returned."""
    def effort(name):
        value = os.environ.get(name, "low")
        return None if value == "default" else value

    structured = os.environ.get("STORY_AGENT_STRUCTURED_OUTPUT", "1")
    if structured not in {"0", "1"}:
        raise ValueError("STORY_AGENT_STRUCTURED_OUTPUT must be 0 or 1")
    return {
        "pipeline": os.environ.get("STORY_AGENT_PIPELINE", "adaptive"),
        "compose_reasoning_effort": effort("STORY_AGENT_COMPOSE_EFFORT"),
        "review_reasoning_effort": effort("STORY_AGENT_REVIEW_EFFORT"),
        "structured_output": structured == "1",
    }


class APIError(Exception):
    def __init__(self, status, code, message, snapshot=None):
        self.status, self.code, self.message, self.snapshot = status, code, message, snapshot


@dataclass
class Session:
    engine: StoryEngine
    snapshot: dict
    lock: threading.Lock = field(default_factory=threading.Lock)
    requests: OrderedDict = field(default_factory=OrderedDict)
    turns: int = 0
    touched: float = field(default_factory=time.monotonic)


class Playground:
    def __init__(self, api_key="", model="muse-spark-1.3", provider_factory=None, *,
                 pipeline="adaptive", compose_reasoning_effort="low", review_reasoning_effort="low",
                 structured_output=True):
        if pipeline not in PIPELINES:
            raise ValueError("unsupported story pipeline")
        if compose_reasoning_effort not in EFFORTS or review_reasoning_effort not in EFFORTS:
            raise ValueError("unsupported reasoning effort")
        self.api_key, self.model = api_key, model
        self.provider_factory = provider_factory
        self.pipeline = pipeline
        self.compose_reasoning_effort = compose_reasoning_effort
        self.review_reasoning_effort = review_reasoning_effort
        self.structured_output = structured_output
        self.sessions = {}
        self.lock = threading.Lock()

    def config(self):
        return {"liveAvailable": bool(self.api_key), "model": self.model,
                "supportedLanguages": list(SUPPORTED_LANGUAGES), "storyPipeline": self.pipeline,
                "composeReasoningEffort": self.compose_reasoning_effort or "default",
                "reviewReasoningEffort": self.review_reasoning_effort or "default"}

    def create(self, mode, language="en"):
        if mode not in ("mock", "live"):
            raise APIError(400, "invalid_mode", "Choose mock or live mode.")
        self._validate_language(language)
        if mode == "live" and not self.api_key:
            raise APIError(503, "missing_api_key", "Set MODEL_API_KEY on the server, then restart it.")
        provider = (self.provider_factory(mode) if self.provider_factory else
                    MetaProvider(self.api_key, self.model,
                                 compose_reasoning_effort=self.compose_reasoning_effort,
                                 review_reasoning_effort=self.review_reasoning_effort,
                                 structured_output=self.structured_output) if mode == "live" else MockProvider())
        engine = StoryEngine(provider, language, pipeline=self.pipeline)
        session_id = str(uuid.uuid4())
        snapshot = engine.start(session_id)
        with self.lock:
            now = time.monotonic()
            self.sessions = {key: value for key, value in self.sessions.items()
                             if value.lock.locked() or now - value.touched < SESSION_TTL}
            if len(self.sessions) >= 100:
                raise APIError(429, "session_limit", "Too many sessions. Restart the local server to clear them.")
            self.sessions[session_id] = Session(engine, snapshot)
        return deepcopy(snapshot)

    @staticmethod
    def _validate_language(language):
        if not isinstance(language, str) or language not in SUPPORTED_LANGUAGES:
            raise APIError(400, "invalid_language", "Choose en or ko language.")

    def change_language(self, body):
        language = body.get("language")
        self._validate_language(language)
        session_id, version = body.get("sessionId"), body.get("version")
        if not isinstance(session_id, str) or type(version) is not int:
            raise APIError(400, "invalid_request", "Send the session, current version, and language.")
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None:
                raise APIError(404, "session_not_found", "Start a new story session.")
            if not session.lock.acquire(blocking=False):
                raise APIError(409, "turn_in_progress", "A story turn is already being processed. Please wait.")
            if time.monotonic() - session.touched >= SESSION_TTL:
                session.lock.release()
                raise APIError(404, "session_not_found", "Start a new story session.")
            session.touched = time.monotonic()
        try:
            if session.snapshot["version"] != version:
                raise APIError(409, "stale_question", "The story has moved on. Use the current question.", deepcopy(session.snapshot))
            result = session.engine.change_language(session.snapshot, language)
            if result["version"] != version:
                # Cached answers are for the previous presentation/version. A
                # delayed replay must receive the current localized snapshot.
                session.requests.clear()
            session.snapshot = deepcopy(result)
            session.touched = time.monotonic()
            return deepcopy(result)
        finally:
            session.lock.release()

    def answer(self, body):
        session_id, request_id = body.get("sessionId"), body.get("requestId")
        answer, choice = body.get("answer", ""), body.get("choiceId")
        version, question_id = body.get("version"), body.get("questionId")
        if (not isinstance(session_id, str) or not isinstance(request_id, str)
                or not 1 <= len(request_id) <= 100 or not isinstance(answer, str)
                or len(answer) > 1000 or (choice is not None and not isinstance(choice, str))
                or type(version) is not int or not isinstance(question_id, str)):
            raise APIError(400, "invalid_request", "Send a session, version, question, request ID and an answer of at most 1000 characters.")
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None:
                raise APIError(404, "session_not_found", "Start a new story session.")
            if not session.lock.acquire(blocking=False):
                raise APIError(409, "turn_in_progress", "A story turn is already being processed. Please wait.")
            if time.monotonic() - session.touched >= SESSION_TTL:
                session.lock.release()
                raise APIError(404, "session_not_found", "Start a new story session.")
            session.touched = time.monotonic()
        try:
            fingerprint = (version, question_id, answer, choice)
            if request_id in session.requests:
                prior_fingerprint, result = session.requests[request_id]
                if prior_fingerprint != fingerprint:
                    raise APIError(409, "request_id_conflict", "Use a new request ID for a different answer.")
                return deepcopy(result)
            current = session.snapshot
            question = current.get("question")
            if current["version"] != version or not question or question["id"] != question_id:
                raise APIError(409, "stale_question", "The story has moved on. Use the current question.", deepcopy(current))
            # A microphone/ASR error can expose the already-authored choices in
            # the browser before any request reaches this server. Accept only
            # a current, server-owned choice; no extra failure request is needed.
            if choice is not None and choice not in {item["id"] for item in question["choices"]}:
                raise APIError(400, "invalid_choice", "Use a choice from the current question.")
            if current.get("choiceMode") and choice is None:
                raise APIError(400, "choice_required", "Choose one of the three options for this question.",
                               deepcopy(current))
            if session.turns >= 60:
                raise APIError(429, "turn_limit", "This session has reached its turn limit. Start a new session.")
            session.turns += 1
            result = session.engine.answer(current, answer, choice_id=choice)
            session.snapshot = deepcopy(result)
            session.touched = time.monotonic()
            session.requests[request_id] = (fingerprint, deepcopy(result))
            if len(session.requests) > 80:
                session.requests.popitem(last=False)
            return deepcopy(result)
        finally:
            session.lock.release()


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, playground):
        self.playground = playground
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # No raw request paths, answers, credentials, or provider outputs in logs.
        pass

    def reply(self, status, data, content_type="application/json; charset=utf-8"):
        raw = (json.dumps(data, ensure_ascii=False).encode("utf-8")
               if isinstance(data, (dict, list)) else data)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def guard(self):
        allowed_hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if self.headers.get("Host") not in allowed_hosts:
            raise APIError(403, "invalid_host", "Use the local server address.")
        origin = self.headers.get("Origin")
        if origin and origin not in {"http://" + host for host in allowed_hosts}:
            raise APIError(403, "invalid_origin", "Open the playground from the local server.")

    def do_GET(self):
        try:
            self.guard()
            path = unquote(urlsplit(self.path).path)
            if path == "/api/config":
                return self.reply(200, self.server.playground.config())
            if path in {"/", "/index.html", "/prototype/"}:
                query = urlsplit(self.path).query
                self.send_response(302)
                self.send_header("Location", "/prototype/index.html" + ("?" + query if query else ""))
                self.send_header("Content-Length", "0")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            # Only serve the prototype. Never expose .env, voice recordings or Git files.
            target = (ROOT / path.lstrip("/")).resolve()
            static_root = (ROOT / "prototype").resolve()
            if (not target.is_relative_to(static_root) or not target.is_file()
                    or any(part.startswith(".") for part in Path(path).parts)):
                raise APIError(404, "not_found", "Page not found.")
            types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                     ".css": "text/css; charset=utf-8", ".jpg": "image/jpeg", ".png": "image/png",
                     ".mp3": "audio/mpeg", ".json": "application/json"}
            return self.reply(200, target.read_bytes(), types.get(target.suffix, "application/octet-stream"))
        except APIError as exc:
            self.error(exc)

    def do_POST(self):
        try:
            self.guard()
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
                raise APIError(415, "content_type", "Send application/json.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise APIError(400, "invalid_length", "Invalid request size.")
            if length <= 0 or length > MAX_BODY:
                raise APIError(413, "body_size", "Request must be between 1 and 8192 bytes.")
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                raise APIError(400, "invalid_json", "Send a valid JSON object.")
            if not isinstance(body, dict):
                raise APIError(400, "invalid_json", "Send a JSON object.")
            path = urlsplit(self.path).path
            if path == "/api/sessions":
                result = self.server.playground.create(body.get("mode", "mock"), body.get("language", "en"))
            elif path == "/api/answer":
                result = self.server.playground.answer(body)
            elif path == "/api/language":
                result = self.server.playground.change_language(body)
            else:
                raise APIError(404, "not_found", "API route not found.")
            self.reply(200, result)
        except APIError as exc:
            self.error(exc)
        except Exception:
            self.error(APIError(500, "server_error", "The server could not process this turn. Retry or start a new session."))

    def error(self, exc):
        data = {"error": {"code": exc.code, "message": exc.message}}
        if exc.snapshot is not None:
            data["snapshot"] = exc.snapshot
        self.reply(exc.status, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    load_env(ROOT / ".env")
    app = Playground(os.environ.get("MODEL_API_KEY", ""), os.environ.get("STORY_AGENT_MODEL", "muse-spark-1.3"),
                     **runtime_options())
    with Server(("127.0.0.1", args.port), app) as server:
        print(f"StoryShaper: http://127.0.0.1:{server.server_port}/", flush=True)
        print("Live Muse Spark: " + ("configured" if app.api_key else "not configured; use offline mock mode"), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
