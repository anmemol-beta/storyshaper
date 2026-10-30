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
CONSENT_SENTENCE_KO = "제 목소리로 아이에게 동화를 읽어 주는 것에 동의합니다."
CONSENT_WORDS = ("happy", "voice", "read", "stories", "child")


def text_error(expected, heard):
    """Character error rate between what should have been read and what was heard (letters and digits only)."""
    a, b = (re.sub(r"[^a-z0-9가-힣]", "", s.lower()) for s in (expected, heard or ""))
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return min(1.0, row[-1] / max(1, len(a)))


def consent_heard(transcript):
    """True when the transcript contains most of the consent sentence (speech recognition drops or changes words)."""
    words = set(re.findall(r"[a-z]+", (transcript or "").lower()))
    korean = re.sub(r"[^가-힣]", "", transcript or "")
    return (sum(w in words or w + "ren" in words for w in CONSENT_WORDS) >= 4
            or re.sub(r"[^가-힣]", "", CONSENT_SENTENCE_KO) in korean)


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


def split_utterances(samples, sr, min_s=1.5, max_s=12.0, gap_s=0.35):
    """(start, end) seconds of stretches of talking separated by pauses of at least gap_s; long ones are cut at max_s."""
    levels = frame_levels(samples, sr)
    speech = levels > speech_threshold(levels)
    spans, start, quiet = [], None, 0
    for i, talking in enumerate(speech):
        if talking:
            start = i if start is None else start
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet * FRAME >= gap_s:
                spans.append((start, i - quiet + 1))
                start, quiet = None, 0
    if start is not None:
        spans.append((start, len(speech)))
    out = []
    for a, b in spans:
        a_s, b_s = a * FRAME, b * FRAME
        while b_s - a_s > max_s:
            out.append((a_s, a_s + max_s))
            a_s += max_s
        if b_s - a_s >= min_s:
            out.append((a_s, b_s))
    return [(round(max(0.0, a - 0.15), 2), round(min(len(samples) / sr, b + 0.2), 2)) for a, b in out]


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
        return json.loads((self.folder(voice_id) / "meta.json").read_text(encoding="utf-8"))

    def _write_meta(self, voice_id, meta):
        (self.folder(voice_id) / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    def create(self, data, content_type, check_consent=False):
        """Turn an uploaded recording or video into a draft profile and suggest clips.
        check_consent: the parent recorded the bedtime passage; transcribe it to hear the consent sentence."""
        if not data:
            raise VoiceError(400, "empty_upload", "The file is empty.")
        voice_id = uuid.uuid4().hex[:12]
        folder = self.root / voice_id
        folder.mkdir()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary) / "upload"
                source.write_bytes(data)
                done = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(source), "-vn", "-t",
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
            (folder / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
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
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "transcript.wav"
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), *(["-t", str(seconds)] if seconds else []),
                            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)], check=True)
            try:
                return self.transcribe(target.read_bytes())
            except Exception as exc:
                print(f"transcribe failed: {exc}", flush=True)
                return None

    def add_training_clip(self, voice_id, n, text, data):
        """Store one read-aloud sentence for fine-tuning (train/NNN.wav) with its text, quality and transcript."""
        folder = self.folder(voice_id) / "train"
        folder.mkdir(exist_ok=True)
        path = folder / f"{n:03d}.wav"
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "upload"
            source.write_bytes(data)
            done = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(source), "-vn", "-t", "30", "-ac", "1",
                                   "-ar", str(SR), "-c:a", "pcm_s16le", str(path)], capture_output=True)
        if done.returncode or not path.exists():
            raise VoiceError(400, "audio_unreadable", "No audio could be read from this recording.")
        samples, sr = read_wav(path)
        if len(samples) < sr:
            path.unlink()
            raise VoiceError(400, "too_short", "The recording is shorter than one second.")
        quality = clip_quality(samples, sr, samples)
        heard = self._transcribe(path)
        clip = {"n": n, "file": path.name, "source": "read", "text": text, "seconds": round(len(samples) / sr, 1), "heard": heard,
                "match": None if heard is None else round(1 - text_error(text, heard), 2),
                "snrDb": quality["snrDb"]}
        clips = self._training_clips(voice_id)
        clips[str(n)] = clip
        (folder / "clips.json").write_text(json.dumps(clips, ensure_ascii=False, indent=1), encoding="utf-8")
        return clip

    def add_training_media(self, voice_id, data, max_seconds=600):
        """Turn a home video or voice message into training clips: cut at pauses, keep the clear ones, and use
        Muse Voice Transcribe's transcript as each clip's text (for family who can't read sentences aloud)."""
        folder = self.folder(voice_id) / "train"
        folder.mkdir(exist_ok=True)
        with tempfile.NamedTemporaryFile() as src, tempfile.NamedTemporaryFile(suffix=".wav") as wav:
            src.write(data)
            src.flush()
            done = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src.name, "-vn", "-t", str(max_seconds),
                                   "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", wav.name], capture_output=True)
            if done.returncode:
                raise VoiceError(400, "audio_unreadable", "No audio could be read from this file.")
            samples, sr = read_wav(wav.name)
        clips = self._training_clips(voice_id)
        next_n = max([int(k) for k in clips if int(k) > 1000] + [1000]) + 1
        added, skipped = [], 0
        for start, end in split_utterances(samples, sr):
            part = samples[int(start * sr): int(end * sr)]
            if clip_quality(part, sr, samples)["snrDb"] < 12:
                skipped += 1
                continue
            path = folder / f"m{next_n}.wav"
            write_wav(path, part, sr)
            heard = (self._transcribe(path) or "").strip()
            if len(heard) < 3:
                path.unlink()
                skipped += 1
                continue
            clips[str(next_n)] = {"n": next_n, "file": path.name, "source": "media", "text": heard,
                                  "seconds": round(len(part) / sr, 1), "heard": heard, "match": None}
            added.append(clips[str(next_n)])
            next_n += 1
        (folder / "clips.json").write_text(json.dumps(clips, ensure_ascii=False, indent=1), encoding="utf-8")
        return {"added": len(added), "skipped": skipped, "seconds": round(sum(c["seconds"] for c in added), 1),
                "clips": added}

    def update_training_clip(self, voice_id, n, text=None, excluded=None):
        """Correct a clip's text (a mistranscribed home-video clip) or leave it out of training."""
        clips = self._training_clips(voice_id)
        clip = clips.get(str(n))
        if not clip:
            raise VoiceError(404, "not_found", "No training clip with this number.")
        if text is not None:
            if not isinstance(text, str) or not 0 < len(text.strip()) <= 300:
                raise VoiceError(400, "invalid_text", "Give the clip's words, up to 300 characters.")
            clip["text"], clip["edited"] = text.strip(), True
        if excluded is not None:
            clip["excluded"] = bool(excluded)
        (self.folder(voice_id) / "train" / "clips.json").write_text(json.dumps(clips, ensure_ascii=False, indent=1), encoding="utf-8")
        return clip

    def training_audio(self, voice_id, n):
        clip = self._training_clips(voice_id).get(str(n))
        if not clip:
            raise VoiceError(404, "not_found", "No training clip with this number.")
        return (self.folder(voice_id) / "train" / clip.get("file", f"{n:03d}.wav")).read_bytes()

    def _training_clips(self, voice_id):
        path = self.folder(voice_id) / "train" / "clips.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def training_status(self, voice_id):
        clips = self._training_clips(voice_id)
        return {"clips": sorted(clips.values(), key=lambda c: c["n"]),
                "seconds": round(sum(c["seconds"] for c in clips.values()), 1)}

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

    def set_finetune(self, voice_id, enabled):
        meta = self.meta(voice_id)
        if not meta.get("finetune") or not (self.folder(voice_id) / meta["finetune"]["file"]).is_file():
            raise VoiceError(409, "no_finetune", "This voice has no fine-tune yet.")
        meta["finetune"]["enabled"] = enabled
        self._write_meta(voice_id, meta)
        return meta["finetune"]

    def saved(self):
        voices = []
        for folder in sorted(self.root.iterdir()):
            meta_path = folder / "meta.json"
            if meta_path.exists():
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if meta.get("status") == "saved":
                    voices.append({k: meta.get(k) for k in ("id", "name", "source", "savedAt", "consent", "finetune")})
        return voices

    def delete(self, voice_id):
        """The profile, and everything trained from it: its fine-tune dataset (finetune-data/<id>) and every
        run whose training data was this voice (finetune-runs/*/train.json), which live outside the profile."""
        shutil.rmtree(self.folder(voice_id))
        voice_dir = self.root.parent
        shutil.rmtree(voice_dir / "finetune-data" / voice_id, ignore_errors=True)
        for run in (voice_dir / "finetune-runs").glob("*/train.json"):
            try:
                data = json.loads(run.read_text(encoding="utf-8")).get("data", "")
            except ValueError:
                continue
            if Path(data).name == voice_id:
                shutil.rmtree(run.parent, ignore_errors=True)
