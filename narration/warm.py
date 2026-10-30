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


def call(path, body=None):
    req = urllib.request.Request(SERVER + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def lines_for(voice, texts, peek=False):
    """Queue (or with peek, only check) texts for a voice; returns the clips."""
    clips = []
    for i in range(0, len(texts), 20):
        body = {"lines": [{"speakerId": "narrator", "text": t} for t in texts[i:i + 20]], "peek": peek}
        if voice != "default":
            body["voiceId"] = voice
        clips += call("/api/voice/lines", body)["clips"]
    return clips


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wait", action="store_true", help="wait until every line is voiced")
    args = parser.parse_args()
    book = [line["text"] for line in json.loads((ROOT / "prototype" / "audio" / "lines.json").read_text())]
    voices = ["default"] + [v["id"] for v in call("/api/voices")["voices"]]
    names = {v["id"]: v["name"] for v in call("/api/voices")["voices"]}
    for voice in voices:
        chunks = [book[i:i + 20] for i in range(0, len(book), 20)]
        for chunk in reversed(chunks):
            lines_for(voice, chunk)
        lines_for(voice, FILLERS)
    total = len(voices) * (len(book) + len(FILLERS))
    print(f"Queued {len(book)} book lines and {len(FILLERS)} fillers for: " +
          ", ".join(names.get(v, "storybook voice") for v in voices), flush=True)
    while args.wait:
        ready = sum(c["ready"] for v in voices for c in lines_for(v, book + FILLERS, peek=True))
        print(f"  {ready}/{total} voiced", flush=True)
        if ready >= total:
            break
        time.sleep(10)


if __name__ == "__main__":
    main()
