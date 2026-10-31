"""Server-owned recording prompts tied to the current story revision.

The catalog describes an intended performance; it does not label an unheard
recording as successfully expressing that emotion.
"""
from copy import deepcopy

from .voices import VoiceError


def training_catalog(language="en"):
    from story_agent.performance import practice_catalog

    catalog = deepcopy(practice_catalog(language))
    # Keep the historical 1-100 practice IDs and media clips (1001-1999)
    # separate from the language-specific story practice IDs.
    offset = 2000 if language == "en" else 5000
    for index, sample in enumerate(catalog["samples"], 1):
        sample["n"] = offset + index
        sample["language"] = language
        sample["revision"] = catalog["revision"]
        if sample["n"] > 9999:
            raise ValueError("story practice catalog exceeds route capacity")
    return catalog


def training_sample(script_line_id, revision):
    for language in ("en", "ko"):
        catalog = training_catalog(language)
        for sample in catalog["samples"]:
            if sample["id"] == script_line_id:
                if revision != catalog["revision"]:
                    raise VoiceError(409, "script_changed", "The story changed. Reload the practice sentence.")
                return sample
    raise VoiceError(404, "script_line_not_found", "No current story practice sentence has this id.")


def current_performance(clip):
    """Resolve a saved recording's intended script labels; reject stale or edited text."""
    desired = clip.get("desiredPerformance")
    if not isinstance(desired, dict):
        return None
    try:
        sample = training_sample(desired.get("scriptLineId"), desired.get("revision"))
    except VoiceError:
        return None
    if clip.get("text") != sample["text"]:
        return None
    return sample
