"""Voice the picture book and the "let's see…" lines ahead, for every saved voice, so a demo never waits.

    python3 -m narration.warm            # needs the narration server on 127.0.0.1:8100
    python3 -m narration.warm --wait     # and wait until everything is voiced, with progress

Lines are sent last page first and fillers last, because the server voices the newest request first.
"""
import argparse
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = "http://127.0.0.1:8100"
# Keep in sync with FILLERS in prototype/narration.js (tests/test_narration.py checks this).
FILLERS = [
    "Ooh, what a good idea! Let's see what happens…",
    "Hmm, let me think about that…",
    "Let's turn the page and find out!",
    "I wonder what will happen next…",
    "Ready? Here we go…",
]
FILLERS_KO = [
    "우와, 좋은 생각이다! 어떻게 되는지 볼까?",
    "음, 어떻게 될까?",
    "다음 장을 넘겨서 알아보자!",
    "다음엔 무슨 일이 일어날까?",
    "준비됐니? 자, 간다!",
]

# Read when live.html offers three words instead of free answers (prototype/live-book.js; checked by tests).
CHOICE_PROMPT = {"en": "Tap one of these three words.", "ko": "세 가지 중 하나를 톡 골라 줘!"}


def call(path, body=None):
    req = urllib.request.Request(SERVER + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def lines_for(voice, texts, peek=False, language="en"):
    """Queue (or with peek, only check) texts for a voice; returns the clips."""
    clips = []
    for i in range(0, len(texts), 20):
        body = {"lines": [{"speakerId": "narrator", "text": t} for t in texts[i:i + 20]], "peek": peek,
                "language": language, "priority": "background"}
        if voice != "default":
            body["voiceId"] = voice
        clips += call("/api/voice/lines", body)["clips"]
    return clips


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wait", action="store_true", help="wait until every line is voiced")
    args = parser.parse_args()
    audio = ROOT / "prototype" / "audio"
    # The same parent voice reads both books. The server voices the newest request first, so the Korean
    # book (queued last) is voiced before the English one.
    books = {"en": ([line["text"] for line in json.loads((audio / "lines.json").read_text(encoding="utf-8"))],
                    FILLERS + [CHOICE_PROMPT["en"]]),
             "ko": ([line["text"] for line in json.loads((audio / "lines.ko.json").read_text(encoding="utf-8"))],
                    FILLERS_KO + [CHOICE_PROMPT["ko"]])}
    voices = ["default"] + [v["id"] for v in call("/api/voices")["voices"]]
    names = {v["id"]: v["name"] for v in call("/api/voices")["voices"]}
    for voice in voices:
        for language, (book, fillers) in books.items():
            chunks = [book[i:i + 20] for i in range(0, len(book), 20)]
            for chunk in reversed(chunks):
                lines_for(voice, chunk, language=language)
            lines_for(voice, fillers, language=language)
    total = len(voices) * sum(len(b) + len(f) for b, f in books.values())
    print("Queued the English and Korean books and fillers for: " +
          ", ".join(names.get(v, "storybook voice") for v in voices), flush=True)
    while args.wait:
        ready = sum(c["ready"] for v in voices for language, (book, fillers) in books.items()
                    for c in lines_for(v, book + fillers, peek=True, language=language))
        print(f"  {ready}/{total} voiced", flush=True)
        if ready >= total:
            break
        time.sleep(10)


if __name__ == "__main__":
    main()
