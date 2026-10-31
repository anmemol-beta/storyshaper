"""Shared, model-independent utterance metadata for story and media consumers."""

from copy import deepcopy


TONES = ("warm", "lively", "thoughtful", "playful", "gentle", "curious", "reassuring")
EMOTIONS = ("calm", "excited", "curious", "confident", "surprised", "worried",
            "relieved", "happy", "determined", "disappointed")
SPEAKERS = ("narrator", "pig1", "pig2", "pig3", "wolf")
LINE_FIELDS = {"speakerId", "text", "kind", "tone", "emotion"}


def normalize_line(value, characters=None):
    """Detach and validate an utterance; fill metadata for older two-field clients.

    Explicit invalid directions are rejected. Metadata stays outside the spoken
    text, and a narrator cannot be labelled as character dialogue or vice versa.
    """
    if (not isinstance(value, dict) or not {"speakerId", "text"} <= set(value)
            or not set(value) <= LINE_FIELDS or value["speakerId"] not in SPEAKERS
            or not isinstance(value["text"], str) or not 1 <= len(value["text"].strip()) <= 500):
        raise ValueError("invalid line")
    result = deepcopy(value)
    speaker = result["speakerId"]
    profile = (characters or {}).get(speaker, {})
    kind = "narration" if speaker == "narrator" else "dialogue"
    result.setdefault("kind", kind)
    result.setdefault("tone", profile.get("defaultTone", "warm"))
    result.setdefault("emotion", profile.get("defaultEmotion", "calm"))
    if (result["kind"] != kind or result["tone"] not in TONES
            or result["emotion"] not in EMOTIONS):
        raise ValueError("invalid delivery metadata")
    return result


def render_lines(lines, characters, material=None):
    result = []
    for value in lines:
        line = normalize_line(value, characters)
        if material is not None:
            line["text"] = line["text"].replace("{material}", material)
        if "{material}" in line["text"]:
            raise ValueError("unresolved material placeholder")
        result.append(line)
    return result
