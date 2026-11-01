"""Voice the picture book and the "let's see…" lines ahead, for every saved voice, so a demo never waits.

    python3 -m narration.warm            # needs the narration server on 127.0.0.1:8100
    python3 -m narration.warm --wait     # and wait until everything is voiced, with progress

Lines are sent last page first and fillers last, because the server voices the newest request first.
"""
import argparse
import json
import re
import time
import urllib.request

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

def choice_prompt(labels, language):
    """The three choices read as one sentence when the reader offers them (Narration.choicePrompt in
    prototype/narration.js; checked by tests). Words voiced one by one came out clipped and rushed."""
    if language == "ko":
        return f"{', '.join(labels)} 중에서 하나를 골라 줘!"
    words = [label[:1].lower() + label[1:] for label in labels]
    return f"Tap one: {', '.join(words[:-1])}, or {words[-1]}."


def _choice_line(engine, state):
    question = engine._question(state)
    return question and {"speakerId": "narrator",
                         "text": choice_prompt([choice["label"] for choice in question["choices"]], state["language"])}


def call(path, body=None):
    req = urllib.request.Request(SERVER + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def _sentences(text):
    """Match Narration.sentences in prototype/narration.js so warm cache keys match playback."""
    if len(text) <= 40:
        return [text]
    parts = [part.strip() for part in re.findall(r'''[^.!?…]+(?:[.!?…]+["”’']?|$)\s*''', text)
             if part.strip()] or [text]
    merged = []
    for part in parts:
        if merged and (len(part) < 12 or len(merged[-1]) < 12):
            merged[-1] += " " + part
        else:
            merged.append(part)
    return merged


def authored_book(language="en"):
    """Return the current authored reader's spoken lines, including every registered material branch.

    Walk the engine's fixed transitions without asking a provider to interpret or write anything.
    Retain speaker and delivery metadata, and split sentences exactly as the reader does.
    Dynamic AI prose and session-only custom materials cannot be warmed in advance.
    """
    from story_agent.engine import MockProvider, STORIES, StoryEngine

    engine = StoryEngine(MockProvider(), language)
    story = STORIES[language]
    book, seen = [], set()

    def add(line):
        for text in _sentences(line["text"].strip()):
            spoken = {**line, "text": text}
            key = tuple(spoken[field] for field in ("speakerId", "text", "kind", "tone", "emotion"))
            if key not in seen:
                seen.add(key)
                book.append(spoken)

    def narration(text, *, question=False):
        return {"speakerId": "narrator", "text": text, "kind": "narration",
                "tone": "curious" if question else "warm", "emotion": "curious" if question else "calm"}

    def visit(state):
        for line in engine._authored_lines(state):
            add(line)
        question = engine._question(state)
        if question is None:
            return
        add(narration(question["text"], question=True))
        for choice in question["choices"]:
            add(narration(choice["label"]))
        materials = story["houses"][state["houseIndex"] - 1]["allowedMaterials"] if state["stage"] == "choose" else [None]
        for material in materials:
            next_state, _, _ = engine._transition(state, material)
            visit(next_state)

    visit(engine.start("voice-warmup")["storyState"])
    return book


FIELDS = ("speakerId", "text", "kind", "tone", "emotion")


def _page(lines, question):
    """A page as live.html reads it (passageLines in prototype/live-book.js), one entry per voiced sentence."""
    if question:
        lines = [*lines, {"speakerId": "narrator", "text": question["text"], "kind": "narration",
                          "tone": "curious", "emotion": "curious"}]
    return [{**{field: line[field] for field in FIELDS if field in line}, "text": text}
            for line in lines if line["text"].strip() for text in _sentences(line["text"].strip())]


def _next_states(engine, state, tapped=False):
    """States after this page. tapped: only the materials of the three choices a child can tap."""
    if state["stage"] == "complete":
        return []
    from story_agent.engine import STORIES, _materials_in
    house = STORIES[state["language"]]["houses"][state["houseIndex"] - 1]
    materials = house["allowedMaterials"] if state["stage"] == "choose" else [None]
    if tapped and state["stage"] == "choose":
        materials = [_materials_in(choice["answer"])[0] for choice in engine._question(state)["choices"]]
    return [engine._transition(state, material)[0] for material in materials]


def pages_ahead(language, story_state=None):
    """The authored pages that can open next: the opening page without a state, otherwise the page each
    of the three choices leads to. A tapped choice is read exactly as written; a typed answer is rewritten
    by the model, so its page cannot be voiced ahead."""
    from story_agent.engine import MockProvider, StoryEngine

    engine = StoryEngine(MockProvider(), language)
    if story_state is None:
        states = [engine.start("voice-ahead")["storyState"]]
    else:
        StoryEngine._validate_snapshot({"storyState": story_state, "language": language, "version": 0, "attempts": 0,
                                        "sceneId": StoryEngine._scene_id(story_state)})
        states = _next_states(engine, story_state, tapped=True)
    pages = [_page(engine._authored_lines(state), engine._question(state)) for state in states]
    # Last: this page's choices as one sentence, read only if the child needs them.
    prompt = story_state is not None and _choice_line(engine, story_state)
    return pages + [[prompt]] if prompt else pages


def book_pages(language):
    """Every authored page once, nearest the opening first (breadth-first over the choices)."""
    from story_agent.engine import MockProvider, StoryEngine

    engine = StoryEngine(MockProvider(), language)
    states, pages, seen, prompts = [engine.start("voice-book")["storyState"]], [], set(), []
    for state in states:                     # grows while it is walked
        page = _page(engine._authored_lines(state), engine._question(state))
        key = json.dumps(page, sort_keys=True)
        if key not in seen:
            seen.add(key)
            pages.append(page)
        prompt = _choice_line(engine, state)
        if prompt and prompt not in prompts:
            prompts.append(prompt)
        states += _next_states(engine, state)
    return pages + [prompts]                 # the choice sentences last


def lines_for(voice, texts, peek=False, language="en"):
    """Queue (or with peek, only check) strings or utterance objects; returns the clips."""
    clips = []
    for i in range(0, len(texts), 20):
        body = {"lines": [{"speakerId": "narrator", "text": t} if isinstance(t, str) else dict(t)
                          for t in texts[i:i + 20]], "peek": peek,
                "language": language, "priority": "background"}
        if voice != "default":
            body["voiceId"] = voice
        clips += call("/api/voice/lines", body)["clips"]
    return clips


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wait", action="store_true", help="wait until every line is voiced")
    args = parser.parse_args()
    # The same parent voice reads both books. The server voices the newest request first, so the Korean
    # book (queued last) is voiced before the English one.
    books = {"en": (authored_book("en"), FILLERS), "ko": (authored_book("ko"), FILLERS_KO)}
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
