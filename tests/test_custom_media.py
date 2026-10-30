"""Custom material identity and missing-art integration; no network calls."""
from copy import deepcopy
import time
import unittest

from media.assets import AssetRegistry
from media.contracts import InvalidPlan, normalize
from media.jobs import MediaJobs
from story_agent.engine import MockProvider, StoryEngine, _material_id


def chosen(answer='비닐로 집을 만들래!', session='custom', language='ko'):
    engine = StoryEngine(MockProvider(), language)
    state = engine.answer(engine.start(session), answer)
    if state['decision'] != 'accept':
        raise AssertionError(state)
    return engine, state


class CustomMediaTests(unittest.TestCase):
    def test_custom_nine_turn_story_normalizes_without_substituting_art(self):
        engine = StoryEngine(MockProvider(), 'ko')
        state = engine.start('complete-custom')
        registry = AssetRegistry()
        for material in ('비닐', '펠트', '강철'):
            for answer in (material, '벽이 어떻게 될지 함께 봐요', '함께 도와서 집을 지어요'):
                state = engine.answer(state, answer)
                self.assertIn(state['decision'], ('accept', 'complete'))
                spec = normalize(state)
                self.assertEqual(spec.material, 'custom')
                self.assertEqual(spec.material_id, state['mediaPlan']['materialId'])
                self.assertEqual(spec.material_spec, state['mediaPlan']['materialSpec'])
                if spec.action not in {'move_to_next_house', 'safe_ending'}:
                    self.assertIn(spec.material_id, spec.asset_key)
                    self.assertIsNone(registry.image(spec))
                    self.assertIsNone(registry.clip(spec))
                else:
                    self.assertIsNotNone(registry.image(spec))
        self.assertEqual(state['version'], 9)
        self.assertEqual(spec.asset_key, 'ending')

    def test_missing_custom_art_is_a_normal_truthful_media_fallback(self):
        _, state = chosen()
        manager = MediaJobs()
        try:
            job = manager.request(state)
            for _ in range(100):
                result = manager.get(job['jobId'], state['sessionId'])
                if result['status'] not in {'queued', 'running'}:
                    break
                time.sleep(.005)
            self.assertEqual(result['status'], 'fallback')
            self.assertEqual(result['reason'], 'scene_asset_unavailable')
            self.assertTrue(result['apply'])
            self.assertTrue(result['fallback']['keepCurrentImage'])
            self.assertIn('picture for this material is not available', result['fallback']['message'])
            self.assertIsNone(result['image'])
            self.assertIsNone(result['video'])
            self.assertFalse(result['generated'])
            self.assertEqual(result['spec']['material_id'], state['mediaPlan']['materialId'])
            self.assertEqual(result['spec']['material_spec'], state['mediaPlan']['materialSpec'])
            self.assertEqual(manager.request(state)['jobId'], job['jobId'])
        finally:
            manager.close()

    def test_language_change_keeps_identity_and_same_session_content_key(self):
        engine, state = chosen()
        translated = engine.change_language(state, 'en')
        first, second = normalize(state), normalize(translated)
        self.assertEqual(first.material_spec, second.material_spec)
        self.assertEqual(first.material_id, second.material_id)
        self.assertEqual(first.asset_key, second.asset_key)
        self.assertEqual(AssetRegistry().content_key(first), AssetRegistry().content_key(second))

    def test_custom_cache_keys_distinguish_materials_and_sessions(self):
        registry = AssetRegistry()
        vinyl = normalize(chosen(session='one')[1])
        felt = normalize(chosen('펠트로 집을 만들래!', session='one')[1])
        other_session = normalize(chosen(session='two')[1])
        self.assertNotEqual(vinyl.asset_key, felt.asset_key)
        self.assertNotEqual(registry.content_key(vinyl), registry.content_key(felt))
        self.assertEqual(vinyl.material_id, other_session.material_id)
        self.assertNotEqual(registry.content_key(vinyl), registry.content_key(other_session))

    def test_tampered_custom_plan_cannot_start_media(self):
        _, state = chosen()
        for field, value in (
                ('materialId', 'custom-other'), ('materialLabel', '종이'),
                ('construction', 'Build with paper.'), ('material', 'paper'),
                ('outcome', 'stood'), ('action', 'stood'),
                ('materialSpec', chosen('펠트')[1]['mediaPlan']['materialSpec'])):
            tampered = deepcopy(state)
            tampered['mediaPlan'][field] = value
            with self.subTest(field=field), self.assertRaises(InvalidPlan):
                normalize(tampered)

    def test_custom_state_identity_is_checked_even_if_plan_matches_the_tampering(self):
        _, state = chosen()
        for field, value in (('materialId', 'custom-other'), ('outcome', 'stood')):
            tampered = deepcopy(state)
            tampered['storyState']['houses'][0][field] = value
            tampered['mediaPlan']['houses'] = deepcopy(tampered['storyState']['houses'])
            tampered['mediaPlan'][field] = value
            with self.subTest(field=field), self.assertRaises(InvalidPlan):
                normalize(tampered)

    def test_rigid_custom_first_house_is_rejected_even_with_a_consistent_hash(self):
        _, state = chosen()
        selected = state['storyState']['houses'][0]
        selected['materialSpec']['behavior'] = 'rigid'
        selected['materialId'] = _material_id(selected['materialSpec'])
        selected['outcome'] = 'stood'
        state['mediaPlan'].update(materialSpec=deepcopy(selected['materialSpec']),
                                  materialId=selected['materialId'], outcome='stood',
                                  houses=deepcopy(state['storyState']['houses']))
        with self.assertRaises(InvalidPlan):
            normalize(state)

    def test_normalized_spec_does_not_share_mutable_state_with_the_story(self):
        _, state = chosen()
        spec = normalize(state)
        spec.material_spec['labels']['ko'] = '종이'
        self.assertEqual(state['mediaPlan']['materialSpec']['labels']['ko'], '비닐')


if __name__ == '__main__':
    unittest.main()
