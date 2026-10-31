"""Authored and generated dialogue must survive story, language and media boundaries."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from media.contracts import normalize
from story_agent.dialogue import EMOTIONS, LINE_FIELDS, TONES
from story_agent.engine import MockProvider, STORIES, StoryEngine
from story_agent.output_schema import TURN_SCHEMA
from story_agent.script import authored_script, main


class ChangingProvider(MockProvider):
    def __init__(self, change):
        self.change = change
        self.calls = []

    def complete(self, instructions, payload):
        self.calls.append((instructions, deepcopy(payload)))
        result = super().complete(instructions, payload)
        if payload["phase"] == "interpret_compose":
            self.change(result["candidate"]["lines"])
        return result


class StoryDialogueTests(unittest.TestCase):
    def assert_lines(self, state):
        for line in state["lines"]:
            self.assertEqual(set(line), LINE_FIELDS)
            self.assertIn(line["speakerId"], STORIES[state["language"]]["characters"])
            self.assertEqual(line["kind"], "narration" if line["speakerId"] == "narrator" else "dialogue")
            self.assertIn(line["tone"], TONES)
            self.assertIn(line["emotion"], EMOTIONS)
            self.assertNotIn("{material}", line["text"])
        if state["mediaPlan"]:
            self.assertEqual(state["mediaPlan"]["narration"], state["lines"])
            self.assertEqual(state["mediaPlan"]["characterProfiles"], STORIES[state["language"]]["characters"])
            self.assertIsNotNone(normalize(state))

    def test_every_character_speaks_in_both_languages_and_each_pipeline(self):
        for language in ("en", "ko"):
            for pipeline in ("adaptive", "two_call", "legacy_three_call"):
                with self.subTest(language=language, pipeline=pipeline):
                    engine = StoryEngine(MockProvider(), language, pipeline=pipeline)
                    state = engine.start("dialogue")
                    spoken = set()
                    self.assert_lines(state)
                    for material in ("straw", "wood", "brick"):
                        for answer in (material, "It might stay standing", "We helped together"):
                            state = engine.answer(state, answer)
                            self.assertIn(state["decision"], ("accept", "complete"), state)
                            self.assert_lines(state)
                            spoken.update(line["speakerId"] for line in state["lines"])
                    self.assertEqual(spoken, set(STORIES[language]["fixedCharacters"]))
                    self.assertEqual(state["sceneId"], "ending")
                    self.assertEqual(state["version"], 9)
                    self.assertIsNone(state["question"])

    def test_causal_branches_keep_speakers_and_observation_before_result(self):
        for language in ("en", "ko"):
            for material in ("paper", "straw", "wood", "cookie", "icecream"):
                with self.subTest(language=language, material=material):
                    engine = StoryEngine(MockProvider(), language, pipeline="adaptive")
                    built = engine.answer(engine.start("branch"), material)
                    self.assertEqual(built["decision"], "accept", built)
                    self.assert_lines(built)
                    self.assertIn("pig1", [line["speakerId"] for line in built["lines"]])
                    result = engine.answer(built, "It might get bigger")
                    self.assertEqual(result["decision"], "accept", result)
                    self.assert_lines(result)
                    meta = STORIES[language]["materials"][material]
                    self.assertEqual([line["text"] for line in result["lines"][:3]],
                                     meta["process"] + [meta["event"]])
                    self.assertEqual(result["storyState"]["houses"][0]["outcome"], meta["outcome"])

    def test_touch_choice_and_language_switch_keep_delivery_and_material(self):
        engine = StoryEngine(MockProvider(), "ko")
        initial = engine.start("touch")
        built = engine.answer(initial, "ignored", choice_id="straw")
        self.assertEqual(built["diagnostics"]["performance"]["modelCalls"], 0)
        self.assert_lines(built)
        translated = engine.change_language(built, "en")
        self.assertEqual(translated["storyState"]["houses"], built["storyState"]["houses"])
        self.assertEqual([line["speakerId"] for line in translated["lines"]],
                         [line["speakerId"] for line in built["lines"]])
        self.assert_lines(translated)
        self.assertIn("straw", " ".join(line["text"] for line in translated["lines"]))

    def test_new_material_uses_its_branch_without_registered_material_name(self):
        engine = StoryEngine(MockProvider(), "ko", pipeline="adaptive")
        built = engine.answer(engine.start("custom"), "비닐로 짓고 싶어!")
        self.assertEqual(built["decision"], "accept", built)
        self.assert_lines(built)
        self.assertIn("비닐", next(line["text"] for line in built["lines"] if line["speakerId"] == "pig1"))
        self.assertNotIn("종이", " ".join(line["text"] for line in built["lines"]))
        result = engine.answer(built, "바람에 흔들릴 것 같아요")
        self.assertEqual(result["decision"], "accept", result)
        self.assert_lines(result)
        self.assertEqual(result["storyState"]["houses"][0]["material"], "custom")

    def test_model_receives_character_profiles_and_schema_requires_delivery(self):
        provider = ChangingProvider(lambda lines: None)
        engine = StoryEngine(provider, pipeline="adaptive")
        result = engine.answer(engine.start("profiles"), "paper")
        self.assertEqual(result["decision"], "accept", result)
        instructions, payload = provider.calls[0]
        self.assertEqual(payload["characters"], STORIES["en"]["characters"])
        self.assertIn("speechStyle", instructions)
        self.assertIn("buildDialogue", payload)
        self.assertEqual(payload["buildDialogue"][0]["speakerId"], "pig1")
        candidate = TURN_SCHEMA["properties"]["candidate"]["anyOf"][1]
        line = candidate["properties"]["lines"]["items"]
        self.assertEqual(set(line["required"]), LINE_FIELDS)

    def test_invalid_delivery_or_erased_dialogue_never_advances(self):
        def narrator_only(lines):
            lines[:] = [line for line in lines if line["speakerId"] == "narrator"]

        for change in (narrator_only,
                       lambda lines: lines[0].update(tone="shouting"),
                       lambda lines: lines[0].update(emotion="terrified"),
                       lambda lines: lines[0].update(kind="dialogue")):
            with self.subTest(change=change):
                engine = StoryEngine(ChangingProvider(change), pipeline="adaptive")
                initial = engine.start("invalid")
                failed = engine.answer(initial, "paper")
                self.assertEqual(failed["decision"], "service_error")
                self.assertEqual(failed["storyState"], initial["storyState"])
                self.assertEqual(failed["version"], initial["version"])
                self.assertEqual(failed["attempts"], 0)
                self.assertIsNone(failed["mediaPlan"])

    def test_older_two_field_lines_get_safe_delivery_defaults(self):
        def remove_metadata(lines):
            for line in lines:
                for key in ("kind", "tone", "emotion"):
                    del line[key]

        engine = StoryEngine(ChangingProvider(remove_metadata), pipeline="adaptive")
        result = engine.answer(engine.start("legacy-client"), "paper")
        self.assertEqual(result["decision"], "accept", result)
        self.assert_lines(result)
        pig = next(line for line in result["lines"] if line["speakerId"] == "pig1")
        self.assertEqual(pig["tone"], STORIES["en"]["characters"]["pig1"]["defaultTone"])

    def test_cast_members_outside_the_authored_scene_cannot_add_dialogue(self):
        for language in ("en", "ko"):
            for pipeline in ("adaptive", "two_call"):
                for speaker, english, korean in (
                        ("wolf", "I'll give it a puff!", "후후, 바람을 불어 볼까!"),
                        ("pig3", "Let's work together!", "우리 함께 지어 보자!")):
                    with self.subTest(language=language, pipeline=pipeline, speaker=speaker):
                        def add_speaker(lines):
                            lines.append({"speakerId": speaker, "kind": "dialogue", "tone": "playful",
                                          "emotion": "confident", "text": korean if language == "ko" else english})

                        engine = StoryEngine(ChangingProvider(add_speaker), language, pipeline=pipeline)
                        initial = engine.start("extra-speaker")
                        failed = engine.answer(initial, "ice cream")
                        self.assertEqual(failed["decision"], "service_error")
                        self.assertEqual(failed["storyState"], initial["storyState"])
                        self.assertEqual(failed["version"], initial["version"])
                        self.assertEqual(failed["attempts"], initial["attempts"])
                        self.assertIsNone(failed["mediaPlan"])
                        self.assertEqual(failed["diagnostics"]["performance"]["modelCalls"], 1)

    def test_compiled_script_has_all_resolved_scenes_and_spoken_questions_without_model_calls(self):
        with patch.object(MockProvider, "complete", side_effect=AssertionError("export must be local")):
            for language in ("en", "ko"):
                script = authored_script(language)
                self.assertEqual(script["language"], language)
                self.assertEqual(script["characters"], STORIES[language]["characters"])
                self.assertEqual(len(script["scenes"]), 28)
                self.assertEqual(len({scene["scriptId"] for scene in script["scenes"]}), 28)
                self.assertNotIn("{material}", json.dumps(script, ensure_ascii=False))
                for scene in script["scenes"]:
                    for line in scene["lines"]:
                        self.assertEqual(set(line), LINE_FIELDS)
                        self.assertIn(line["speakerId"], script["characters"])
                    if scene["question"]:
                        self.assertEqual(scene["questionLine"]["text"], scene["question"]["text"])
                        self.assertEqual(scene["questionLine"]["speakerId"], "narrator")
                        self.assertEqual(scene["questionLine"]["emotion"], "curious")
                        self.assertTrue(scene["question"]["id"].startswith(scene["sceneId"]))
                    else:
                        self.assertEqual(scene["sceneId"], "ending")
                        self.assertIsNone(scene["questionLine"])
                    if scene["material"]:
                        self.assertEqual(scene["outcome"], STORIES[language]["materials"][scene["material"]]["outcome"])
                        self.assertEqual(scene["facts"]["houseId"], scene["houseId"])
                self.assertEqual([scene["material"] for scene in script["scenes"] if scene["sceneId"] == "house3_predict"],
                                 ["brick", "stone"])

    def test_script_cli_writes_the_same_machine_readable_export(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "script.json"
            self.assertEqual(main(["--language", "ko", "--output", str(target)]), 0)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), authored_script("ko"))


if __name__ == "__main__":
    unittest.main()
