"""Per-turn diagnostics and task-specific context, without a live API call."""
from copy import deepcopy
import json
import unittest

from story_agent.engine import MockProvider, StoryEngine
from story_agent.provider import ProviderError


class RecordingProvider(MockProvider):
    def __init__(self):
        self.calls = []

    def complete(self, instructions, payload):
        self.calls.append((instructions, deepcopy(payload)))
        return super().complete(instructions, payload)


class PerformanceTests(unittest.TestCase):
    def test_success_reports_three_calls_without_private_content(self):
        engine = StoryEngine(RecordingProvider(), 'ko')
        start = engine.start('private-session')
        result = engine.answer(start, '비닐로 짓고 싶어!')
        performance = result['diagnostics']['performance']
        self.assertEqual(performance['modelCalls'], 3)
        self.assertEqual([call['phase'] for call in performance['calls']],
                         ['interpret', 'compose', 'review'])
        for call in performance['calls']:
            self.assertGreaterEqual(call['durationMs'], 0)
            self.assertGreater(call['inputChars'], 0)
            self.assertIsNone(call['inputTokens'], 'Mock counts must not be invented')
        self.assertGreaterEqual(performance['totalMs'], 0)
        self.assertNotIn('비닐', json.dumps(performance, ensure_ascii=False))
        self.assertNotIn('private-session', json.dumps(performance))
        self.assertNotIn('performance', start['diagnostics'])

    def test_failure_has_attempted_call_metrics_and_preserves_state(self):
        class FailingProvider(MockProvider):
            def complete(self, instructions, payload):
                raise ProviderError('model_unavailable')
        engine = StoryEngine(FailingProvider())
        start = engine.start('failure')
        result = engine.answer(start, 'paper')
        self.assertEqual(result['decision'], 'service_error')
        self.assertEqual(result['storyState'], start['storyState'])
        self.assertEqual(result['attempts'], 0)
        calls = result['diagnostics']['performance']['calls']
        self.assertEqual(len(calls), 1)
        self.assertFalse(calls[0]['completed'])

    def test_no_call_path_clears_previous_metrics(self):
        engine = StoryEngine(MockProvider())
        first = engine.answer(engine.start('zero'), 'paper')
        empty = engine.answer(first, '')
        self.assertEqual(empty['diagnostics']['performance']['modelCalls'], 0)
        self.assertEqual(empty['diagnostics']['performance']['calls'], [])

    def test_measured_provider_usage_is_attached_per_call(self):
        class MeasuredProvider(MockProvider):
            def complete_with_metrics(self, instructions, payload):
                return self.complete(instructions, payload), {
                    'inputTokens': 100, 'outputTokens': 20, 'reasoningTokens': 0,
                    'cachedInputTokens': 50, 'privateBody': 'must not leak',
                }
        engine = StoryEngine(MeasuredProvider())
        result = engine.answer(engine.start('usage'), 'paper')
        for call in result['diagnostics']['performance']['calls']:
            self.assertEqual(call['inputTokens'], 100)
            self.assertEqual(call['reasoningTokens'], 0)
            self.assertNotIn('privateBody', call)

    def test_measured_provider_error_keeps_its_usage_without_changing_state_or_other_calls(self):
        class FailingMeasuredProvider(MockProvider):
            def complete_with_metrics(self, instructions, payload):
                if payload['phase'] == 'compose':
                    raise ProviderError('model_incomplete', metrics={
                        'inputTokens': 7, 'outputTokens': 8192, 'reasoningTokens': 8192,
                        'cachedInputTokens': 0, 'reasoningEffort': 'low',
                        'privateBody': 'private model response', 'answer': payload['answer'],
                    })
                return self.complete(instructions, payload), {
                    'inputTokens': 100, 'outputTokens': 20, 'reasoningTokens': 0,
                    'cachedInputTokens': 50,
                }

        engine = StoryEngine(FailingMeasuredProvider())
        start = engine.answer(engine.start('private-session'), '')
        original = deepcopy(start)
        result = engine.answer(start, 'paper')
        self.assertEqual(start, original)
        self.assertEqual(result['decision'], 'service_error')
        self.assertEqual(result['diagnostics']['phase'], 'compose')
        self.assertEqual(result['diagnostics']['failureCode'], 'model_incomplete')
        for key in ('storyState', 'version', 'attempts'):
            self.assertEqual(result[key], start[key])
        self.assertEqual(result['attempts'], 1)
        self.assertIsNone(result['mediaPlan'])
        calls = result['diagnostics']['performance']['calls']
        self.assertEqual(result['diagnostics']['performance']['modelCalls'], 2)
        self.assertEqual([call['completed'] for call in calls], [True, False])
        self.assertEqual([call['inputTokens'] for call in calls], [100, 7])
        self.assertEqual([call['outputTokens'] for call in calls], [20, 8192])
        self.assertEqual([call['reasoningTokens'] for call in calls], [0, 8192])
        self.assertEqual([call['cachedInputTokens'] for call in calls], [50, 0])
        self.assertEqual([call['reasoningEffort'] for call in calls], ['default', 'low'])
        for private in ('private-session', 'private model response', 'privateBody', 'paper'):
            self.assertNotIn(private, json.dumps(result['diagnostics']['performance']))

    def test_completed_call_is_distinct_from_candidate_validation_or_review_acceptance(self):
        class InvalidCandidateProvider(MockProvider):
            def __init__(self, failed_phase):
                self.failed_phase = failed_phase

            def complete(self, instructions, payload):
                result = super().complete(instructions, payload)
                if payload['phase'] == self.failed_phase:
                    if self.failed_phase == 'compose':
                        result['lines'] = []
                    else:
                        result['coherent'] = False
                return result

        for failed_phase, count in (('compose', 2), ('review', 3)):
            with self.subTest(failed_phase=failed_phase):
                engine = StoryEngine(InvalidCandidateProvider(failed_phase))
                start = engine.start('invalid-candidate')
                original = deepcopy(start)
                result = engine.answer(start, 'paper')
                self.assertEqual(start, original)
                self.assertEqual(result['decision'], 'service_error')
                self.assertEqual(result['diagnostics']['phase'], failed_phase)
                self.assertFalse(result['diagnostics']['validated'])
                for key in ('storyState', 'version', 'attempts'):
                    self.assertEqual(result[key], start[key])
                self.assertIsNone(result['mediaPlan'])
                performance = result['diagnostics']['performance']
                self.assertEqual(performance['modelCalls'], count)
                self.assertTrue(all(call['completed'] for call in performance['calls']))
                self.assertEqual(performance['calls'][-1]['phase'], failed_phase)
                retry = engine.answer(result, '')
                self.assertEqual(retry['diagnostics']['performance']['modelCalls'], 0)
                self.assertEqual(performance['modelCalls'], count)

    def test_later_interpretation_omits_material_catalog_and_old_houses(self):
        provider = RecordingProvider()
        engine = StoryEngine(provider, 'ko')
        state = engine.answer(engine.start('minimal-context'), '아이스크림')
        provider.calls.clear()
        result = engine.answer(state, '더 커질 거 같아!')
        self.assertEqual(result['decision'], 'accept')
        instructions, payload = provider.calls[0]
        self.assertNotIn('knownMaterials', payload)
        self.assertNotIn('allowedMaterials', payload)
        self.assertNotIn('storyState', payload)
        self.assertIn('아이스크림', json.dumps(payload, ensure_ascii=False))
        self.assertNotIn('light_flexible', instructions)
        for _, call in provider.calls[1:]:
            self.assertNotIn('storyState', call)
            self.assertNotIn('fixedEvents', call)

    def test_build_turn_does_not_send_future_process_as_narration_context(self):
        provider = RecordingProvider()
        engine = StoryEngine(provider, 'ko')
        state = engine.answer(engine.start('build-first'), '아이스크림')
        self.assertEqual(state['sceneId'], 'house1_predict')
        for instructions, payload in provider.calls[1:]:
            self.assertNotIn('process', payload['facts'])
            self.assertEqual(payload['facts']['action'], 'build')
            self.assertIn('prediction', instructions)
        provider.calls.clear()
        engine.answer(state, '더 커질 거 같아!')
        for _, payload in provider.calls[1:]:
            self.assertEqual(len(payload['facts']['process']), 2)


if __name__ == '__main__':
    unittest.main()
