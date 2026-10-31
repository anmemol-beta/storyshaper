"""Prepare a whole scene as one local PCM file before the reader enters it.

Line synthesis and its cache remain owned by Narrator. A scene never publishes
an audio URL until every line has finished and the complete file is committed.
"""
from array import array
from copy import deepcopy
import hashlib
import io
import json
import subprocess
import sys
import threading
import wave


RATE = 24000
MAX_PCM = RATE * 2 * 300
FORMAT_VERSION = "scene-pcm-v1"


class SceneClipError(ValueError):
    """Identify an unusable cached line without exposing provider output."""

    def __init__(self, key):
        super().__init__("scene_clip_decode_failed")
        self.key = key


def decoded_pcm(path):
    """Decode MP3 once, retaining speech and normal sentence pauses.

    Trim only conspicuously long edge silence, with a short safety margin.
    Internal pauses are untouched. The result has no per-clip MP3 frame padding.
    """
    result = subprocess.run([
        "ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path), "-vn",
        "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
    ], capture_output=True, check=True, timeout=20)
    pcm = result.stdout
    if not pcm or len(pcm) % 2 or len(pcm) > MAX_PCM:
        raise ValueError("invalid_scene_clip")
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    threshold = 104                         # approximately -50 dBFS
    first = next((i for i, sample in enumerate(samples) if abs(sample) > threshold), None)
    if first is None:
        raise ValueError("silent_scene_clip")
    last = len(samples) - 1 - next(i for i, sample in enumerate(reversed(samples)) if abs(sample) > threshold)
    start = max(0, first - int(RATE * .08)) if first > RATE * .25 else 0
    end = min(len(samples), last + int(RATE * .1) + 1) if len(samples) - last - 1 > RATE * .35 else len(samples)
    return pcm[start * 2:end * 2]


