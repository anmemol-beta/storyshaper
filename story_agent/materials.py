"""Validated names and authored consequences for model-proposed materials.

The model proposes a material and one of five construction behaviors. This
module owns the consequences and wording; it does not let a proposal invent an
event. Semantic identity, physical plausibility and contextual safety still
need the engine's independent review.
"""
from __future__ import annotations

from copy import deepcopy
import re
import unicodedata


CUSTOM_MATERIAL = "custom"
BEHAVIORS = {
    "light_flexible": "blown_away",
    "loose_pieces": "collapsed",
    "edible": "eaten",
    "melts": "melted",
    "rigid": "stood",
}

_INSTRUCTIONS = re.compile(
    r"\b(?:ignore|instruction|instructions|system|developer|prompt|override|json)\b"
    r"|규칙|지시|프롬프트|시스템|무시|덮어써|덮어쓰",
    re.IGNORECASE,
)
_UNSAFE_NAMES = re.compile(
    r"\b(?:blood|gun|bomb|explosive|poison|uranium|plutonium|porn|naked|suicide)\b"
    r"|폭탄|화약|독약|우라늄|플루토늄|알몸|자살|성폭|피폭",
    re.IGNORECASE,
)


def _plain_name(value, *, language=None):
    if (not isinstance(value, str) or value != value.strip()
            or not 1 <= len(value) <= 60 or not any(c.isalpha() for c in value)):
        raise ValueError("invalid material name")
    # Only names, not markup, serialized fields, URLs or complete instructions.
    if any(not (unicodedata.category(c)[0] in "LMN" or c in " -'") for c in value):
        raise ValueError("material name must be plain text")
    if _INSTRUCTIONS.search(value) or _UNSAFE_NAMES.search(value):
        raise ValueError("unsafe material name")
    if language == "en":
        if not any("LATIN" in unicodedata.name(c, "") for c in value):
            raise ValueError("English material label required")
        if any(c.isalpha() and "LATIN" not in unicodedata.name(c, "") for c in value):
            raise ValueError("English material label required")
    elif language == "ko":
        if not re.search(r"[가-힣]", value) or any(c.isalpha() and not "가" <= c <= "힣" for c in value):
            raise ValueError("Korean material label required")
    return value


def validate_proposal(value, answer):
    """Return a detached, strictly shaped material proposal.

    ``source`` is a material name actually present in the child's answer. The
    engine additionally checks that its active-language label preserves this
    name and that the material agrees with the answer and its physical facts.
    """
    if not isinstance(value, dict) or set(value) != {"source", "labels", "behavior"}:
        raise ValueError("invalid custom material proposal")
    source = _plain_name(value["source"])
    if not isinstance(answer, str) or source.casefold() not in answer.casefold():
        raise ValueError("material source not present in answer")
    labels = value["labels"]
    if not isinstance(labels, dict) or set(labels) != {"en", "ko"}:
        raise ValueError("both material labels required")
    for language in ("en", "ko"):
        _plain_name(labels[language], language=language)
    if not isinstance(value["behavior"], str) or value["behavior"] not in BEHAVIORS:
        raise ValueError("unknown material behavior")
    return deepcopy(value)


