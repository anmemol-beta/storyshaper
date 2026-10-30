"""Single-submit Runway image-to-video POC. No automatic retries of paid POSTs.

Official API: https://docs.dev.runwayml.com/api/
A successful task is NOT a reviewed or publishable video.
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlparse
import uuid

API_BASE = "https://api.dev.runwayml.com"
API_VERSION = "2024-11-06"
MAX_DOWNLOAD = 200 * 1024 * 1024


class RunwayError(RuntimeError):
    def __init__(self, code, *, status=None, submission_unknown=False):
        super().__init__(code)  # Do not leak key, signed URL, raw provider error.
        self.code, self.status, self.submission_unknown = code, status, submission_unknown


class RunwayClient:
    def __init__(self, key=None, *, base_url=API_BASE, opener=None):
        self.key = key if key is not None else os.environ.get("RUNWAYML_API_SECRET", "")
        self.base_url = base_url.rstrip("/")
        if self.base_url != API_BASE and not (self.base_url.startswith("http://127.0.0.1:")
                                               or self.base_url.startswith("http://localhost:")):
            raise ValueError("Only official Runway endpoint or local mock server is supported")
        self.opener = opener or urllib.request.urlopen

    def _call(self, method, path, payload=None):
        if not self.key:
            raise RunwayError("missing_api_key")
        request = urllib.request.Request(self.base_url + path,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            method=method, headers={
                "Authorization": "Bearer " + self.key,
                "X-Runway-Version": API_VERSION,
                "Content-Type": "application/json",
            })
        try:
            with self.opener(request, timeout=20) as response:
                value = json.loads(response.read(1024 * 1024))
                if not isinstance(value, dict):
                    raise ValueError("invalid body")
                return value
        except urllib.error.HTTPError as exc:
            code = ("authentication_failed" if exc.code in (401, 403) else
                    "rate_limited" if exc.code == 429 else
                    "invalid_request" if exc.code == 400 else
                    "task_not_found" if exc.code == 404 else
                    "upstream_unavailable" if exc.code >= 500 else "api_rejected")
            raise RunwayError(code, status=exc.code,
                submission_unknown=(method == "POST" and exc.code >= 500)) from None
        except (TimeoutError, urllib.error.URLError, ConnectionError, OSError):
            raise RunwayError("network_error", submission_unknown=method == "POST") from None
        except (ValueError, UnicodeError):
            raise RunwayError("invalid_response", submission_unknown=method == "POST") from None

    def submit(self, payload):
        if not isinstance(payload, dict) or payload.get("model") != "gen4_turbo":
            raise ValueError("Only gen4_turbo is enabled for this POC")
        if payload.get("ratio") != "1280:720" or payload.get("duration") != 5:
            raise ValueError("POC is limited to 5 seconds at 1280:720")
        if not isinstance(payload.get("promptText"), str) or not payload["promptText"].strip():
            raise ValueError("Missing promptText")
        image = payload.get("promptImage")
        if not isinstance(image, str) or not image.startswith(("https://", "data:image/")):
            raise ValueError("promptImage must be HTTPS URL or encoded image")
        response = self._call("POST", "/v1/image_to_video", payload)
        try:
            task_id = str(uuid.UUID(response["id"]))
        except (ValueError, TypeError, KeyError, AttributeError):
            raise RunwayError("invalid_task_id", submission_unknown=True) from None
        return {"id": task_id}

    def get_task(self, task_id):
        try:
            task_id = str(uuid.UUID(str(task_id)))
        except ValueError:
            raise ValueError("Invalid task ID") from None
        response = self._call("GET", "/v1/tasks/" + task_id)
        if response.get("id") != task_id or response.get("status") not in {
            "PENDING", "THROTTLED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "CANCELLED"
        }:
            raise RunwayError("invalid_task_response")
        return response


def fingerprint(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class TaskLedger:
    """SQLite tombstone persists before paid submission and survives process restarts."""
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), timeout=15)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS tasks (run_id TEXT PRIMARY KEY, "
            "request_hash TEXT NOT NULL, state TEXT NOT NULL, task_id TEXT, "
            "error_code TEXT, file_path TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, "
            "updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"
        )
        self.db.commit()
        if os.name == "posix":
            os.chmod(self.path, 0o600)

    def get(self, run_id):
        row = self.db.execute(
            "SELECT run_id,request_hash,state,task_id,error_code,file_path FROM tasks WHERE run_id=?",
            (run_id,)).fetchone()
        if row is None:
            raise KeyError("Unknown run ID")
        return dict(zip(("run_id","request_hash","state","task_id","error_code","file_path"), row))

    def update(self, run_id, state, *, task_id=None, error_code=None, file_path=None):
        with self.db:
            self.db.execute(
                "UPDATE tasks SET state=?,task_id=COALESCE(?,task_id),error_code=?,"
                "file_path=COALESCE(?,file_path),updated_at=CURRENT_TIMESTAMP WHERE run_id=?",
                (state,task_id,error_code,file_path,run_id))

    def close(self):
        self.db.close()


def submit_once(client, ledger, run_id, payload):
    """Never submit twice for the same run_id, even after a crash or network failure."""
    if (not isinstance(run_id, str) or not 1 <= len(run_id) <= 64
            or not all(c.isascii() and (c.isalnum() or c in "-_") for c in run_id)):
        raise ValueError("invalid_run_id")
    digest = fingerprint(payload)
    try:
        ledger.db.execute("BEGIN IMMEDIATE")
        cursor = ledger.db.execute(
            "INSERT OR IGNORE INTO tasks(run_id,request_hash,state) VALUES(?,?,?)",
            (run_id,digest,"submitting"))
        fresh = cursor.rowcount == 1
        ledger.db.commit()
    except Exception:
        ledger.db.rollback()
        raise
    record = ledger.get(run_id)
    if record["request_hash"] != digest:
        raise ValueError("Run ID already used for different content")
    if not fresh:
        return record  # Never automatically retry rejected or submission_unknown attempts.
    try:
        task = client.submit(payload)
    except RunwayError as exc:
        ledger.update(run_id, "submission_unknown" if exc.submission_unknown else "rejected",
                      error_code=exc.code)
        raise
    except Exception:
        ledger.update(run_id, "rejected", error_code="invalid_local_request")
        raise
    ledger.update(run_id, "submitted", task_id=task["id"])
    return ledger.get(run_id)


def poll_once(client, ledger, run_id):
    record = ledger.get(run_id)
    if record["state"] in ("approved","downloaded","rejected_by_reviewer"):
        return record
    if not record["task_id"]:
        raise RunwayError("task_id_unavailable")
    task = client.get_task(record["task_id"])
    status = task["status"]
    state = ("needs_review" if status == "SUCCEEDED" else
             "failed" if status in ("FAILED","CANCELED","CANCELLED") else "running")
    ledger.update(run_id, state, error_code=task.get("failureCode") if state == "failed" else None)
    return ledger.get(run_id)


def _safe_output_url(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RunwayError("unsafe_output_url")
    try:
        ip = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        ip = None
    if ip is not None and not ip.is_global:
        raise RunwayError("unsafe_output_url")
    return url


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _safe_output_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_unreviewed(client, ledger, run_id, output_path):
    """Download to quarantine only. Published app assets require explicit human approval."""
    record = ledger.get(run_id)
    if record["state"] != "needs_review" or not record["task_id"]:
        raise RunwayError("task_not_ready")
    task = client.get_task(record["task_id"])  # Get a fresh URL; provider signed links expire.
    if task["status"] != "SUCCEEDED" or not isinstance(task.get("output"), list) or not task["output"]:
        raise RunwayError("output_unavailable")
    url = _safe_output_url(task["output"][0])
    destination = Path(output_path)
    if destination.suffix.lower() != ".mp4":
        raise ValueError("output_must_be_mp4")
    if destination.exists():
        raise FileExistsError(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with urllib.request.build_opener(_SafeRedirect()).open(url, timeout=30) as response, tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=".runway-", suffix=".part", delete=False) as dst:
            temporary = dst.name
            size = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_DOWNLOAD:
                    raise RunwayError("output_too_large")
                dst.write(chunk)
        validate_mp4(Path(temporary))
        os.link(temporary, destination)  # Exclusive create, never overwrite existing video.
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    ledger.update(run_id, "downloaded", file_path=str(destination))
    return ledger.get(run_id)


def validate_mp4(path):
    """Technical validation is not a substitute for human character/action review."""
    try:
        cmd = ["ffprobe","-v","error","-show_entries",
               "format=duration,format_name:stream=codec_name,codec_type,width,height",
               "-of","json",str(path)]
        result = subprocess.run(cmd,capture_output=True,text=True,timeout=15,check=True)
        info = json.loads(result.stdout)
        streams = [v for v in info.get("streams",[]) if v.get("codec_type")=="video"]
        seconds = float(info.get("format",{}).get("duration",0))
        if not streams or streams[0].get("codec_name")!="h264" or not 0.1<seconds<=15:
            raise ValueError("unexpected codec or duration")
        if "mp4" not in info.get("format",{}).get("format_name",""):
            raise ValueError("not mp4")
        return {"duration":seconds,"width":streams[0]["width"],"height":streams[0]["height"]}
    except (OSError,subprocess.SubprocessError,ValueError,KeyError):
        raise RunwayError("invalid_mp4") from None
