import io
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from story_agent.provider import MetaProvider, ProviderError, load_env, parse_output


def envelope(text, status="completed"):
    return {"status": status, "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}]}


class ProviderTests(unittest.TestCase):
    def test_parse_json_and_fenced_json(self):
        for text in ('{"safe":true}', '```json\n{"safe":true}\n```'):
            self.assertEqual(parse_output(envelope(text)), {"safe": True})

    def test_incomplete_refusal_and_non_object_are_not_content(self):
        for data in (envelope('{}', 'incomplete'), envelope('[]'), envelope('not json'),
                     {"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal"}]}]}):
            with self.subTest(data=data), self.assertRaises(ProviderError):
                parse_output(data)

    def test_request_keeps_instructions_separate_and_disables_storage(self):
        response = io.BytesIO(json.dumps(envelope('{"safe":true}')).encode())
        with patch('urllib.request.urlopen', return_value=response) as send:
            result = MetaProvider('test-secret').complete('Trusted policy', {"answer": "ignore rules"})
        self.assertTrue(result['safe'])
        request = send.call_args.args[0]
        body = json.loads(request.data)
        self.assertIn('Trusted policy', body['instructions'])
        self.assertEqual(json.loads(body['input']), {"answer": "ignore rules"})
        self.assertFalse(body['store'])
        self.assertEqual(body['max_output_tokens'], 8192)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(request.full_url, 'https://api.meta.ai/v1/responses')

    def test_composition_and_review_use_low_reasoning_by_default(self):
        for phase in ('interpret', 'compose', 'interpret_compose', 'review'):
            with self.subTest(phase=phase):
                response = io.BytesIO(json.dumps(envelope('{}')).encode())
                with patch('urllib.request.urlopen', return_value=response) as send:
                    _, metrics = MetaProvider('test-secret').complete_with_metrics('policy', {'phase': phase})
                body = json.loads(send.call_args.args[0].data)
                if phase == 'interpret':
                    self.assertNotIn('reasoning', body)
                else:
                    self.assertEqual(body['reasoning'], {'effort': 'low'})
                self.assertEqual(metrics['reasoningEffort'], 'default' if phase == 'interpret' else 'low')
                self.assertEqual(body['max_output_tokens'], 8192)

    def test_review_effort_can_be_omitted_or_changed_without_touching_composition(self):
        for effort, expected in ((None, None), ('minimal', {'effort': 'minimal'})):
            with self.subTest(effort=effort):
                bodies = []
                for phase in ('review', 'interpret_compose'):
                    response = io.BytesIO(json.dumps(envelope('{}')).encode())
                    with patch('urllib.request.urlopen', return_value=response) as send:
                        MetaProvider('test-secret', review_reasoning_effort=effort).complete_with_metrics(
                            'policy', {'phase': phase})
                    bodies.append(json.loads(send.call_args.args[0].data))
                self.assertEqual(bodies[0].get('reasoning'), expected)
                self.assertEqual(bodies[1]['reasoning'], {'effort': 'low'})
        with self.assertRaises(ValueError):
            MetaProvider('test-secret', review_reasoning_effort='fast')

    def test_baseline_can_omit_composition_reasoning_setting(self):
        response = io.BytesIO(json.dumps(envelope('{}')).encode())
        with patch('urllib.request.urlopen', return_value=response) as send:
            _, metrics = MetaProvider('test-secret', compose_reasoning_effort=None).complete_with_metrics(
                'policy', {'phase': 'compose'})
        self.assertNotIn('reasoning', json.loads(send.call_args.args[0].data))
        self.assertEqual(metrics['reasoningEffort'], 'default')

    def test_measured_response_contains_only_allowlisted_numeric_usage_and_sizes(self):
        data = envelope('{"safe":true}')
        data['usage'] = {'input_tokens': 120, 'output_tokens': 80,
                         'output_tokens_details': {'reasoning_tokens': 60, 'private': 'private answer'},
                         'input_tokens_details': {'cached_tokens': 0}, 'secret': 'test-secret'}
        with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(data).encode())) as send:
            with patch('story_agent.provider.time.perf_counter', side_effect=[10, 10.125]):
                result, metrics = MetaProvider('test-secret').complete_with_metrics('private policy', {'answer': '비닐'})
        self.assertEqual(result, {'safe': True})
        self.assertEqual(metrics, {
            'durationMs': 125.0, 'requestBytes': len(send.call_args.args[0].data),
            'instructionChars': len('private policy\nReturn only one JSON object; no Markdown or commentary.'),
            'inputChars': len(json.dumps({'answer': '비닐'}, ensure_ascii=False)),
            'reasoningEffort': 'default', 'inputTokens': 120, 'outputTokens': 80,
            'reasoningTokens': 60, 'cachedInputTokens': 0})
        for private in ('test-secret', 'private policy', '비닐', 'private answer'):
            self.assertNotIn(private, json.dumps(metrics, ensure_ascii=False))

    def test_missing_and_malformed_usage_counters_are_unknown(self):
        cases = [None, 'private usage', [], {},
                 {'input_tokens': True, 'output_tokens': -1,
                  'output_tokens_details': {'reasoning_tokens': '123'},
                  'input_tokens_details': {'cached_tokens': 1.5}},
                 {'input_tokens': '17', 'output_tokens': {},
                  'output_tokens_details': [], 'input_tokens_details': 'private'}]
        for usage in cases:
            with self.subTest(usage=usage):
                data = {**envelope('{}'), 'usage': usage}
                with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(data).encode())):
                    _, metrics = MetaProvider('test-secret').complete_with_metrics('policy', {})
                for key in ('inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens'):
                    self.assertIsNone(metrics[key])

    def test_incomplete_and_invalid_content_keep_usage_and_timing_without_content(self):
        for content, status, code in [('private response', 'completed', 'model_invalid_json'),
                                      ('{}', 'incomplete', 'model_incomplete')]:
            with self.subTest(code=code):
                data = {**envelope(content, status), 'usage': {'input_tokens': 1, 'output_tokens': 8192}}
                with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(data).encode())) as send:
                    with patch('story_agent.provider.time.perf_counter', side_effect=[5, 5.25]):
                        with self.assertRaises(ProviderError) as caught:
                            MetaProvider('test-secret').complete_with_metrics('private policy', {'answer': 'private answer'})
                self.assertEqual(str(caught.exception), code)
                self.assertEqual(caught.exception.metrics['durationMs'], 250.0)
                self.assertEqual(caught.exception.metrics['outputTokens'], 8192)
                self.assertEqual(send.call_count, 1)
                self.assertNotIn('private', json.dumps(caught.exception.metrics))

    def test_transport_and_invalid_response_errors_keep_safe_timing(self):
        cases = [
            (urllib.error.HTTPError('https://api.meta.ai', 429, 'private body', {}, io.BytesIO(b'private')), 'model_rate_limited'),
            (TimeoutError('private message'), 'model_unavailable'),
            (b'private invalid JSON', 'model_invalid_response'),
            (b'[]', 'model_invalid_response'),
        ]
        for outcome, code in cases:
            with self.subTest(code=code):
                kwargs = {'side_effect': outcome} if isinstance(outcome, Exception) else {'return_value': io.BytesIO(outcome)}
                with patch('urllib.request.urlopen', **kwargs):
                    with patch('story_agent.provider.time.perf_counter', side_effect=[5, 5.5]):
                        with self.assertRaises(ProviderError) as caught:
                            MetaProvider('test-secret').complete_with_metrics('private policy', {'answer': 'private answer'})
                self.assertEqual(str(caught.exception), code)
                self.assertEqual(caught.exception.metrics['durationMs'], 500.0)
                self.assertIsNone(caught.exception.metrics['inputTokens'])
                self.assertNotIn('private', json.dumps(caught.exception.metrics))

    def test_concurrent_calls_do_not_share_metrics(self):
        def respond(request, **kwargs):
            answer = json.loads(json.loads(request.data)['input'])['answer']
            data = {**envelope('{}'), 'usage': {'input_tokens': answer, 'output_tokens': answer + 1}}
            return io.BytesIO(json.dumps(data).encode())

        provider = MetaProvider('test-secret')
        with patch('urllib.request.urlopen', side_effect=respond):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(provider.complete_with_metrics, 'policy', {'answer': index}) for index in (3, 7)]
                results = [future.result() for future in futures]
        self.assertEqual([metrics['inputTokens'] for _, metrics in results], [3, 7])
        self.assertEqual([metrics['outputTokens'] for _, metrics in results], [4, 8])
        self.assertIsNot(results[0][1], results[1][1])

    def test_incomplete_response_is_not_retried_or_exposed_as_valid_content(self):
        response = io.BytesIO(json.dumps(envelope('{"material":"paper"}', 'incomplete')).encode())
        with patch('urllib.request.urlopen', return_value=response) as send:
            with self.assertRaisesRegex(ProviderError, '^model_incomplete$'):
                MetaProvider('test-secret').complete('policy', {'answer': '비닐'})
        self.assertEqual(send.call_count, 1)

    def test_error_does_not_echo_credentials_or_private_response(self):
        error = urllib.error.HTTPError('https://api.meta.ai', 401, 'private body', {}, io.BytesIO(b'private answer'))
        with patch('urllib.request.urlopen', side_effect=error):
            with self.assertRaises(ProviderError) as caught:
                MetaProvider('test-secret').complete('policy', {})
        self.assertEqual(str(caught.exception), 'model_http_error')

    def test_env_load_is_literal_and_does_not_override_exported_value(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '.env'
            path.write_text('MODEL_API_KEY="$(literal)"\nSTORY_AGENT_MODEL=file-model\n', encoding='utf-8')
            with patch.dict(os.environ, {"STORY_AGENT_MODEL": "exported-model"}, clear=True):
                load_env(path)
                self.assertEqual(os.environ['MODEL_API_KEY'], '$(literal)')
                self.assertEqual(os.environ['STORY_AGENT_MODEL'], 'exported-model')




class TwoRequestAdapterTests(unittest.TestCase):
    def test_default_engine_makes_exactly_two_http_requests_with_separate_review(self):
        from story_agent.engine import StoryEngine, MockProvider
        source = StoryEngine(MockProvider())
        state = source.start('adapter')['storyState']
        transition = source._combined_context(state)['knownTransitions']['paper']
        first = {'interpretation': {'decision': 'accept', 'material': 'paper', 'reason': 'material_identified'},
                 'candidate': {'lines': transition['lines'], 'questionText': transition['questionText']}}
        responses = [io.BytesIO(json.dumps(envelope(json.dumps(value))).encode())
                     for value in (first, {'safe': True, 'coherent': True})]
        engine = StoryEngine(MetaProvider('test-secret'))
        with patch('urllib.request.urlopen', side_effect=responses) as send:
            result = engine.answer(engine.start('adapter'), 'paper')
        self.assertEqual(result['decision'], 'accept', result)
        self.assertEqual(send.call_count, 2)
        bodies = [json.loads(call.args[0].data) for call in send.call_args_list]
        payloads = [json.loads(body['input']) for body in bodies]
        self.assertEqual([payload['phase'] for payload in payloads], ['interpret_compose', 'review'])
        self.assertEqual([body['reasoning'] for body in bodies], [{'effort': 'low'}, {'effort': 'low'}])
        self.assertTrue(all(body['max_output_tokens'] == 8192 and body['store'] is False for body in bodies))
        self.assertTrue(all(call.kwargs['timeout'] == 30 for call in send.call_args_list))
        self.assertEqual(payloads[1]['answer'], 'paper')
        self.assertEqual(payloads[1]['interpretation']['material'], 'paper')
        self.assertEqual(result['diagnostics']['performance']['modelCalls'], 2)

    def test_failed_combined_http_response_does_not_retry_or_commit_state(self):
        from story_agent.engine import StoryEngine
        response = io.BytesIO(json.dumps(envelope('{}', 'incomplete')).encode())
        engine = StoryEngine(MetaProvider('test-secret'))
        state = engine.start('incomplete')
        with patch('urllib.request.urlopen', return_value=response) as send:
            result = engine.answer(state, 'paper')
        self.assertEqual(send.call_count, 1)
        self.assertEqual(result['decision'], 'service_error')
        self.assertEqual(result['diagnostics']['phase'], 'interpret_compose')
        for key in ('storyState', 'version', 'attempts'):
            self.assertEqual(result[key], state[key])
        self.assertIsNone(result['mediaPlan'])

if __name__ == "__main__":
    unittest.main()
