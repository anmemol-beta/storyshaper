"""Ship the storybook voice's fixed lines with the app, so they play without the voice server.

    voice/.venv-chatterbox/bin/python -m narration.pack [--server https://…modal.run]

Voices every authored page sentence, "let's see…" filler, choice prompt and choice word in the storybook voice
(narrator and character voices from casting.json), and the narrator's lines in each built-in narrator
(BUILTIN_VOICES, whose characters sound the same as the storybook voice's), on the voice server, saves them as
prototype/audio/pack/<server key>.mp3 and writes manifest.json, which prototype/narration.js reads.
Run it again after the story script or voice settings change: unchanged lines keep their files, changed lines are
voiced again, and files no longer used are removed. tests/test_narration.py fails while the pack is out of date.
"""
import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from .server import BUILTIN_VOICES
from .warm import CHOICE_PROMPT, FILLERS, FILLERS_KO, _next_states, _sentences, book_pages

PACK = Path(__file__).resolve().parent.parent / "prototype" / "audio" / "pack"


def pack_key(line, language):
    """Must match packKey in prototype/narration.js."""
    return "|".join([language, line.get("speakerId") or "narrator", line.get("kind") or "", line.get("tone") or "",
                     line.get("emotion") or "", line["text"]])


def fixed_lines(language):
    """Every line the reader can say in the storybook voice that does not come from the model, once each."""
    from story_agent.engine import MockProvider, StoryEngine

    lines = [line for page in book_pages(language) for line in page]
    narrator = lambda text: {"speakerId": "narrator", "text": text}
    lines += [narrator(text) for text in (FILLERS_KO if language == "ko" else FILLERS)]
    # Choice mode reads the prompt and the three words as plain narrator lines (narrate() in live-book.js).
    lines += [narrator(text) for text in _sentences(CHOICE_PROMPT[language])]
    engine = StoryEngine(MockProvider(), language)
    states = [engine.start("voice-pack")["storyState"]]
    for state in states:
        question = engine._question(state)
        lines += [narrator(text) for choice in (question or {}).get("choices", []) for text in _sentences(choice["label"])]
        states += _next_states(engine, state)
    unique = {}
    for line in lines:
        unique.setdefault(pack_key(line, language), line)
    return unique


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default="http://127.0.0.1:8100")
    args = parser.parse_args()
    headers = {"Content-Type": "application/json", "Origin": "http://127.0.0.1:8000"}

    def call(path, body=None, timeout=60):
        request = urllib.request.Request(args.server + path, data=json.dumps(body).encode() if body else None,
                                         headers=headers, method="POST" if body else "GET")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()

    PACK.mkdir(parents=True, exist_ok=True)
    voices, fetched = {voice: {} for voice in ["default", *BUILTIN_VOICES]}, 0
    for voice, manifest in voices.items():
        for language in ("en", "ko"):
            items = [(identity, line) for identity, line in fixed_lines(language).items()
                     if voice == "default" or line.get("speakerId", "narrator") == "narrator"]
            for i in range(0, len(items), 20):
                chunk = items[i:i + 20]
                body = {"lines": [line for _, line in chunk], "language": language, "priority": "background"}
                if voice != "default":
                    body["voiceId"] = voice
                clips = json.loads(call("/api/voice/lines", body))["clips"]
                manifest.update({identity: f"{clip['key']}.mp3" for (identity, _), clip in zip(chunk, clips)})
            print(f"{voice} {language}: {len(items)} lines", flush=True)
    for voice, manifest in voices.items():
        for identity, name in manifest.items():
            if (PACK / name).exists():
                continue
            key = name[:-4]
            for _ in range(20):
                try:
                    audio = call(f"/audio/{voice}/{key}.mp3?wait=30", timeout=90)
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 504:
                        raise
                    time.sleep(1)
            else:
                raise SystemExit(f"not voiced in time: {identity}")
            (PACK / name).write_bytes(audio)
            fetched += 1
            if fetched % 20 == 0:
                print(f"  fetched {fetched}", flush=True)
    used = {name for manifest in voices.values() for name in manifest.values()}
    removed = [file for file in PACK.glob("*.mp3") if file.name not in used]
    for file in removed:
        file.unlink()
    (PACK / "manifest.json").write_text(json.dumps(
        {"voices": {voice: dict(sorted(manifest.items())) for voice, manifest in voices.items()}},
        ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    size = sum(file.stat().st_size for file in PACK.glob("*.mp3")) / 1e6
    print(f"{len(used)} files, {fetched} voiced now, {len(removed)} removed, {size:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