def join_scene(paths, clips):
    """Return one WAV plus sample-accurate line timings, without a model call."""
    combined, segments = bytearray(), []
    for index, (path, clip) in enumerate(zip(paths, clips)):
        try:
            pcm = decoded_pcm(path)
        except (OSError, ValueError, subprocess.SubprocessError):
            raise SceneClipError(clip["key"]) from None
        start = len(combined) / (RATE * 2)
        combined.extend(pcm)
        if len(combined) > MAX_PCM:
            raise ValueError("scene_audio_too_long")
        segments.append({"lineIndex": index, "speakerId": clip["speakerId"], "text": clip["text"],
                         "start": start, "end": len(combined) / (RATE * 2)})
    if not combined:
        raise ValueError("empty_scene_audio")
    stream = io.BytesIO()
    with wave.open(stream, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(combined)
    return stream.getvalue(), segments, len(combined) / (RATE * 2)


class SceneAudio:
    """Deduplicate scene preparation, retaining failed results until explicit retry."""

    def __init__(self, narrator, joiner=join_scene):
        self.narrator, self.joiner = narrator, joiner
        self.lock = threading.RLock()
        self.jobs, self.epochs = {}, {}

    def path(self, voice, key):
        return self.narrator.cache / voice / "scenes" / f"{key}.wav"

    def read(self, voice, key):
        """Return a fully committed WAV, or None while absent or incomplete."""
        with self.lock:
            if self._stored(voice, key) is None:
                return None
            try:
                return self.path(voice, key).read_bytes()
            except OSError:
                return None

    def _stored(self, voice, key):
        path = self.path(voice, key)
        try:
            value = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
            if (value["sceneKey"] == key and value["status"] == "ready"
                    and path.is_file() and path.stat().st_size > 44):
                return value
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    @staticmethod
    def _identity(clips, language, voice):
        value = [FORMAT_VERSION, voice, language,
                 [[clip["key"], clip["speakerId"], clip["text"]] for clip in clips]]
        return hashlib.sha1(json.dumps(value, ensure_ascii=False).encode()).hexdigest()[:16]

    def submit(self, lines, voice="default", parent_ref=None, all_roles=False, *,
               language="en", t3=None, t3_scope=None, priority="interactive", peek=False, retry=False):
        options = dict(language=language, t3=t3, t3_scope=t3_scope, priority=priority)
        clips = self.narrator.submit(lines, voice, parent_ref, all_roles, enqueue=False, **options)
        key = self._identity(clips, language, voice)
        identity = voice, key
        with self.lock:
            job = self.jobs.get(identity)
            if job and job["result"]["status"] == "pending":
                return deepcopy(job["result"])
            stored = self._stored(voice, key)
            explicit_retry = retry and not peek
            if stored and not explicit_retry:
                return deepcopy(stored)
            if explicit_retry:
                # A client may have failed to decode a ready WAV. Rebuild only
                # this derived scene from the existing line cache, even when a
                # size-only disk check still considers the damaged WAV ready.
                self.path(voice, key).unlink(missing_ok=True)
                self.path(voice, key).with_suffix(".json").unlink(missing_ok=True)
                if job and job["result"]["status"] == "failed":
                    # A decode failure identifies exactly which cached MP3 is
                    # unusable. Explicit retry replaces it without regenerating
                    # the other valid lines or automatically retrying on polls.
                    with self.narrator.cond:
                        for bad_key in job.get("badClips", ()):
                            self.narrator.path(voice, bad_key).unlink(missing_ok=True)
                    clips = self.narrator.submit(lines, voice, parent_ref, all_roles, enqueue=False, **options)
                job = None
            if job is None:
                result = {"sceneKey": key, "status": "pending", "ready": sum(c["ready"] for c in clips),
                          "total": len(clips), "url": None, "segments": [], "duration": None}
                if peek:
                    return result
                # Polling does not keep promoting this batch or automatically
                # resubmitting failed lines. Only the first request queues it.
                self.narrator.submit(lines, voice, parent_ref, all_roles, enqueue=True, **options)
                job = {"epoch": self.epochs.get(voice, 0), "clips": clips, "result": result}
                self.jobs[identity] = job
                threading.Thread(target=self._prepare, args=(voice, key, job), daemon=True).start()
            return deepcopy(job["result"])

    def _current(self, voice, key, job):
        return self.jobs.get((voice, key)) is job and self.epochs.get(voice, 0) == job["epoch"]

    def _prepare(self, voice, key, job):
        clips = job["clips"]
        try:
            while True:
                states = [self.narrator.wait(voice, clip["key"], 0) for clip in clips]
                with self.lock:
                    if not self._current(voice, key, job):
                        return
                    job["result"]["ready"] = states.count("ready")
                    if any(state in {"failed", "unknown"} for state in states):
                        raise ValueError("scene_line_failed")
                    if all(state == "ready" for state in states):
                        break
                with self.narrator.cond:
                    self.narrator.cond.wait(.1)
            audio, segments, duration = self.joiner(
                [self.narrator.path(voice, clip["key"]) for clip in clips], clips)
            with self.lock:
                if not self._current(voice, key, job):
                    return
                result = {"sceneKey": key, "status": "ready", "ready": len(clips), "total": len(clips),
                          "url": f"/audio/{voice}/scene-{key}.wav", "segments": segments, "duration": duration}
                path = self.path(voice, key)
                path.parent.mkdir(parents=True, exist_ok=True)
                temp = path.with_suffix(".part")
                temp.write_bytes(audio)
                temp.replace(path)
                metadata = path.with_suffix(".json")
                temporary_metadata = metadata.with_suffix(".part")
                temporary_metadata.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
                temporary_metadata.replace(metadata)
                job["result"] = result
        except Exception as exc:
            with self.lock:
                if self._current(voice, key, job):
                    if isinstance(exc, SceneClipError):
                        job["badClips"] = (exc.key,)
                    job["result"].update(status="failed", url=None, segments=[], duration=None,
                                         error="scene_audio_failed")

    def forget(self, voice):
        """Call under this lock when deleting the voice's line cache as well."""
        with self.lock:
            self.epochs[voice] = self.epochs.get(voice, 0) + 1
            self.jobs = {identity: job for identity, job in self.jobs.items() if identity[0] != voice}
