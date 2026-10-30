"""Turn a browser recording into the WAV Muse Voice accepts, then into text.

Muse Voice Transcribe takes RIFF/WAVE only: mono, 16-bit PCM, 16 or 24 kHz
(https://dev.meta.ai/docs/speech-to-text). Browsers record WebM/Opus (Chrome, Edge),
Ogg/Opus (Firefox) or MP4/AAC (Safari, iPad), so the server converts with ffmpeg first.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
import wave

from story_agent.engine import STORY

# Base MIME type sent by the page -> file suffix ffmpeg uses to pick the demuxer.
AUDIO_TYPES = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".mp4",
               "audio/wav": ".wav", "audio/x-wav": ".wav"}
SAMPLE_RATE = 16000
MIN_SPEECH_MS = 300  # anything shorter is a tap on the mic, not an answer
# Story words the recognizer should prefer when a young child says them, e.g. "bricks".
KEYWORDS = sorted({alias for meta in STORY["materials"].values() for alias in meta["aliases"]})


class SpeechError(RuntimeError):
    """Safe error code, deliberately excluding provider bodies and credentials."""


def to_wav(raw: bytes, content_type: str) -> bytes:
    suffix = AUDIO_TYPES.get(content_type)
    if suffix is None:
        raise SpeechError("unsupported_audio")
    with tempfile.TemporaryDirectory() as folder:
        # A file rather than a pipe: Safari's MP4 keeps its index at the end, so ffmpeg must seek.
        source, target = Path(folder, "in" + suffix), Path(folder, "out.wav")
        source.write_bytes(raw)
        done = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(source),
                               "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", str(target)],
                              capture_output=True, timeout=20)
        if done.returncode != 0 or not target.is_file():
            raise SpeechError("audio_unreadable")
        return target.read_bytes()


def duration_ms(wav_bytes: bytes) -> int:
    with wave.open(io.BytesIO(wav_bytes)) as audio:
        return round(audio.getnframes() * 1000 / audio.getframerate())


def multipart(boundary: str, settings: dict, wav_bytes: bytes) -> bytes:
    def part(headers: str, content: bytes) -> bytes:
        return b"--" + boundary.encode() + b"\r\n" + headers.encode() + b"\r\n\r\n" + content + b"\r\n"
    return (part('Content-Disposition: form-data; name="request"\r\nContent-Type: application/json',
                 json.dumps(settings).encode("utf-8"))
            + part('Content-Disposition: form-data; name="audio"; filename="answer.wav"\r\nContent-Type: audio/wav',
                   wav_bytes)
            + b"--" + boundary.encode() + b"--\r\n")


class MuseTranscriber:
    def __init__(self, api_key: str, model: str = "muse-voice-transcribe-1.0", timeout: float = 20):
        if not api_key:
            raise SpeechError("missing_api_key")
        self._api_key = api_key
        self.model = model
        self.timeout = timeout

    def transcribe(self, wav_bytes: bytes) -> str:
        boundary = uuid.uuid4().hex
        settings = {"model": self.model, "audioEncoding": "WAV", "mode": "PUSH_TO_TALK", "keywords": KEYWORDS}
        request = urllib.request.Request(
            "https://api.meta.ai/v1/asr/transcribe", data=multipart(boundary, settings, wav_bytes),
            headers={"Authorization": "Bearer " + self._api_key, "Accept": "application/json",
                     "Content-Type": "multipart/form-data; boundary=" + boundary}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read(1_048_577)
                if len(raw) > 1_048_576:
                    raise SpeechError("speech_response_too_large")
                data = json.loads(raw)
        except urllib.error.HTTPError as exc:
            # Never expose the response body: it may echo private input or headers.
            raise SpeechError("speech_rate_limited" if exc.code == 429 else "speech_http_error") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise SpeechError("speech_unavailable") from None
        except (ValueError, UnicodeError):
            raise SpeechError("speech_invalid_response") from None
        transcript = data.get("transcript") if isinstance(data, dict) else None
        if not isinstance(transcript, str):
            raise SpeechError("speech_invalid_response")
        return transcript.strip()
