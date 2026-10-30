"""Parent voice profiles: register a voice from a recording or a video, pick a clean clip, keep only that clip.

A profile lives in voice/profiles/<id>/ (git-ignored):
  full.wav   the whole upload as 24 kHz mono audio; deleted when the profile is saved
  ref.wav    the chosen 5-20 s clip that Chatterbox imitates
  meta.json  name, consent, transcript of the clip, quality numbers
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import wave
from pathlib import Path

import numpy as np

SR = 24000
FRAME = 0.03                       # seconds per energy frame
MAX_SOURCE_SECONDS = 600           # only the first 10 minutes of a long video are used
CLIP_MIN, CLIP_MAX, CLIP_TARGET = 5.0, 20.0, 10.0
RELATIONS = {
    "me": "My own voice",
    "family_consented": "A family member who agreed to this",
    "family_late": "A family member who has passed away (I am their close family)",
}
VOICE_ID = re.compile(r"^[0-9a-f]{12}$")
# Read at the end of the bedtime passage on voice.html; heard in the recording = spoken consent.
CONSENT_SENTENCE = "I'm happy for my voice to read stories to my child."
CONSENT_WORDS = ("happy", "voice", "read", "stories", "child")


def consent_heard(transcript):
    """True when the transcript contains most of the consent sentence (speech recognition drops or changes words)."""
    words = set(re.findall(r"[a-z]+", (transcript or "").lower()))
    return sum(w in words or w + "ren" in words for w in CONSENT_WORDS) >= 4


class VoiceError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def read_wav(path):
    with wave.open(str(path)) as f:
        data = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        return data, f.getframerate()


def write_wav(path, samples, sr=SR):
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())


def frame_levels(samples, sr):
    """Energy of each 30 ms frame in dB."""
    n = int(sr * FRAME)
    frames = samples[: len(samples) // n * n].reshape(-1, n)
    return 10 * np.log10(np.mean(frames ** 2, axis=1) + 1e-10)


def speech_threshold(levels):
    """Frames louder than the noise floor by 12 dB (and within 40 dB of the loudest part) count as speech."""
    floor, peak = np.percentile(levels, 10), np.percentile(levels, 98)
    return max(floor + 12, peak - 40)


def suggest_clips(samples, sr, count=3):
    """Up to `count` non-overlapping clips of about 10 s with the most speech, each starting where speech starts."""
    levels = frame_levels(samples, sr)
    speech = levels > speech_threshold(levels)
    total = len(levels) * FRAME
    if not speech.any():
        return []
    length = min(CLIP_TARGET, total)
    width = int(round(length / FRAME))
    onsets = [i for i in range(len(speech)) if speech[i] and (i == 0 or not speech[i - 1])]
    candidates = []
    for i in onsets:
        start = max(0, min(i - 3, len(speech) - width))          # keep 90 ms of lead-in
        ratio = float(speech[start:start + width].mean())
        candidates.append((ratio, start))
    picked = []
    for ratio, start in sorted(candidates, key=lambda c: (-c[0], c[1])):
        if all(abs(start - other) >= width for _, other in picked):
            picked.append((ratio, start))
        if len(picked) == count:
            break
    return [{"start": round(s * FRAME, 2), "end": round(s * FRAME + length, 2), "speech": round(r, 2)}
            for r, s in sorted(picked, key=lambda p: p[1])]


def clip_quality(clip, sr, whole):
    """Length, how much of the clip is speech, and how far speech stands above the background noise.
    Speech and noise levels come from the whole recording: a clip that is all talking has no quiet part of its own."""
    levels, whole_levels = frame_levels(clip, sr), frame_levels(whole, sr)
    threshold = speech_threshold(whole_levels)
    mask, whole_mask = levels > threshold, whole_levels > threshold
    noise = whole_levels[~whole_mask] if (~whole_mask).any() else np.array([-100.0])
    duration = len(clip) / sr
    speech_ratio = float(mask.mean()) if len(mask) else 0.0
    snr = float(np.median(levels[mask]) - np.median(noise)) if mask.any() else 0.0
    clipped = float(np.mean(np.abs(clip) > 0.99))
    problems = []
    if duration < CLIP_MIN:
        problems.append(f"The clip is shorter than {CLIP_MIN:.0f} seconds.")
    if duration > CLIP_MAX:
        problems.append(f"The clip is longer than {CLIP_MAX:.0f} seconds.")
    if speech_ratio < 0.6:
        problems.append("Less than 60% of the clip is speech; choose a part with more talking.")
    if snr < 15:
        problems.append("Background noise is loud compared with the voice.")
    if clipped > 0.001:
        problems.append("The voice is distorted (too loud in the recording).")
    return {"duration": round(duration, 1), "speech": round(speech_ratio, 2), "snrDb": round(snr, 1),
            "ok": not problems, "problems": problems}


class VoiceLibrary:
    def __init__(self, root, transcribe):
        self.root, self.transcribe = Path(root), transcribe
        self.root.mkdir(parents=True, exist_ok=True)

    def folder(self, voice_id):
        if not isinstance(voice_id, str) or not VOICE_ID.match(voice_id) or not (self.root / voice_id).is_dir():
            raise VoiceError(404, "voice_not_found", "No voice with this id.")
        return self.root / voice_id

    def meta(self, voice_id):
        return json.loads((self.folder(voice_id) / "meta.json").read_text())

    def _write_meta(self, voice_id, meta):
        (self.folder(voice_id) / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    def create(self, data, content_type, check_consent=False):
        """Turn an uploaded recording or video into a draft profile and suggest clips.
        check_consent: the parent recorded the bedtime passage; transcribe it to hear the consent sentence."""
        if not data:
            raise VoiceError(400, "empty_upload", "The file is empty.")
        voice_id = uuid.uuid4().hex[:12]
        folder = self.root / voice_id
        folder.mkdir()
        try:
            with tempfile.NamedTemporaryFile() as src:
                src.write(data)
                src.flush()
                done = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src.name, "-vn", "-t",
                                       str(MAX_SOURCE_SECONDS), "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le",
                                       str(folder / "full.wav")], capture_output=True)
            if done.returncode or not (folder / "full.wav").exists():
                raise VoiceError(400, "audio_unreadable", "No audio could be read from this file.")
            samples, sr = read_wav(folder / "full.wav")
            if len(samples) < sr * CLIP_MIN:
                raise VoiceError(400, "too_short", f"The recording needs at least {CLIP_MIN:.0f} seconds of audio.")
            meta = {"id": voice_id, "status": "draft", "createdAt": int(time.time()),
                    "source": "video" if content_type.startswith("video/") else "audio",
                    "sourceSeconds": round(len(samples) / sr, 1)}
            if check_consent:
                meta["consentHeard"] = consent_heard(self._transcribe(folder / "full.wav", seconds=60))
            (folder / "meta.json").write_text(json.dumps(meta, indent=2))
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return {**meta, "suggestions": suggest_clips(samples, sr)}

    def choose(self, voice_id, start, end):
        """Cut the clip, check its quality and transcribe it with Muse Voice Transcribe."""
        folder = self.folder(voice_id)
        if not (folder / "full.wav").exists():
            raise VoiceError(409, "already_saved", "This voice is saved; upload the file again to pick another clip.")
        if not all(isinstance(v, (int, float)) for v in (start, end)) or not 0 <= start < end:
            raise VoiceError(400, "invalid_clip", "Send a start and end time in seconds.")
        samples, sr = read_wav(folder / "full.wav")
        clip = samples[int(start * sr): int(end * sr)]
        if len(clip) < sr:
            raise VoiceError(400, "invalid_clip", "The clip is outside the recording.")
        write_wav(folder / "ref.wav", clip, sr)
        quality = clip_quality(clip, sr, samples)
        transcript = self._transcribe(folder / "ref.wav")
        meta = self.meta(voice_id)
        meta.update({"clip": {"start": round(start, 2), "end": round(end, 2)}, "quality": quality,
                     "transcript": transcript})
        self._write_meta(voice_id, meta)
        return meta

    def _transcribe(self, wav, seconds=None):
        """Muse Voice Transcribe on (the first `seconds` of) a file; None if it fails."""
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), *(["-t", str(seconds)] if seconds else []),
                            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tmp.name], check=True)
            try:
                return self.transcribe(Path(tmp.name).read_bytes())
            except Exception as exc:
                print(f"transcribe failed: {exc}", flush=True)
                return None

    def ref(self, voice_id):
        path = self.folder(voice_id) / "ref.wav"
        if not path.exists():
            raise VoiceError(409, "no_clip", "Choose a clip first.")
        return path

    def save(self, voice_id, name, relation, attested):
        if relation not in RELATIONS:
            raise VoiceError(400, "invalid_relation", "Choose whose voice this is.")
        if attested is not True:
            raise VoiceError(400, "consent_required", "Confirm that you have the right to use this voice.")
        if not isinstance(name, str) or not 0 < len(name.strip()) <= 40:
            raise VoiceError(400, "invalid_name", "Give the voice a name of up to 40 characters.")
        self.ref(voice_id)
        meta = self.meta(voice_id)
        meta.update({"status": "saved", "name": name.strip(), "savedAt": int(time.time()),
                     "consent": {"relation": relation, "statement": RELATIONS[relation], "attested": True,
                                 "spoken": meta.get("consentHeard", False), "at": int(time.time())}})
        self._write_meta(voice_id, meta)
        # Keep only the short clip: the full recording is not needed once the voice is saved.
        (self.folder(voice_id) / "full.wav").unlink(missing_ok=True)
        return meta

    def saved(self):
        voices = []
        for folder in sorted(self.root.iterdir()):
            meta_path = folder / "meta.json"
            if meta_path.exists():
                meta = json.loads(meta_path.read_text())
                if meta.get("status") == "saved":
                    voices.append({k: meta.get(k) for k in ("id", "name", "source", "savedAt", "consent")})
        return voices

    def delete(self, voice_id):
        shutil.rmtree(self.folder(voice_id))
