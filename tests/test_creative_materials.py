"""Trust-boundary and progression tests for model-described story materials.

Providers here are explicit offline fixtures; no real model or media generation is used.
"""

from copy import deepcopy
import json
import re
import unittest

from story_agent import MockProvider, StoryEngine
from story_agent.server import APIError, Playground
from story_agent.engine import STORY, STORIES


VINYL = {"source": "비닐", "labels": {"en": "vinyl", "ko": "비닐"},
         "behavior": "light_flexible"}
FELT = {"source": "felt", "labels": {"en": "felt", "ko": "펠트"},
        "behavior": "light_flexible"}
STEEL = {"source": "steel", "labels": {"en": "steel", "ko": "강철"},
         "behavior": "rigid"}


class DescriptorProvider(MockProvider):
    story_pipeline = "legacy_three_call"  # Preserve old phase-specific adversarial fixtures.
    """Return a supplied descriptor while retaining the normal compose/review phases."""

    def __init__(self, descriptors=(), *, review_passes=True, interpretation=None):
        self.descriptors = deepcopy(list(descriptors))
        self.review_passes = review_passes
        self.interpretation = interpretation
        self.calls = []

    def complete(self, instructions, payload):
        self.calls.append(deepcopy(payload))
        if payload["phase"] == "interpret" and payload["stage"] == "choose":
            if self.interpretation is not None:
                return deepcopy(self.interpretation)
            for descriptor in self.descriptors:
                if descriptor["source"].lower() in payload["answer"].lower():
                    return {"decision": "accept", "material": deepcopy(descriptor),
                            "reason": "creative_material_identified"}
        if payload["phase"] == "review":
            return {"safe": self.review_passes, "coherent": self.review_passes}
        return super().complete(instructions, payload)


def narrative(snapshot):
    return " ".join(line["text"] for line in snapshot["lines"])


def answer_body(snapshot, answer, request_id):
    return {"sessionId": snapshot["sessionId"], "version": snapshot["version"],
            "questionId": snapshot["question"]["id"], "requestId": request_id,
            "answer": answer}


