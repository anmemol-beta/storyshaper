"""Provider-side shape constraints; semantic validation stays in the engine."""


def _object(properties):
    return {"type": "object", "properties": properties, "required": list(properties),
            "additionalProperties": False}


_STRING = {"type": "string"}
_MATERIAL = _object({
    "source": _STRING,
    "labels": _object({"en": _STRING, "ko": _STRING}),
    "behavior": {"type": "string", "enum": [
        "light_flexible", "loose_pieces", "edible", "melts", "rigid"]},
})
_CANDIDATE = _object({
    "lines": {"type": "array", "items": _object({"speakerId": _STRING, "text": _STRING})},
    "questionText": {"type": ["string", "null"]},
})
TURN_SCHEMA = _object({
    "interpretation": _object({
        "decision": {"type": "string", "enum": ["accept", "clarify", "redirect"]},
        "material": {"anyOf": [{"type": "null"}, _STRING, _MATERIAL]},
        "reason": _STRING,
    }),
    "candidate": {"anyOf": [{"type": "null"}, _CANDIDATE]},
})
REVIEW_SCHEMA = _object({"safe": {"type": "boolean"}, "coherent": {"type": "boolean"}})


def response_format(phase):
    if phase == "interpret_compose":
        return {"type": "json_schema", "name": "story_turn", "strict": True, "schema": TURN_SCHEMA}
    if phase == "review":
        return {"type": "json_schema", "name": "story_review", "strict": True, "schema": REVIEW_SCHEMA}
    return None
