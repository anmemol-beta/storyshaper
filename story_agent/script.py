"""Compile the server's authored branches into self-contained model input.

This exports text and delivery directions, not synthesized audio or a trained
model. Story transitions are evaluated locally without a provider request.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path

from .dialogue import normalize_line
from .engine import MockProvider, STORIES, SUPPORTED_LANGUAGES, StoryEngine
from .performance import visual_performance, voice_direction


def authored_script(language="en"):
    """Return every authored scene with resolved text, speakers and delivery.

    Later houses use a documented canonical prefix so their previous choices
    are explicit. Each material branch is independent; the export is not a
    single linear performance containing mutually exclusive consequences.
    """
    if language not in SUPPORTED_LANGUAGES:
        raise ValueError("unsupported language")
    story = STORIES[language]
    engine = StoryEngine(MockProvider(), language)
    state = engine.start("script-export")["storyState"]
    scenes = []
    canonical = ("straw", "wood", "brick")

    def append_scene(current, draft, facts, *, material=None):
        stage = current["stage"]
        house_id = f"house{current['houseIndex']}"
        scene_id = engine._scene_id(current)
        script_id = (f"{house_id}_{material}_{stage}" if stage in {"predict", "reflect"}
                     else scene_id)
        question = deepcopy(draft["question"])
        question_line = (normalize_line({**story["questionDelivery"], "text": question["text"]},
                                       story["characters"]) if question else None)
        # Validate exactly the draft used by the app. This catches orphaned
        # speakers, missing delivery and incompatible causal consequences.
        engine._validate_candidate(draft, draft, facts)
        action = facts["action"]
        if action == "build":
            cast = [f"pig{current['houseIndex']}"]
        else:
            cast = [f"pig{i}" for i in range(1, current["houseIndex"] + 1)]
            if action in {"blown_away", "collapsed", "eaten", "stood"}:
                cast.append("wolf")
        performance = visual_performance(
            facts["houseId"], action, cast, target_house_id=house_id)
        spoken = draft["lines"] + ([question_line] if question_line else [])
        scenes.append({
            "scriptId": script_id,
            "sceneId": scene_id,
            "houseId": house_id,
            "material": material,
            "outcome": facts.get("outcome"),
            "lines": deepcopy(draft["lines"]),
            "question": question,
            "questionLine": question_line,
            "visualPerformance": performance,
            "voiceDirections": [voice_direction(line, language) for line in spoken],
            "facts": engine._prompt_facts(facts, facts["fromStage"]),
            "priorHouses": deepcopy([house for house in current["houses"] if house["houseId"] != house_id]),
        })

    for index, house in enumerate(story["houses"]):
        append_scene(state, {
            "lines": engine._authored_lines(state), "question": engine._question(state),
        }, {
            "language": language, "houseId": house["id"], "action": "choose_material",
            "fromStage": "choose", "toStage": "choose", "allPigsSafe": True,
            "allowedMaterials": deepcopy(house["allowedMaterials"]),
        })
        for material in house["allowedMaterials"]:
            built, draft, facts = engine._transition(state, material)
            append_scene(built, draft, facts, material=material)
            resolved, draft, facts = engine._transition(built, None)
            append_scene(resolved, draft, facts, material=material)
        # Advance a separate canonical prefix, rather than leaking the last
        # enumerated branch into the next house's story context.
        built, _, _ = engine._transition(state, canonical[index])
        resolved, _, _ = engine._transition(built, None)
        state, draft, facts = engine._transition(resolved, None)
    append_scene(state, draft, facts, material=canonical[-1])
    if len({scene["scriptId"] for scene in scenes}) != len(scenes):
        raise ValueError("duplicate script scene")
    return {
        "schemaVersion": story["schemaVersion"],
        "storyId": story["storyId"],
        "language": language,
        "title": story["title"],
        "lesson": story["lesson"],
        "fixedCharacters": deepcopy(story["fixedCharacters"]),
        "fixedEvents": deepcopy(story["fixedEvents"]),
        "fixedEnding": story["fixedEnding"],
        "characters": deepcopy(story["characters"]),
        "narrationDelivery": deepcopy(story["narrationDelivery"]),
        "questionDelivery": deepcopy(story["questionDelivery"]),
        "source": f"story_agent/{'story.ko.json' if language == 'ko' else 'story.json'}",
        "canonicalPrefix": list(canonical),
        "sceneSelection": "Select one scriptId for the active house, approved material and stage; branches are alternatives.",
        "scenes": scenes,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=SUPPORTED_LANGUAGES, default="en")
    parser.add_argument("--output", type=Path, help="Write JSON to this path instead of stdout.")
    args = parser.parse_args(argv)
    content = json.dumps(authored_script(args.language), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