class CreativeMaterialTests(unittest.TestCase):
    def assert_accepted(self, result):
        self.assertEqual(result["decision"], "accept", result)
        self.assertFalse(result["diagnostics"].get("authoredFallback"), result)

    def assert_rejected_model_output(self, start, result, phase="interpret"):
        self.assertEqual(result["decision"], "service_error", result)
        self.assertEqual(result["diagnostics"]["phase"], phase)
        self.assertEqual(result["storyState"], start["storyState"])
        self.assertEqual(result["version"], start["version"])
        self.assertEqual(result["attempts"], start["attempts"])
        self.assertIsNone(result["mediaPlan"])

    def reach_last_choose(self, engine):
        state = engine.start("last-house")
        for material in ("paper", "wood"):
            state = engine.answer(state, material)
            self.assert_accepted(state)
            state = engine.answer(state, "The walls might stay standing")
            self.assert_accepted(state)
            state = engine.answer(state, "The pigs helped each other build")
            self.assert_accepted(state)
        self.assertEqual(state["sceneId"], "house3_choose")
        return state

    def test_vinyl_keeps_child_material_identity_in_state_question_and_media_plan(self):
        for language in ("en", "ko"):
            with self.subTest(language=language):
                provider = DescriptorProvider([VINYL])
                engine = StoryEngine(provider, language)
                start = engine.start("vinyl")
                original = deepcopy(start)
                chosen = engine.answer(start, "비닐로 집을 만들래!")
                self.assert_accepted(chosen)
                self.assertEqual(start, original, "The caller's snapshot must remain immutable")
                house = chosen["storyState"]["houses"][0]
                self.assertEqual(house["material"], "custom")
                self.assertEqual(house["materialSpec"], VINYL)
                self.assertEqual(house["outcome"], "blown_away")
                self.assertFalse(house["resolved"])
                label = VINYL["labels"][language]
                self.assertIn(label, narrative(chosen))
                self.assertIn(label, chosen["question"]["text"])
                self.assertNotRegex(narrative(chosen), r"paper|종이")
                self.assertEqual(len(chosen["question"]["choices"]), 3)
                plan = chosen["mediaPlan"]
                self.assertEqual(plan["material"], "custom")
                self.assertEqual(plan["materialLabel"], label)
                self.assertEqual(plan["materialSpec"], VINYL)
                self.assertEqual(plan["status"], "validated_plan_only")
                self.assertFalse(any(key in plan for key in ("imageUrl", "videoUrl", "generatedAsset")))
                self.assertEqual([call["phase"] for call in provider.calls], ["interpret", "compose", "review"])
                json.dumps(chosen)

    def test_unseen_material_works_from_provider_descriptor_without_expanding_alias_table(self):
        provider = DescriptorProvider([FELT])
        engine = StoryEngine(provider)
        chosen = engine.answer(engine.start("felt"), "felt")
        self.assert_accepted(chosen)
        self.assertEqual(chosen["storyState"]["houses"][0]["materialSpec"], FELT)
        reflected = engine.answer(chosen, "The house might stay standing")
        self.assert_accepted(reflected)
        self.assertIn("felt", narrative(reflected))
        self.assertEqual(reflected["mediaPlan"]["outcome"], "blown_away")
        self.assertTrue(reflected["storyState"]["houses"][0]["resolved"])
        self.assertEqual(reflected["sceneId"], "house1_reflect")
        self.assertEqual(reflected["version"], 2, "The process must not create another turn")

    def test_each_creative_behavior_uses_its_authored_consequence(self):
        descriptors = [
            (VINYL, "blown_away"),
            ({"source": "beads", "labels": {"en": "beads", "ko": "구슬"}, "behavior": "loose_pieces"}, "collapsed"),
            ({"source": "jelly", "labels": {"en": "jelly", "ko": "젤리"}, "behavior": "edible"}, "eaten"),
            ({"source": "wax", "labels": {"en": "wax", "ko": "밀랍"}, "behavior": "melts"}, "melted"),
        ]
        for descriptor, outcome in descriptors:
            with self.subTest(behavior=descriptor["behavior"]):
                engine = StoryEngine(DescriptorProvider([descriptor]))
                chosen = engine.answer(engine.start("behavior"), descriptor["source"])
                self.assert_accepted(chosen)
                reflected = engine.answer(chosen, "Let's watch the walls together")
                self.assert_accepted(reflected)
                self.assertEqual(reflected["mediaPlan"]["outcome"], outcome)
                self.assertEqual(reflected["storyState"]["events"], ["first_house_cannot_shelter"])
                self.assertEqual(len(reflected["question"]["choices"]), 3)

    def test_custom_materials_complete_nine_turns_with_fixed_events_and_safe_ending(self):
        provider = DescriptorProvider([VINYL, FELT, STEEL])
        engine = StoryEngine(provider)
        state = engine.start("creative-full-story")
        for index, descriptor in enumerate((VINYL, FELT, STEEL), start=1):
            state = engine.answer(state, descriptor["source"])
            self.assert_accepted(state)
            state = engine.answer(state, "The house might stay standing")
            self.assert_accepted(state)
            self.assertEqual(state["sceneId"], f"house{index}_reflect")
            self.assertTrue(state["storyState"]["houses"][-1]["resolved"])
            state = engine.answer(state, "They can help each other build strong walls")
        self.assertEqual(state["decision"], "complete", state)
        self.assertEqual(state["version"], 9)
        self.assertIsNone(state["question"])
        self.assertEqual([house["material"] for house in state["storyState"]["houses"]], ["custom"] * 3)
        self.assertEqual([house["materialSpec"] for house in state["storyState"]["houses"]], [VINYL, FELT, STEEL])
        self.assertEqual(state["storyState"]["events"], ["first_house_cannot_shelter", "second_house_cannot_shelter",
                          "third_house_stands", "pigs_safe_together", "wolf_leaves"])
        self.assertIn("safe", narrative(state))
        self.assertEqual([call["phase"] for call in provider.calls], ["interpret", "compose", "review"] * 9)

    def test_rigid_first_house_and_weak_final_house_redirect_without_changing_facts(self):
        engine = StoryEngine(DescriptorProvider([VINYL, STEEL]))
        start = engine.start("strong-first")
        strong = engine.answer(start, "steel")
        self.assertEqual(strong["decision"], "redirect", strong)
        self.assertEqual(strong["reason"], "material_not_allowed")
        self.assertEqual(strong["attempts"], 1)
        self.assertEqual(strong["storyState"], start["storyState"])
        final = self.reach_last_choose(engine)
        weak = engine.answer(final, "비닐")
        self.assertEqual(weak["decision"], "redirect", weak)
        self.assertEqual(weak["reason"], "material_not_allowed")
        self.assertEqual(weak["attempts"], 1)
        self.assertEqual(weak["storyState"], final["storyState"])
        accepted = engine.answer(final, "steel")
        self.assert_accepted(accepted)
        self.assertEqual(accepted["storyState"]["houses"][-1]["outcome"], "stood")

    def test_language_switch_preserves_descriptor_source_events_and_three_choices_without_calls(self):
        provider = DescriptorProvider([VINYL])
        engine = StoryEngine(provider)
        state = engine.answer(engine.start("creative-language"), "비닐")
        self.assert_accepted(state)
        state = engine.answer(state, "The light walls may move in the wind")
        self.assert_accepted(state)
        count = len(provider.calls)
        before = deepcopy(state)
        korean = engine.change_language(state, "ko")
        self.assertEqual(len(provider.calls), count)
        self.assertEqual(korean["storyState"]["houses"], before["storyState"]["houses"])
        self.assertEqual(korean["storyState"]["events"], before["storyState"]["events"])
        self.assertEqual(korean["mediaPlan"]["materialSpec"]["source"], "비닐")
        self.assertEqual(korean["mediaPlan"]["materialLabel"], "비닐")
        self.assertIn("비닐", korean["question"]["text"])
        self.assertEqual(len(korean["question"]["choices"]), 3)
        english = engine.change_language(korean, "en")
        self.assertEqual(len(provider.calls), count)
        self.assertEqual(english["storyState"], before["storyState"])
        self.assertEqual(english["mediaPlan"]["materialSpec"], VINYL)
        self.assertEqual(english["mediaPlan"]["materialLabel"], "vinyl")
        self.assertTrue(english["storyState"]["houses"][0]["resolved"])

    def test_failed_review_does_not_commit_a_custom_material_or_count_a_child_failure(self):
        provider = DescriptorProvider([VINYL], review_passes=False)
        engine = StoryEngine(provider)
        start = engine.start("creative-rejected-review")
        result = engine.answer(start, "비닐")
        self.assert_rejected_model_output(start, result, "review")
        self.assertEqual([call["phase"] for call in provider.calls], ["interpret", "compose", "review"])

    def test_invalid_descriptors_fail_before_composition_without_mutating_state_or_attempts(self):
        invalid = [
            dict(VINYL, source="not in the child's answer"),
            dict(VINYL, behavior="magic"),
            dict(VINYL, labels={"en": "vinyl"}),
            dict(VINYL, labels={"en": "", "ko": "비닐"}),
            dict(VINYL, labels={"en": "vinyl", "ko": "vinyl"}),
            dict(VINYL, labels={"en": "vinyl", "ko": "비닐"}, nextSceneId="ending"),
            dict(VINYL, source="비닐", labels={"en": "bomb", "ko": "폭탄"}),
            dict(VINYL, source="비닐", labels={"en": "sun", "ko": "태양"}, behavior="rigid"),
        ]
        for descriptor in invalid:
            with self.subTest(descriptor=descriptor):
                provider = DescriptorProvider(interpretation={"decision": "accept", "material": descriptor,
                                                             "reason": "model_proposal"})
                engine = StoryEngine(provider)
                start = engine.start("invalid-creative")
                result = engine.answer(start, "비닐")
                self.assert_rejected_model_output(start, result)
                self.assertEqual([call["phase"] for call in provider.calls], ["interpret"])

    def test_model_cannot_relabel_an_explicit_known_material_as_a_custom_one(self):
        descriptor = {"source": "paper", "labels": {"en": "steel", "ko": "강철"}, "behavior": "rigid"}
        provider = DescriptorProvider([descriptor])
        engine = StoryEngine(provider)
        start = engine.start("known-material")
        result = engine.answer(start, "paper")
        self.assert_rejected_model_output(start, result)

    def test_unsupported_safe_material_and_unclear_answer_keep_distinct_reasons(self):
        provider = DescriptorProvider(interpretation={"decision": "clarify", "material": None,
                                                     "reason": "unsupported_material"})
        engine = StoryEngine(provider, "ko")
        start = engine.start("unsupported-material")
        unsupported = engine.answer(start, "별빛으로 집을 지을래요")
        self.assertEqual(unsupported["reason"], "unsupported_material")
        self.assertEqual(unsupported["decision"], "clarify")
        self.assertEqual(unsupported["attempts"], 1)
        self.assertEqual(unsupported["storyState"], start["storyState"])
        unclear = engine.answer(start, "")
        self.assertEqual(unclear["reason"], "unclear_answer")
        self.assertNotEqual(narrative(unsupported), narrative(unclear))
        self.assertEqual(unclear["attempts"], 1)

    def test_unsafe_child_input_still_uses_existing_failure_policy_without_provider_calls(self):
        provider = DescriptorProvider([VINYL])
        engine = StoryEngine(provider)
        start = engine.start("unsafe-child-input")
        result = engine.answer(start, "비닐 폭탄으로 집을 지을래")
        self.assertEqual(result["decision"], "redirect")
        self.assertEqual(result["reason"], "unsafe_request")
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(result["storyState"], start["storyState"])
        self.assertEqual(provider.calls, [])

    def test_mock_korean_prediction_shows_process_before_result_in_the_same_turn(self):
        engine = StoryEngine(MockProvider(), "ko")
        chosen = engine.answer(engine.start("melting-process"), "아이스크림")
        self.assert_accepted(chosen)
        reflected = engine.answer(chosen, "더 커질 거 같아!")
        self.assert_accepted(reflected)
        self.assertEqual(reflected["version"], 2)
        self.assertEqual(reflected["sceneId"], "house1_reflect")
        self.assertEqual(reflected["question"]["intent"], "reflect_on_cause")
        self.assertEqual(reflected["storyState"]["events"], ["first_house_cannot_shelter"])
        self.assertTrue(reflected["storyState"]["houses"][0]["resolved"])
        text = narrative(reflected)
        process = re.search(r"물방울|물|말랑|부드러|흐르", text)
        result = re.search(r"녹", text)
        self.assertIsNotNone(process, text)
        self.assertIsNotNone(result, text)
        self.assertLess(process.start(), result.start(), text)
        self.assertEqual(reflected["mediaPlan"]["action"], "melted")

    def test_session_replay_and_localization_keep_custom_material_without_model_reexecution(self):
        provider = DescriptorProvider([VINYL])
        app = Playground(provider_factory=lambda _: provider, pipeline="legacy_three_call")
        start = app.create("mock")
        body = answer_body(start, "비닐", "creative-1")
        chosen = app.answer(body)
        self.assert_accepted(chosen)
        count = len(provider.calls)
        self.assertEqual(app.answer(body), chosen)
        self.assertEqual(len(provider.calls), count)
        korean = app.change_language({"sessionId": chosen["sessionId"], "version": chosen["version"], "language": "ko"})
        self.assertEqual(len(provider.calls), count)
        self.assertEqual(korean["storyState"]["houses"][0]["materialSpec"], VINYL)
        self.assertEqual(app.sessions[start["sessionId"]].turns, 1)
        with self.assertRaises(APIError) as caught:
            app.answer(body)
        self.assertEqual(caught.exception.code, "stale_question")
        reflect = app.answer(answer_body(korean, "벽이 바람에 흔들릴 것 같아요", "creative-2"))
        self.assert_accepted(reflect)
        self.assertEqual(reflect["sceneId"], "house1_reflect")
        self.assertEqual(reflect["storyState"]["houses"][0]["materialSpec"], VINYL)
        self.assertEqual(app.sessions[start["sessionId"]].turns, 2)


    def test_known_word_inside_compound_keeps_the_complete_custom_material_name(self):
        cups = {"source": "종이컵", "labels": {"en": "paper cups", "ko": "종이컵"},
                "behavior": "loose_pieces"}
        engine = StoryEngine(DescriptorProvider([cups]), "ko")
        chosen = engine.answer(engine.start("compound-material"), "종이컵으로 집을 지을래요")
        self.assert_accepted(chosen)
        self.assertEqual(chosen["storyState"]["houses"][0]["material"], "custom")
        self.assertEqual(chosen["storyState"]["houses"][0]["materialSpec"], cups)
        self.assertIn("종이컵", narrative(chosen))
        self.assertIn("종이컵", chosen["question"]["text"])
        self.assertEqual(chosen["mediaPlan"]["materialLabel"], "종이컵")
        self.assertEqual(chosen["mediaPlan"]["outcome"], "collapsed")

    def test_localizing_next_house_choice_preserves_the_finished_houses_media_material(self):
        provider = DescriptorProvider([VINYL, FELT])
        engine = StoryEngine(provider)
        state = engine.start("move-custom-house")
        for index, descriptor in enumerate((VINYL, FELT), start=1):
            state = engine.answer(state, descriptor["source"])
            self.assert_accepted(state)
            state = engine.answer(state, "The walls might move in the wind")
            self.assert_accepted(state)
            state = engine.answer(state, "The pigs helped each other build")
            self.assert_accepted(state)
            self.assertEqual(state["sceneId"], f"house{index + 1}_choose")
            self.assertEqual(state["mediaPlan"]["houseId"], f"house{index}")
            self.assertEqual(state["mediaPlan"]["materialSpec"], descriptor)
            count = len(provider.calls)
            korean = engine.change_language(state, "ko")
            self.assertEqual(len(provider.calls), count)
            self.assertEqual(korean["storyState"]["houses"], state["storyState"]["houses"])
            self.assertEqual(korean["storyState"]["events"], state["storyState"]["events"])
            self.assertEqual(korean["mediaPlan"]["houseId"], f"house{index}")
            self.assertEqual(korean["mediaPlan"]["materialSpec"], descriptor)
            self.assertEqual(korean["mediaPlan"]["materialLabel"], descriptor["labels"]["ko"])
            self.assertEqual(korean["mediaPlan"]["materialId"], state["mediaPlan"]["materialId"])
            self.assertEqual(len(korean["question"]["choices"]), 3)
            state = engine.change_language(korean, "en")
            self.assertEqual(len(provider.calls), count)
            self.assertEqual(state["mediaPlan"]["materialLabel"], descriptor["labels"]["en"])

    def test_custom_material_ids_and_data_stay_isolated_between_sessions_and_global_story(self):
        original_story, original_stories = deepcopy(STORY), deepcopy(STORIES)
        provider = DescriptorProvider([VINYL, FELT])
        first_engine = StoryEngine(provider)
        second_engine = StoryEngine(provider)
        first = first_engine.answer(first_engine.start("first-custom-session"), "비닐")
        second = second_engine.answer(second_engine.start("second-custom-session"), "felt")
        repeated = second_engine.answer(second_engine.start("repeat-custom-session"), "비닐")
        for state in (first, second, repeated):
            self.assert_accepted(state)
        self.assertNotEqual(first["mediaPlan"]["materialId"], second["mediaPlan"]["materialId"])
        self.assertEqual(first["mediaPlan"]["materialId"], repeated["mediaPlan"]["materialId"])
        self.assertEqual(first["mediaPlan"]["materialId"], first["storyState"]["houses"][0]["materialId"])
        self.assertEqual(first["storyState"]["houses"][0]["materialSpec"], VINYL)
        self.assertEqual(second["storyState"]["houses"][0]["materialSpec"], FELT)
        second["storyState"]["houses"][0]["materialSpec"]["labels"]["en"] = "changed by another caller"
        self.assertEqual(first["storyState"]["houses"][0]["materialSpec"], VINYL)
        self.assertEqual(second["mediaPlan"]["materialSpec"], FELT)
        self.assertEqual(STORY, original_story)
        self.assertEqual(STORIES, original_stories)

    def test_custom_story_can_finish_with_authored_choices_during_persistent_model_outage(self):
        class OutageProvider(DescriptorProvider):
            unavailable = False
            attempts = 0

            def complete(self, instructions, payload):
                self.attempts += 1
                if self.unavailable:
                    raise TimeoutError("fixture model outage")
                return super().complete(instructions, payload)

        provider = OutageProvider([VINYL])
        engine = StoryEngine(provider, "ko")
        state = engine.answer(engine.start("custom-outage"), "비닐")
        self.assert_accepted(state)
        provider.unavailable = True
        before = deepcopy(state)
        failed = engine.answer(state, "집이 그대로 있을 것 같아요")
        self.assertEqual(failed["decision"], "service_error")
        self.assertEqual(failed["storyState"], before["storyState"])
        self.assertEqual(failed["attempts"], before["attempts"])
        self.assertTrue(failed["choiceMode"])
        attempts_after_failure = provider.attempts
        state = failed
        accepted_turns = 1
        while state["question"]:
            self.assertEqual(len(state["question"]["choices"]), 3)
            choice = state["question"]["choices"][0]
            state = engine.answer(state, "", choice_id=choice["id"])
            accepted_turns += 1
            self.assertTrue(state["diagnostics"]["authoredFallback"])
            self.assertIn(state["decision"], {"accept", "complete"}, state)
            self.assertEqual(provider.attempts, attempts_after_failure, "Authored recovery must not call the failed model")
            self.assertLessEqual(accepted_turns, 9)
        self.assertEqual(accepted_turns, 9)
        self.assertEqual(state["version"], 9)
        self.assertEqual(state["decision"], "complete")
        self.assertEqual(state["storyState"]["houses"][0]["materialSpec"], VINYL)
        self.assertEqual(state["storyState"]["events"], ["first_house_cannot_shelter", "second_house_cannot_shelter",
                          "third_house_stands", "pigs_safe_together", "wolf_leaves"])

    def test_english_custom_source_is_preserved_while_korean_output_uses_its_korean_label(self):
        engine = StoryEngine(DescriptorProvider([FELT]), "ko")
        chosen = engine.answer(engine.start("english-source-korean-output"), "I want a felt house")
        self.assert_accepted(chosen)
        self.assertEqual(chosen["storyState"]["houses"][0]["materialSpec"]["source"], "felt")
        self.assertEqual(chosen["mediaPlan"]["materialLabel"], "펠트")
        self.assertIn("펠트", narrative(chosen))
        self.assertIn("펠트", chosen["question"]["text"])
        self.assertNotRegex(narrative(chosen) + chosen["question"]["text"], r"[a-zA-Z]")
        reflected = engine.answer(chosen, "The house might stay standing")
        self.assert_accepted(reflected)
        self.assertEqual(reflected["storyState"]["houses"][0]["materialSpec"], FELT)
        self.assertIn("펠트", narrative(reflected))
        self.assertNotRegex(narrative(reflected), r"[a-zA-Z]")

    def test_model_cannot_rename_the_source_in_its_original_language_even_for_other_output_language(self):
        for source, labels, output_language in [
            ("비닐", {"en": "vinyl", "ko": "고무"}, "en"),
            ("felt", {"en": "rubber", "ko": "펠트"}, "ko"),
        ]:
            with self.subTest(source=source, output_language=output_language):
                descriptor = {"source": source, "labels": labels, "behavior": "light_flexible"}
                provider = DescriptorProvider([descriptor])
                engine = StoryEngine(provider, output_language)
                start = engine.start("renamed-source")
                result = engine.answer(start, source)
                self.assert_rejected_model_output(start, result)
                self.assertEqual([call["phase"] for call in provider.calls], ["interpret"])


    def test_custom_prediction_reflection_choices_and_facts_do_not_inherit_legacy_material_names(self):
        descriptors = [
            {"source": "wax", "labels": {"en": "wax", "ko": "밀랍"}, "behavior": "melts"},
            {"source": "beads", "labels": {"en": "beads", "ko": "구슬"}, "behavior": "loose_pieces"},
            {"source": "jelly", "labels": {"en": "jelly", "ko": "젤리"}, "behavior": "edible"},
        ]
        legacy_names = r"ice ?cream|wood|cookie|아이스크림|나무|과자"
        for language in ("en", "ko"):
            for descriptor in descriptors:
                with self.subTest(language=language, behavior=descriptor["behavior"]):
                    provider = DescriptorProvider([descriptor])
                    engine = StoryEngine(provider, language)
                    chosen = engine.answer(engine.start("custom-choice-identity"), descriptor["source"])
                    self.assert_accepted(chosen)
                    reflected = engine.answer(chosen, "The walls might stay the same")
                    self.assert_accepted(reflected)
                    for snapshot in (chosen, reflected):
                        question = snapshot["question"]
                        self.assertEqual(len(question["choices"]), 3)
                        self.assertIn(descriptor["labels"][language], question["text"])
                        for choice in question["choices"]:
                            self.assertLessEqual(len(choice["label"].split()), 3)
                            self.assertNotRegex(choice["label"], r"[.!?。！？]")
                            self.assertNotEqual(choice["label"], choice["answer"])
                        choice_text = " ".join(choice["label"] + " " + choice["answer"] for choice in question["choices"])
                        self.assertIn(descriptor["labels"][language], choice_text)
                        self.assertNotRegex(choice_text.lower(), legacy_names)
                        self.assertEqual(snapshot["mediaPlan"]["materialSpec"], descriptor)
                    fact_payloads = [call["facts"] for call in provider.calls if call["phase"] in {"compose", "review"}]
                    self.assertEqual(len(fact_payloads), 4)
                    for facts in fact_payloads:
                        self.assertEqual(facts["material"], "custom")
                        self.assertEqual(facts["materialLabel"], descriptor["labels"][language])
                        self.assertEqual(facts["materialSpec"], descriptor)
                        self.assertNotRegex(json.dumps(facts, ensure_ascii=False).lower(), legacy_names)

    def test_third_house_ice_cream_sticks_are_not_rejected_as_the_icecream_alias(self):
        sticks = {"source": "아이스크림 막대", "labels": {"en": "ice cream sticks", "ko": "아이스크림 막대"},
                  "behavior": "rigid"}
        provider = DescriptorProvider([sticks])
        engine = StoryEngine(provider, "ko")
        final = self.reach_last_choose(engine)
        provider.calls.clear()
        chosen = engine.answer(final, "아이스크림 막대로 함께 튼튼한 집을 지을래요")
        self.assert_accepted(chosen)
        self.assertEqual(chosen["sceneId"], "house3_predict")
        self.assertEqual(chosen["storyState"]["houses"][-1]["materialSpec"], sticks)
        self.assertEqual(chosen["mediaPlan"]["materialLabel"], "아이스크림 막대")
        self.assertEqual(chosen["mediaPlan"]["outcome"], "stood")
        self.assertIn("아이스크림 막대", chosen["question"]["text"])
        self.assertEqual([call["phase"] for call in provider.calls], ["interpret", "compose", "review"])

    def test_incorrect_custom_strength_is_reviewed_before_it_can_count_as_a_child_failure(self):
        incorrect_vinyl = dict(VINYL, behavior="rigid")
        provider = DescriptorProvider([incorrect_vinyl], review_passes=False)
        engine = StoryEngine(provider, "ko")
        start = engine.start("incorrect-strength")
        result = engine.answer(start, "비닐로 집을 지을래요")
        self.assert_rejected_model_output(start, result, "review")
        self.assertEqual(result["attempts"], 0)
        self.assertEqual([call["phase"] for call in provider.calls], ["interpret", "review"])
        self.assertEqual(provider.calls[1]["materialSpec"], incorrect_vinyl)
        self.assertNotIn("candidate", provider.calls[1], "A material constraint is reviewed before composing child-facing text")


    def test_model_cannot_reduce_a_compound_child_choice_to_a_known_material(self):
        provider = DescriptorProvider(interpretation={"decision": "accept", "material": "paper",
                                                     "reason": "material_identified"})
        engine = StoryEngine(provider, "ko")
        start = engine.start("compound-not-plain-paper")
        result = engine.answer(start, "종이컵으로 집을 지을래요")
        self.assert_rejected_model_output(start, result)
        self.assertEqual(result["attempts"], 0)
        self.assertEqual([call["phase"] for call in provider.calls], ["interpret"])

    def test_model_cannot_select_a_rejected_known_material_from_an_alternative_answer(self):
        provider = DescriptorProvider(interpretation={"decision": "accept", "material": "wood",
                                                     "reason": "material_identified"})
        engine = StoryEngine(provider, "ko")
        start = engine.start("rejected-wood-not-selected")
        result = engine.answer(start, "나무는 싫고 비닐로 집을 지을래요")
        self.assert_rejected_model_output(start, result)
        self.assertEqual(result["attempts"], 0)
        self.assertEqual([call["phase"] for call in provider.calls], ["interpret"])


if __name__ == "__main__":
    unittest.main()
