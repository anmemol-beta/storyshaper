"""Compile authored character and moment directions for images, voices and recording.

The controls are conservative presets, not a claim that an emotion was learned
or measured. Image directions use the authored action, rather than a previous
or future line, and remain identical when the reader changes language.
"""

from copy import deepcopy
from functools import lru_cache
import hashlib
import json
from pathlib import Path

from .dialogue import normalize_line


@lru_cache(maxsize=1)
def _sources():
    folder = Path(__file__).parent
    config = json.loads((folder / "performance.json").read_text(encoding="utf-8"))
    stories = {language: json.loads((folder / filename).read_text(encoding="utf-8"))
               for language, filename in (("en", "story.json"), ("ko", "story.ko.json"))}
    revision = hashlib.sha256(json.dumps(
        [config, stories], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
    return config, stories, revision


def _story(language):
    config, stories, revision = _sources()
    if language not in stories:
        raise ValueError("unsupported performance language")
    return config, stories[language], revision


def voice_direction(line, language="en"):
    """Resolve real Chatterbox controls without adding directions to speech text."""
    config, story, revision = _story(language)
    line = normalize_line(line, story["characters"])
    profile = story["characters"][line["speakerId"]]
    base = config["speakers"][line["speakerId"]]
    tone, emotion = config["tones"][line["tone"]], config["emotions"][line["emotion"]]
    exaggeration = base["exaggeration"] + tone["exaggerationDelta"] + emotion["exaggerationDelta"]
    tempo = base["tempo"] * tone["tempoFactor"] * emotion["tempoFactor"]
    return {
        "revision": revision, "speakerId": line["speakerId"],
        "personality": deepcopy(profile["personality"]), "speechStyle": profile["speechStyle"],
        "tone": line["tone"], "emotion": line["emotion"],
        "exaggeration": round(max(0.35, min(1.0, exaggeration)), 3),
        "cfg_weight": base["cfg_weight"],
        "tempo": round(max(0.88, min(1.1, tempo)), 3),
    }


def visual_performance(house_id, action, cast, *, target_house_id=None):
    """Return directions for only the supplied, server-approved visible cast.

    The relevant authored line determines a speaker's moment emotion. Silent
    characters use an action default. A build illustration never reads reaction
    or ending dialogue, even if a later outcome is known to the story engine.
    """
    config, story, revision = _story("en")
    houses = {house["id"]: house for house in story["houses"]}
    if house_id not in houses or action not in config["actionDefaults"]:
        raise ValueError("invalid performance scene")
    if not isinstance(cast, (list, tuple)) or any(
            sid not in story["characters"] or sid == "narrator" for sid in cast):
        raise ValueError("invalid visible cast")
    house = houses[house_id]
    if action == "build":
        lines = house["buildLines"]
    elif action in {"choose", "choose_material", "move_to_next_house"}:
        target = target_house_id or house_id
        if target not in houses:
            raise ValueError("invalid target house")
        lines = houses[target]["introLines"]
    elif action == "safe_ending":
        lines = story["endingLines"]
    else:
        branch = next(meta for meta in story["materials"].values() if meta["outcome"] == action)
        lines = branch["eventLines"] + house["reactionLines"]
    moments = {line["speakerId"]: normalize_line(line, story["characters"]) for line in lines}
    directions = {}
    for sid in cast:
        profile = story["characters"][sid]
        moment = moments.get(sid, {})
        emotion = moment.get("emotion", config["actionDefaults"][action])
        directions[sid] = {
            "personality": deepcopy(profile["personality"]), "speechStyle": profile["speechStyle"],
            "imageNotes": profile["imageNotes"],
            "tone": moment.get("tone", profile["defaultTone"]), "emotion": emotion,
            "expression": config["emotions"][emotion]["expression"],
            "gesture": config["emotions"][emotion]["gesture"],
        }
    return {"revision": revision, "characters": directions}


def practice_catalog(language="en"):
    """Render a revision-bound recording script; no audio or measured labels are invented."""
    from .script import authored_script

    config, story, revision = _story(language)
    samples = {}
    for scene in authored_script(language)["scenes"]:
        lines = scene["lines"] + ([scene["questionLine"]] if scene["questionLine"] else [])
        for line in lines:
            key = hashlib.sha256(json.dumps(
                [language, line], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:20]
            if key in samples:
                samples[key]["sceneIds"].append(scene["scriptId"])
                continue
            sid = line["speakerId"]
            profile = story["characters"][sid]
            mood = config["emotions"][line["emotion"]]
            tone_label = config["tones"][line["tone"]]["label"][language]
            emotion_label = mood["label"][language]
            prompt = (f"{profile['name']} 역할로, {emotion_label}을 느끼며 {tone_label} 읽어 주세요."
                      if language == "ko" else
                      f"Read as {profile['name']}, feeling {emotion_label}, with a {tone_label} delivery.")
            samples[key] = {
                "id": key, **deepcopy(line), "personality": deepcopy(profile["personality"]),
                "speechStyle": profile["speechStyle"], "sceneIds": [scene["scriptId"]],
                "expression": mood["expression"], "gesture": mood["gesture"],
                "recordingPrompt": prompt,
            }
    return {"revision": revision, "language": language, "samples": list(samples.values())}