def material_meta(spec, language):
    """Render a validated proposal using a fixed, child-facing event template.

    ``process`` contains two ordered observations preceding ``event``. Templates
    describe the construction assumptions, rather than claiming every house
    made from the named material behaves this way.
    """
    if language not in {"en", "ko"}:
        raise ValueError("unsupported material language")
    spec = validate_proposal(spec, spec.get("source") if isinstance(spec, dict) else None)
    label = spec["labels"][language]
    behavior = spec["behavior"]
    if language == "ko":
        templates = {
            "light_flexible": {
                "build": f"얇은 {label}을 막대에 살짝 걸쳐 벽을 만들었어요.",
                "process": [f"늑대가 후 불자 {label} 벽이 팔랑팔랑 흔들렸어요.", "살짝 걸친 가장자리가 하나씩 풀렸어요."],
                "event": f"가벼운 {label} 벽이 바람에 날아갔어요. 돼지들은 안전하게 비켜섰어요.",
                "predict": f"늑대가 후 불면 살짝 걸친 {label} 벽은 어떻게 될까요?",
                "reflect": f"{label} 벽을 살짝 걸었을 때 바람이 불자 어떻게 됐나요?",
            },
            "loose_pieces": {
                "build": f"{label} 조각을 서로 묶지 않고 쌓아 벽을 만들었어요.",
                "process": [f"늑대가 후 불자 쌓아 둔 {label} 조각이 흔들렸어요.", "묶지 않은 조각이 하나씩 빠졌어요."],
                "event": f"느슨하게 쌓은 {label} 벽이 무너졌어요. 돼지들은 안전하게 비켜섰어요.",
                "predict": f"서로 묶지 않고 쌓은 {label} 벽에 바람이 불면 어떻게 될까요?",
                "reflect": f"{label} 조각을 다시 쌓으면 무엇으로 단단히 묶어 주면 좋을까요?",
            },
            "edible": {
                "build": f"먹을 수 있는 {label}로 집의 벽을 만들었어요.",
                "process": [f"배고픈 늑대가 {label} 벽 냄새를 맡았어요.", "늑대가 벽을 조금씩 냠냠 먹자 작은 틈이 생겼어요."],
                "event": f"늑대가 {label} 벽을 먹어 집에 커다란 틈이 생겼어요. 돼지들은 안전하게 비켜섰어요.",
                "predict": f"배고픈 늑대가 먹을 수 있는 {label} 벽을 보면 어떻게 할까요?",
                "reflect": f"늑대가 {label} 벽을 먹자 집은 어떻게 됐나요?",
            },
            "melts": {
                "build": f"따뜻한 햇살 아래 {label}로 벽을 세웠어요.",
                "process": [f"햇살이 쨍쨍 비치자 {label} 벽이 조금씩 말랑해졌어요.", "말랑해진 재료가 뚝뚝 흘러내리고 벽이 얇아졌어요."],
                "event": f"{label} 벽이 따뜻한 햇살에 녹아 집을 받쳐 주지 못했어요. 돼지들은 안전한 곳으로 갔어요.",
                "predict": f"따뜻한 햇살이 비치는 {label} 벽은 어떻게 될까요?",
                "reflect": f"{label} 벽에 햇살이 비치자 어떤 일이 생겼나요?",
            },
            "rigid": {
                "build": f"{label} 조각을 단단히 붙이고 서로 도와 벽을 세웠어요.",
                "process": [f"늑대가 {label} 벽을 향해 후 불었어요.", "단단히 붙인 조각들이 서로를 꼭 잡아 주었어요."],
                "event": f"{label} 벽은 튼튼하게 서 있었어요. 세 돼지는 함께 안전하게 지냈어요.",
                "predict": f"함께 단단히 붙여 만든 {label} 벽에 바람이 불면 어떻게 될까요?",
                "reflect": f"{label} 벽을 함께 단단히 붙이니 어떤 도움이 됐나요?",
            },
        }
    else:
        templates = {
            "light_flexible": {
                "build": f"The pig loosely hung thin {label} on sticks to make walls.",
                "process": [f"The wolf puffed, and the {label} walls flapped in the wind.", "Their loosely hung edges came free one by one."],
                "event": f"The light {label} walls blew away. The pigs stepped safely aside.",
                "predict": f"What might happen when the wolf puffs at the loosely hung {label} walls?",
                "reflect": f"What happened when the wind blew on the loosely hung {label} walls?",
            },
            "loose_pieces": {
                "build": f"The pig stacked pieces of {label} without fastening them together.",
                "process": [f"The wolf puffed, and the stacked {label} pieces wobbled.", "The unfastened pieces slipped out one by one."],
                "event": f"The loosely stacked {label} walls collapsed. The pigs stepped safely aside.",
                "predict": f"What might happen to these loosely stacked {label} walls when the wind blows?",
                "reflect": f"What could fasten the {label} pieces together next time?",
            },
            "edible": {
                "build": f"The pig made the walls from edible {label}.",
                "process": [f"The hungry wolf sniffed the {label} walls.", "He nibbled little bites, leaving small gaps."],
                "event": f"The wolf ate the {label} walls, making a big gap in the house. The pigs stepped safely aside.",
                "predict": f"What might a hungry wolf do when he finds edible {label} walls?",
                "reflect": f"What happened to the house when the wolf ate its {label} walls?",
            },
            "melts": {
                "build": f"The pig built {label} walls in the warm sunshine.",
                "process": [f"The warm sun made the {label} walls softer and softer.", "Soft drops dripped down, making the walls thinner."],
                "event": f"The {label} walls melted in the warm sun and could not hold the house up. The pigs moved to a safe place.",
                "predict": f"What might happen to these {label} walls in the warm sunshine?",
                "reflect": f"What happened when the warm sun shone on the {label} walls?",
            },
            "rigid": {
                "build": f"The pigs helped one another firmly join pieces of {label} into walls.",
                "process": [f"The wolf puffed at the {label} walls.", "The firmly joined pieces held one another in place."],
                "event": f"The {label} walls stood strong. The three pigs stayed safe together.",
                "predict": f"What might happen when the wind blows on these firmly joined {label} walls?",
                "reflect": f"How did firmly joining the {label} pieces together help the pigs?",
            },
        }
    return {
        "label": label,
        "aliases": list(dict.fromkeys([spec["source"], label])),
        "behavior": behavior,
        "outcome": BEHAVIORS[behavior],
        **templates[behavior],
    }
