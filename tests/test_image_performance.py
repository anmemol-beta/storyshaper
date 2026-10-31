"""Script-based illustration acting and cache boundaries, without model calls."""
from copy import deepcopy
import json
import time
import unittest
from unittest.mock import patch

from media.assets import ROOT
from media.contracts import normalize
from media.generate_scenes import recipe
from media.image_provider import scene_facts
from media.jobs import MediaJobs
from story_agent.engine import MockProvider, STORY, StoryEngine


class LiveRules(MockProvider):
    mode = "live"


def first_scenes(material="paper"):
    engine = StoryEngine(LiveRules(), "en")
    start = engine.start("acting-fixture")
    built = engine.answer(start, material)
    resolved = engine.answer(built, "Let's watch carefully together.")
    return engine, built, resolved


class ScriptImagePerformanceTests(unittest.TestCase):
    def test_current_cast_gets_personality_and_current_script_emotion_only(self):
        _, built, resolved = first_scenes()
        before = scene_facts(normalize(built), built["mediaPlan"])
        after = scene_facts(normalize(resolved), resolved["mediaPlan"])
        performer = before["visualPerformance"]["characters"]["pig1"]
        self.assertEqual(set(before["visualPerformance"]["characters"]), {"pig1"})
        self.assertEqual(performer["personality"], STORY["characters"]["pig1"]["personality"])
        self.assertEqual(performer["emotion"], STORY["houses"][0]["buildLines"][0]["emotion"])
        self.assertEqual(after["visualPerformance"]["characters"]["pig1"]["emotion"],
                         STORY["houses"][0]["reactionLines"][0]["emotion"])
        self.assertEqual(set(after["visualPerformance"]["characters"]), {"pig1", "wolf"})
        for directions in after["visualPerformance"]["characters"].values():
            self.assertTrue(directions["expression"])
            self.assertTrue(directions["gesture"])
        # The build's spoken setup may mention the wolf; this never adds him to the picture.
        self.assertTrue(any(line["speakerId"] == "wolf" for line in built["lines"]))
        self.assertNotIn("wolf", before["visualPerformance"]["characters"])

    def test_melting_does_not_invent_a_wolf_or_read_untrusted_prose(self):
        _, built, resolved = first_scenes("ice cream")
        plan = deepcopy(resolved["mediaPlan"])
        plan["narration"] = [{"speakerId": "wolf", "text": "private child words"}]
        plan["characterProfiles"] = {"wolf": {"personality": ["forged directions"]}}
        facts = scene_facts(normalize(resolved), plan)
        self.assertNotIn("wolf", facts["cast"])
        self.assertNotIn("wolf", facts["visualPerformance"]["characters"])
        self.assertNotIn("private child words", json.dumps(facts))
        self.assertNotIn("forged directions", json.dumps(facts))
        build_facts = scene_facts(normalize(built), built["mediaPlan"])
        self.assertNotIn("melted", build_facts["scene"])
        self.assertEqual(build_facts["visualPerformance"]["characters"]["pig1"]["emotion"], "excited")

    def test_language_switch_uses_identical_visual_direction_and_fingerprint(self):
        engine, built, _ = first_scenes()
        translated = engine.change_language(built, "ko")
        english = scene_facts(normalize(built), built["mediaPlan"])
        korean = scene_facts(normalize(translated), translated["mediaPlan"])
        self.assertEqual(english, korean)

    def test_static_recipe_uses_the_same_performance_as_live_generation(self):
        registry = json.loads((ROOT / "media/scene_registry.json").read_text())["images"]
        _, built, resolved = first_scenes("ice cream")
        for snapshot in (built, resolved):
            spec = normalize(snapshot)
            _, prompt, _, cast = recipe(spec.house_id, spec.material, spec.action, registry)
            directions = scene_facts(spec, snapshot["mediaPlan"])["visualPerformance"]
            self.assertIn(json.dumps(directions, ensure_ascii=False, sort_keys=True), prompt)
            self.assertEqual(set(directions["characters"]), set(cast))

    def test_acting_revision_does_not_reuse_an_old_generated_picture(self):
        engine, built, _ = first_scenes()
        translated = engine.change_language(built, "ko")

        class Images:
            def __init__(self):
                self.calls = []

            def generate(self, spec, plan, references, cancelled):
                self.calls.append(scene_facts(spec, plan))
                return (ROOT / "prototype/img/empty1.jpg").read_bytes()

        images = Images()
        manager = MediaJobs(image_provider=images)

        def finish(job):
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                result = manager.get(job["jobId"], job["sessionId"])
                if result["status"] not in {"queued", "running"}:
                    return result
                time.sleep(.005)
            self.fail("image fixture did not finish")

        try:
            first = finish(manager.request(built))
            self.assertTrue(first["generated"])
            original = first["image"]["url"]
            directions = deepcopy(images.calls[0]["visualPerformance"])
            directions["revision"] = "new-script-acting-revision"
            with patch("media.image_provider.visual_performance", return_value=directions):
                second = finish(manager.request(translated))
            self.assertEqual(len(images.calls), 2)
            self.assertNotEqual(second["image"]["url"], original)
            self.assertTrue(second["generated"])
        finally:
            manager.close()


if __name__ == "__main__":
    unittest.main()
