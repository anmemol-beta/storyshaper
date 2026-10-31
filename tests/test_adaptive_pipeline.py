"""Fast-path trust boundaries and HTTP request counts; all providers are offline fixtures."""
from copy import deepcopy
import io
import json
import os
import unittest
from unittest.mock import patch

from media.contracts import normalize
from story_agent.engine import MockProvider, StoryEngine
from story_agent.provider import MetaProvider
from story_agent.server import Playground, runtime_options


class RecordingProvider(MockProvider):
    def __init__(self, change=None, review=True):
        self.calls = []
        self.change = change
        self.review = review

    def complete(self, instructions, payload):
        self.calls.append((instructions, deepcopy(payload)))
        result = super().complete(instructions, payload)
        if payload['phase'] == 'review':
            return {'safe': self.review, 'coherent': self.review}
        return self.change(result) if self.change else result


def envelope(value):
    return io.BytesIO(json.dumps({'status': 'completed', 'output': [
        {'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(value)}]}]}).encode())


class AdaptiveTests(unittest.TestCase):
    def engine(self, language='en', provider=None):
        return StoryEngine(provider or RecordingProvider(), language, pipeline='adaptive')

    def test_known_choice_and_observable_prediction_each_use_one_call_in_both_languages(self):
        for language, material, answer in (('en', 'ice cream', 'It will get bigger!'),
                                            ('ko', '아이스크림', '더 커질 거 같아!')):
            with self.subTest(language=language):
                engine = self.engine(language)
                initial = engine.start('fast')
                built = engine.answer(initial, material)
                result = engine.answer(built, answer)
                self.assertEqual(initial['version'], 0)
                for snapshot in (built, result):
                    self.assertEqual(snapshot['decision'], 'accept', snapshot)
                    self.assertEqual(snapshot['diagnostics']['performance']['modelCalls'], 1)
                    self.assertEqual(snapshot['diagnostics']['phase'], 'local_validation')
                    self.assertFalse(snapshot['diagnostics']['independentReview'])
                    self.assertNotIn('safety_review', snapshot['diagnostics']['checks'])
                    self.assertIsNotNone(normalize(snapshot))
                self.assertEqual(result['sceneId'], 'house1_reflect')
                self.assertEqual(result['storyState']['houses'][0]['material'], 'icecream')

    def test_new_materials_and_their_later_turns_keep_independent_review(self):
        engine = self.engine('ko')
        built = engine.answer(engine.start('new'), '비닐로 짓고 싶어!')
        result = engine.answer(built, '바람에 흔들릴 것 같아요')
        for snapshot in (built, result):
            self.assertEqual(snapshot['decision'], 'accept', snapshot)
            self.assertEqual(snapshot['diagnostics']['performance']['modelCalls'], 2)
            self.assertTrue(snapshot['diagnostics']['independentReview'])
            self.assertEqual(snapshot['diagnostics']['reviewReason'], 'custom_material')
        self.assertEqual(result['mediaPlan']['materialLabel'], '비닐')

    def test_failed_new_material_review_never_changes_state_or_counts_a_child_failure(self):
        engine = self.engine('ko', RecordingProvider(review=False))
        initial = engine.start('failed-review')
        original = deepcopy(initial)
        failed = engine.answer(initial, '비닐')
        self.assertEqual(initial, original)
        self.assertEqual(failed['decision'], 'service_error')
        for key in ('storyState', 'version', 'attempts'):
            self.assertEqual(failed[key], initial[key])
        self.assertIsNone(failed['mediaPlan'])
        self.assertTrue(failed['choiceMode'])

    def test_negation_long_or_instruction_like_answers_keep_review(self):
        class ClearChoice(RecordingProvider):
            def _interpret(self, payload):
                return {'decision': 'accept', 'material': 'wood' if '나무' in payload['answer'] else 'paper',
                        'reason': 'material_identified'}

        for answer in ('not straw, paper please', 'paper please\nthank you',
                       'paper ' + 'please ' * 20, '종이 대신 나무'):
            with self.subTest(answer=answer):
                engine = self.engine(provider=ClearChoice())
                result = engine.answer(engine.start('complex'), answer)
                self.assertEqual(result['decision'], 'accept', result)
                self.assertEqual(result['diagnostics']['performance']['modelCalls'], 2)
                self.assertEqual(result['diagnostics']['reviewReason'], 'complex_answer')

    def test_other_material_hidden_in_prediction_is_independently_rejected(self):
        provider = RecordingProvider()
        engine = self.engine(provider=provider)
        built = engine.answer(engine.start('material'), 'ice cream')

        def wrong_material(result):
            result['candidate']['lines'].append({'speakerId': 'narrator', 'text': 'The wooden walls are soft.'})
            return result

        provider.change, provider.review = wrong_material, False
        failed = engine.answer(built, 'It gets bigger')
        self.assertEqual(failed['decision'], 'service_error')
        self.assertEqual(failed['diagnostics']['performance']['modelCalls'], 2)
        self.assertEqual(failed['storyState'], built['storyState'])

    def test_known_name_does_not_bypass_review_of_unapproved_modifiers(self):
        class KnownChoice(RecordingProvider):
            def _interpret(self, payload):
                return {'decision': 'accept', 'material': 'paper', 'reason': 'material_identified'}
        for answer in ('paper with broken glass', '종이로 유리 조각을 붙일래'):
            with self.subTest(answer=answer):
                engine = self.engine(provider=KnownChoice(review=False))
                initial = engine.start('modifier')
                failed = engine.answer(initial, answer)
                self.assertEqual(failed['decision'], 'service_error')
                self.assertEqual(failed['diagnostics']['performance']['modelCalls'], 2)
                self.assertEqual(failed['storyState'], initial['storyState'])

    def test_finished_result_without_process_takes_reviewed_path(self):
        provider = RecordingProvider()
        engine = self.engine(provider=provider)
        built = engine.answer(engine.start('process'), 'ice cream')

        def result_only(result):
            dialogue = [line for line in result['candidate']['lines'] if line['speakerId'] != 'narrator']
            result['candidate']['lines'] = [{'speakerId': 'narrator', 'text': 'The ice cream melted.'}] + dialogue
            return result

        provider.change, provider.review = result_only, False
        failed = engine.answer(built, 'It gets bigger')
        self.assertEqual(failed['decision'], 'service_error')
        self.assertEqual(failed['diagnostics']['performance']['modelCalls'], 2)
        self.assertEqual(failed['version'], built['version'])

    def test_premature_result_at_build_takes_reviewed_path(self):
        def premature(result):
            result['candidate']['lines'].append({'speakerId': 'narrator', 'text': 'The ice cream melted.'})
            return result
        engine = self.engine(provider=RecordingProvider(change=premature, review=False))
        initial = engine.start('spoiler')
        failed = engine.answer(initial, 'ice cream')
        self.assertEqual(failed['decision'], 'service_error')
        self.assertEqual(failed['diagnostics']['performance']['modelCalls'], 2)
        self.assertEqual(failed['storyState'], initial['storyState'])

    def test_invalid_model_text_is_never_exposed_even_on_fast_path(self):
        for text in ('The dragon burns the paper house.', 'The wolf ate the pig in the paper house.',
                     'The paper house is ready. You are wrong.', '종이집이 완성됐어요.'):
            with self.subTest(text=text):
                def invalid(result):
                    result['candidate']['lines'] = [{'speakerId': 'narrator', 'text': text}]
                    return result
                engine = self.engine(provider=RecordingProvider(change=invalid))
                initial = engine.start('invalid')
                failed = engine.answer(initial, 'paper')
                self.assertEqual(failed['decision'], 'service_error')
                self.assertEqual(failed['diagnostics']['performance']['modelCalls'], 1)
                self.assertEqual(failed['storyState'], initial['storyState'])
                self.assertIsNone(failed['mediaPlan'])

    def test_authored_touch_still_works_with_zero_calls_after_service_failure(self):
        provider = RecordingProvider(review=False)
        engine = self.engine('ko', provider)
        failed = engine.answer(engine.start('touch'), '비닐')
        calls = len(provider.calls)
        result = engine.answer(failed, 'ignored', choice_id='paper')
        self.assertEqual(result['decision'], 'accept')
        self.assertEqual(result['diagnostics']['performance']['modelCalls'], 0)
        self.assertEqual(len(provider.calls), calls)
        self.assertFalse(result['diagnostics']['independentReview'])
        self.assertIsNotNone(result['mediaPlan']['selection'])

    def test_nine_turns_preserve_events_ending_and_review_each_house_transition(self):
        for language in ('en', 'ko'):
            engine = self.engine(language)
            state = engine.start('complete')
            counts = []
            for material in ('paper', 'wood', 'brick'):
                for answer in (material, 'The walls might stay standing', 'They helped together'):
                    state = engine.answer(state, answer)
                    self.assertIn(state['decision'], ('accept', 'complete'), state)
                    counts.append(state['diagnostics']['performance']['modelCalls'])
            self.assertEqual(counts, [1, 1, 2] * 3)
            self.assertEqual(state['version'], 9)
            self.assertIsNone(state['question'])
            self.assertEqual(state['storyState']['events'][-2:], ['pigs_safe_together', 'wolf_leaves'])
            self.assertTrue(state['diagnostics']['independentReview'])

    def test_compact_selection_context_reduces_prompt_and_preserves_grounding(self):
        engine = self.engine('ko')
        state = engine.start('context')['storyState']
        baseline = engine._combined_context(state)
        compact = engine._combined_context(state, compact=True)
        self.assertLess(len(json.dumps(compact)), len(json.dumps(baseline)) * .65)
        self.assertNotIn('nextSceneId', json.dumps(compact))
        self.assertEqual(compact['knownTransitions']['wood']['facts']['outcome'], 'collapsed')
        self.assertIn('묶지', compact['knownTransitions']['wood']['build'])
        for transition in compact['customTransitions'].values():
            self.assertNotIn('process', transition['facts'])

    def test_actual_adapter_makes_one_http_call_and_enforces_json_schema(self):
        mock = RecordingProvider()
        engine = self.engine(provider=mock)
        expected = engine.answer(engine.start('fixture'), 'paper')
        output = MockProvider().complete(*mock.calls[0])
        engine = self.engine(provider=MetaProvider('fixture-secret'))
        with patch('urllib.request.urlopen', return_value=envelope(output)) as send:
            actual = engine.answer(engine.start('adapter'), 'paper')
        self.assertEqual(send.call_count, 1)
        self.assertEqual(actual['lines'], expected['lines'])
        self.assertEqual(actual['diagnostics']['performance']['modelCalls'], 1)
        body = json.loads(send.call_args.args[0].data)
        self.assertEqual(body['reasoning'], {'effort': 'low'})
        self.assertFalse(body['store'])
        self.assertTrue(body['text']['format']['strict'])
        self.assertNotIn('storyState', body['text']['format']['schema']['properties'])

    def test_http_adapter_new_material_still_makes_two_requests_and_rejects_failed_review(self):
        mock = RecordingProvider()
        self.engine('ko', mock).answer(self.engine('ko').start('fixture'), '비닐')
        output = MockProvider().complete(*mock.calls[0])
        engine = self.engine('ko', MetaProvider('fixture-secret'))
        initial = engine.start('two-requests')
        with patch('urllib.request.urlopen', side_effect=[envelope(output), envelope({'safe': False, 'coherent': True})]) as send:
            failed = engine.answer(initial, '비닐')
        self.assertEqual(send.call_count, 2)
        self.assertEqual(failed['decision'], 'service_error')
        self.assertEqual(failed['storyState'], initial['storyState'])
        self.assertEqual(failed['attempts'], 0)


class AdaptiveSessionTests(unittest.TestCase):
    def test_playground_defaults_to_adaptive_and_replays_without_generation(self):
        provider = RecordingProvider()
        app = Playground(provider_factory=lambda mode: provider)
        start = app.create('mock')
        body = {'sessionId': start['sessionId'], 'version': start['version'],
                'questionId': start['question']['id'], 'requestId': 'first', 'answer': 'paper'}
        result = app.answer(body)
        self.assertEqual(app.config()['storyPipeline'], 'adaptive')
        self.assertEqual(result['diagnostics']['performance']['modelCalls'], 1)
        self.assertEqual(app.answer(body), result)
        self.assertEqual(len(provider.calls), 1)
        localized = app.change_language({'sessionId': result['sessionId'], 'version': result['version'], 'language': 'ko'})
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(localized['mediaPlan']['material'], 'paper')

    def test_reviewed_comparison_can_be_selected_without_code_changes(self):
        with patch.dict(os.environ, {'STORY_AGENT_PIPELINE': 'two_call', 'STORY_AGENT_REVIEW_EFFORT': 'default',
                                     'STORY_AGENT_STRUCTURED_OUTPUT': '0'}, clear=True):
            options = runtime_options()
        app = Playground(**options)
        start = app.create('mock')
        result = app.answer({'sessionId': start['sessionId'], 'version': start['version'],
                'questionId': start['question']['id'], 'requestId': 'first', 'answer': 'paper'})
        self.assertEqual(result['diagnostics']['performance']['modelCalls'], 2)
        self.assertIsNone(app.review_reasoning_effort)
        self.assertFalse(app.structured_output)
        self.assertEqual(app.config()['reviewReasoningEffort'], 'default')


if __name__ == '__main__':
    unittest.main()
