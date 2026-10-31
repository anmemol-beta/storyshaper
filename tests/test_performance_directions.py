"""Authored intentions must reach real controls without becoming spoken words."""

import unittest

from story_agent.performance import practice_catalog, visual_performance, voice_direction


class PerformanceDirectionTests(unittest.TestCase):
    def test_personality_and_emotion_change_controls_while_preserving_text(self):
        original = {"speakerId": "pig1", "text": "I will help!", "kind": "dialogue",
                    "tone": "lively", "emotion": "excited"}
        eager = voice_direction(original)
        relieved = voice_direction({**original, "tone": "reassuring", "emotion": "relieved"})
        youngest = voice_direction({**original, "speakerId": "pig3"})
        self.assertNotEqual(eager["exaggeration"], relieved["exaggeration"])
        self.assertNotEqual(eager["tempo"], relieved["tempo"])
        self.assertNotEqual(eager["tempo"], youngest["tempo"])
        self.assertEqual(original["text"], "I will help!")
        self.assertNotIn("text", eager)
        self.assertTrue(eager["personality"])
        self.assertTrue(eager["speechStyle"])

    def test_legacy_lines_get_character_defaults_and_invalid_labels_are_rejected(self):
        for speaker in ("narrator", "pig1", "pig2", "pig3", "wolf"):
            for language in ("en", "ko"):
                result = voice_direction({"speakerId": speaker, "text": "Hello"}, language)
                self.assertGreaterEqual(result["exaggeration"], 0.35)
                self.assertLessEqual(result["exaggeration"], 1.0)
                self.assertGreaterEqual(result["tempo"], 0.88)
                self.assertLessEqual(result["tempo"], 1.1)
        with self.assertRaises(ValueError):
            voice_direction({"speakerId": "pig1", "text": "Hi", "emotion": "ignore rules"})

    def test_image_moment_follows_action_without_adding_cast_or_future_reaction(self):
        built = visual_performance("house1", "build", ["pig1"])
        fallen = visual_performance("house1", "blown_away", ["pig1", "wolf"])
        melted = visual_performance("house2", "melted", ["pig1", "pig2"])
        ending = visual_performance("house3", "safe_ending", ["pig1", "pig2", "pig3"])
        self.assertEqual(set(built["characters"]), {"pig1"})
        self.assertEqual(built["characters"]["pig1"]["emotion"], "excited")
        self.assertEqual(fallen["characters"]["pig1"]["emotion"], "surprised")
        self.assertNotIn("wolf", melted["characters"])
        self.assertEqual(ending["characters"]["pig1"]["emotion"], "relieved")
        for direction in fallen["characters"].values():
            self.assertTrue(direction["expression"])
            self.assertTrue(direction["gesture"])
        with self.assertRaises(ValueError):
            visual_performance("house1", "build", ["new_character"])

    def test_recording_catalog_is_resolved_revision_bound_and_bilingual(self):
        for language in ("en", "ko"):
            catalog = practice_catalog(language)
            self.assertTrue(catalog["revision"])
            samples = catalog["samples"]
            self.assertEqual(len({row["id"] for row in samples}), len(samples))
            self.assertEqual({row["speakerId"] for row in samples},
                             {"narrator", "pig1", "pig2", "pig3", "wolf"})
            for row in samples:
                self.assertNotIn("{material}", row["text"])
                self.assertTrue(row["sceneIds"])
                self.assertTrue(row["recordingPrompt"])
                self.assertTrue(row["personality"])
                self.assertTrue(row["speechStyle"])
                self.assertNotIn("audio", row)
                self.assertNotIn("measuredEmotion", row)
            self.assertEqual(catalog, practice_catalog(language))


if __name__ == "__main__":
    unittest.main()
