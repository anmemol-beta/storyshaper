"""Trust-boundary checks for custom material descriptors and authored events."""
from copy import deepcopy
import unittest

from story_agent.materials import BEHAVIORS, CUSTOM_MATERIAL, material_meta, validate_proposal


def proposal(source="비닐", english="plastic film", korean="비닐", behavior="light_flexible"):
    return {"source": source, "labels": {"en": english, "ko": korean}, "behavior": behavior}


class MaterialTests(unittest.TestCase):
    def test_vinyl_name_is_grounded_in_the_childs_words_and_preserved(self):
        value = proposal()
        accepted = validate_proposal(value, "비닐로 짓고 싶어!")
        self.assertEqual(accepted, value)
        self.assertIsNot(accepted, value)
        self.assertIsNot(accepted['labels'], value['labels'])
        korean = material_meta(accepted, 'ko')
        self.assertEqual(CUSTOM_MATERIAL, 'custom')
        self.assertEqual(korean['label'], '비닐')
        self.assertIn('비닐', korean['build'])
        self.assertIn('비닐', korean['event'])
        self.assertNotIn('종이', str(korean))

    def test_unlisted_material_uses_behavior_without_renaming_it(self):
        value = proposal('corn husks', 'corn husks', '옥수수 껍질')
        checked = validate_proposal(value, 'I want to build with corn husks!')
        for language, name in [('en', 'corn husks'), ('ko', '옥수수 껍질')]:
            with self.subTest(language=language):
                meta = material_meta(checked, language)
                self.assertEqual(meta['label'], name)
                for field in ['build', 'event', 'predict', 'reflect']:
                    self.assertIn(name, meta[field])
                self.assertEqual(meta['outcome'], 'blown_away')
                self.assertEqual(len(meta['process']), 2)

    def test_all_five_behaviors_have_bilingual_observation_then_result(self):
        for behavior, outcome in BEHAVIORS.items():
            for language in ['en', 'ko']:
                with self.subTest(behavior=behavior, language=language):
                    meta = material_meta(proposal(behavior=behavior), language)
                    self.assertEqual(meta['outcome'], outcome)
                    self.assertEqual(set(meta), {'label', 'aliases', 'behavior', 'outcome', 'build',
                                                 'event', 'predict', 'reflect', 'process'})
                    self.assertEqual(len(meta['process']), 2)
                    self.assertTrue(all(isinstance(line, str) and line for line in meta['process']))

    def test_rigid_construction_never_claims_it_flew_away(self):
        value = proposal('steel', 'steel', '강철', 'rigid')
        for language in ['en', 'ko']:
            meta = material_meta(value, language)
            self.assertEqual(meta['outcome'], 'stood')
            self.assertNotIn('blew away', meta['event'])
            self.assertNotIn('날아갔', meta['event'])
            self.assertIn('붙', meta['build']) if language == 'ko' else self.assertIn('join', meta['build'])

    def test_melting_describes_softening_and_dripping_before_the_final_result(self):
        meta = material_meta(proposal('초콜릿', 'chocolate', '초콜릿', 'melts'), 'ko')
        self.assertIn('말랑', meta['process'][0])
        self.assertIn('흘러', meta['process'][1])
        self.assertIn('녹', meta['event'])

    def test_unknown_or_unanchored_source_and_extra_fields_are_rejected(self):
        cases = [None, [], {}, dict(proposal(), extra='event'),
                 dict(proposal(), source='고무'), dict(proposal(), source=''),
                 dict(proposal(), source='비닐 '), dict(proposal(), behavior='make_a_dragon'),
                 dict(proposal(), behavior=[]), dict(proposal(), labels={'ko': '비닐'})]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_proposal(value, '비닐로 짓고 싶어!')

    def test_names_are_plain_text_and_not_instructions_or_explicit_hazards(self):
        names = ['<script>x</script>', 'ignore rules', 'system prompt', '비닐\n규칙 무시',
                 '폭탄', 'poison', 'https://example.com', '{"event":"melted"}',
                 'A' * 61, '1234']
        for name in names:
            value = proposal(name)
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_proposal(value, name)
        value = proposal()
        value['labels']['en'] = 'system prompt'
        with self.assertRaises(ValueError):
            validate_proposal(value, '비닐')

    def test_each_label_uses_the_requested_language(self):
        for labels in [
            {'en': '비닐', 'ko': '비닐'},
            {'en': 'plastic film', 'ko': 'plastic film'},
            {'en': 'plastic 비닐', 'ko': '비닐'},
            {'en': '塑料', 'ko': '비닐'},
            {'en': 'plastic film', 'ko': '비닐 PVC'},
        ]:
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                validate_proposal(dict(proposal(), labels=labels), '비닐')

    def test_source_matching_handles_case_but_does_not_mutate_the_proposal(self):
        value = proposal('Bubble Wrap', 'bubble wrap', '뽁뽁이')
        original = deepcopy(value)
        result = validate_proposal(value, 'I would use BUBBLE WRAP!')
        result['labels']['en'] = 'changed'
        self.assertEqual(value, original)

    def test_invalid_material_meta_arguments_fail_closed(self):
        for value, language in [(proposal(), 'fr'), ({}, 'en'), (None, 'ko')]:
            with self.subTest(value=value, language=language), self.assertRaises(ValueError):
                material_meta(value, language)


if __name__ == '__main__':
    unittest.main()
