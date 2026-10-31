from copy import deepcopy
import http.client
from html.parser import HTMLParser
import json
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urljoin

from story_agent.server import APIError, Playground, Server


def turn_body(snapshot, answer='paper', request='turn-1'):
    return {"sessionId": snapshot['sessionId'], "version": snapshot['version'],
            "questionId": snapshot['question']['id'], "requestId": request, "answer": answer}


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.app = Playground()
        self.start = self.app.create('mock')

    def test_same_submission_counted_and_generated_once(self):
        body = turn_body(self.start)
        session = self.app.sessions[self.start['sessionId']]
        with patch.object(session.engine, 'answer', wraps=session.engine.answer) as answer:
            first = self.app.answer(body)
            second = self.app.answer(body)
        self.assertEqual(first, second)
        self.assertEqual(answer.call_count, 1)
        self.assertEqual(session.turns, 1)

    def test_old_question_and_reused_request_id_cannot_replace_story(self):
        body = turn_body(self.start)
        accepted = self.app.answer(body)
        for changed in (dict(body, requestId='turn-2'), dict(body, answer='wood')):
            with self.subTest(changed=changed), self.assertRaises(APIError) as caught:
                self.app.answer(changed)
            self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.app.sessions[self.start['sessionId']].snapshot, accepted)

    def test_client_cannot_write_state_or_choose_arbitrary_choice(self):
        body = turn_body(self.start)
        body['storyState'] = {'ending': 'wolf wins'}
        result = self.app.answer(body)
        self.assertNotEqual(result['storyState'], body['storyState'])
        newer = turn_body(result, request='other')
        newer['choiceId'] = 'invented'
        with self.assertRaises(APIError) as caught:
            self.app.answer(newer)
        self.assertEqual(caught.exception.code, 'invalid_choice')

    def test_microphone_fallback_accepts_a_current_authored_choice_without_an_extra_failure_request(self):
        choice = self.start['question']['choices'][0]
        body = turn_body(self.start, 'client text must not replace the selected material')
        body.update(choiceId=choice['id'], selection={'label': 'forged'}, material='brick')
        session = self.app.sessions[self.start['sessionId']]
        with patch.object(session.engine.provider, 'complete', side_effect=AssertionError('model called')):
            result = self.app.answer(body)
            replay = self.app.answer(body)
        self.assertEqual(result, replay)
        self.assertEqual(session.turns, 1)
        self.assertEqual(result['attempts'], 0)
        self.assertFalse(result['choiceMode'])
        self.assertEqual(result['diagnostics']['performance']['modelCalls'], 0)
        self.assertTrue(result['diagnostics']['authoredFallback'])
        self.assertEqual(result['storyState']['houses'][0]['material'], choice['id'])
        self.assertEqual(result['selection'], {
            'choiceId': choice['id'], 'label': choice['label'], 'answer': choice['answer'],
            'sessionId': self.start['sessionId'], 'sceneId': self.start['sceneId'],
            'questionId': self.start['question']['id'], 'version': self.start['version'], 'language': 'en'})
        self.assertEqual(result['mediaPlan']['selection'], result['selection'])
        localized = self.app.change_language({'sessionId': result['sessionId'],
                                              'version': result['version'], 'language': 'ko'})
        self.assertEqual(localized['mediaPlan']['selection'], result['selection'])
        self.assertEqual(localized['mediaPlan']['material'], choice['id'])

    def test_choice_mode_rejects_free_answers_without_counting_or_calling_a_model(self):
        failure_request = turn_body(self.start, '')
        failed = self.app.answer(failure_request)
        session = self.app.sessions[failed['sessionId']]
        with patch.object(session.engine, 'answer', side_effect=AssertionError('engine called')):
            for answer in ('paper', '', '벽돌로 지을래요'):
                with self.subTest(answer=answer), self.assertRaises(APIError) as caught:
                    self.app.answer(turn_body(failed, answer, 'blocked'))
                self.assertEqual(caught.exception.code, 'choice_required')
                self.assertEqual(caught.exception.snapshot, failed)
            self.assertEqual(self.app.answer(failure_request), failed)
        self.assertEqual(session.snapshot, failed)
        self.assertEqual(session.turns, 1)
        choice = failed['question']['choices'][0]
        accepted = self.app.answer(dict(turn_body(failed, request='chosen'), choiceId=choice['id']))
        self.assertFalse(accepted['choiceMode'])
        self.assertEqual(session.turns, 2)

    def test_first_failure_then_touch_is_idempotent_and_rejects_old_or_invented_choices(self):
        failure_request = turn_body(self.start, '')
        failed = self.app.answer(failure_request)
        self.assertEqual(self.app.answer(failure_request), failed)
        self.assertEqual(failed['attempts'], 1)
        self.assertTrue(failed['choiceMode'])
        choice = failed['question']['choices'][0]
        touch = dict(turn_body(failed, 'ignored', 'touch'), choiceId=choice['id'])
        accepted = self.app.answer(touch)
        self.assertEqual(self.app.answer(touch), accepted)
        self.assertEqual(accepted['mediaPlan']['selection']['version'], failed['version'])
        self.assertEqual(accepted['mediaPlan']['material'], choice['id'])
        with self.assertRaises(APIError) as stale:
            self.app.answer(dict(touch, requestId='late-touch'))
        self.assertEqual(stale.exception.code, 'stale_question')
        for choice_id in (choice['id'], 'invented'):
            with self.subTest(choice=choice_id), self.assertRaises(APIError) as invalid:
                self.app.answer(dict(turn_body(accepted, request='invalid'), choiceId=choice_id))
            self.assertEqual(invalid.exception.code, 'invalid_choice')
        self.assertEqual(self.app.sessions[self.start['sessionId']].snapshot, accepted)

    def test_same_session_parallel_answer_is_rejected_without_child_failure(self):
        session = self.app.sessions[self.start['sessionId']]
        before = deepcopy(session.snapshot)
        with session.lock:
            with self.assertRaises(APIError) as caught:
                self.app.answer(turn_body(self.start))
        self.assertEqual(caught.exception.code, 'turn_in_progress')
        self.assertEqual(session.snapshot, before)

    def test_live_requires_key_and_server_turn_limit(self):
        with self.assertRaises(APIError) as caught:
            self.app.create('live')
        self.assertEqual(caught.exception.code, 'missing_api_key')
        self.app.sessions[self.start['sessionId']].turns = 60
        with self.assertRaises(APIError) as caught:
            self.app.answer(turn_body(self.start))
        self.assertEqual(caught.exception.code, 'turn_limit')

    def test_cleanup_retains_session_while_turn_is_being_generated(self):
        session = self.app.sessions[self.start['sessionId']]
        session.touched = 0
        original_answer = session.engine.answer

        def generate_across_expiry(*args, **kwargs):
            # Simulate a very long in-flight call while another tab starts a story.
            with patch('story_agent.server.time.monotonic', return_value=15000):
                self.app.create('mock')
                self.assertIn(self.start['sessionId'], self.app.sessions)
            return original_answer(*args, **kwargs)

        with patch('story_agent.server.time.monotonic', return_value=7199), \
                patch.object(session.engine, 'answer', side_effect=generate_across_expiry):
            result = self.app.answer(turn_body(self.start))
        self.assertEqual(result['decision'], 'accept')
        self.assertIn(self.start['sessionId'], self.app.sessions)

    def test_live_outage_can_use_authored_choice_without_another_model_call(self):
        class Unavailable:
            mode = 'live'
            calls = 0

            def complete(self, *_):
                self.calls += 1
                raise TimeoutError('unavailable')

        provider = Unavailable()
        app = Playground('test-only-key', provider_factory=lambda _: provider)
        start = app.create('live')
        failed = app.answer(turn_body(start))
        self.assertEqual(failed['decision'], 'service_error')
        self.assertEqual(failed['attempts'], 0)
        self.assertTrue(failed['choiceMode'])
        choice = failed['question']['choices'][0]
        body = turn_body(failed, choice['answer'], 'fallback-1')
        body['choiceId'] = choice['id']
        accepted = app.answer(body)
        self.assertEqual(accepted['decision'], 'accept')
        self.assertTrue(accepted['diagnostics']['authoredFallback'])
        self.assertEqual(accepted['providerMode'], 'live')
        self.assertEqual(provider.calls, 1)

    def test_language_switch_keeps_branch_and_invalidates_old_answer_replay(self):
        body = turn_body(self.start, 'cookie')
        accepted = self.app.answer(body)
        session = self.app.sessions[self.start['sessionId']]
        with patch.object(session.engine.provider, 'complete', side_effect=AssertionError('model called')):
            localized = self.app.change_language({'sessionId': accepted['sessionId'],
                                                  'version': accepted['version'], 'language': 'ko'})
        self.assertEqual(localized['language'], 'ko')
        self.assertEqual(localized['version'], accepted['version'] + 1)
        self.assertEqual(localized['storyState']['houses'], accepted['storyState']['houses'])
        self.assertEqual(localized['storyState']['events'], accepted['storyState']['events'])
        self.assertEqual(localized['mediaPlan']['language'], 'ko')
        self.assertEqual(localized['mediaPlan']['version'], localized['version'])
        self.assertEqual(session.turns, 1)
        self.assertIn('과자', localized['question']['text'])
        with self.assertRaises(APIError) as caught:
            self.app.answer(body)
        self.assertEqual(caught.exception.code, 'stale_question')
        self.assertEqual(caught.exception.snapshot, localized)
        self.assertEqual(session.snapshot, localized)
        next_turn = self.app.answer(turn_body(localized, '늑대가 벽을 먹을 것 같아요', 'korean-answer'))
        self.assertEqual(next_turn['decision'], 'accept')
        self.assertIn('먹', ' '.join(line['text'] for line in next_turn['lines']))

    def test_language_switch_preserves_attempts_rejects_stale_versions_and_locks(self):
        failed = self.app.answer(turn_body(self.start, ''))
        body = {'sessionId': failed['sessionId'], 'version': failed['version'], 'language': 'ko'}
        session = self.app.sessions[failed['sessionId']]
        with session.lock:
            with self.assertRaises(APIError) as caught:
                self.app.change_language(body)
        self.assertEqual(caught.exception.code, 'turn_in_progress')
        localized = self.app.change_language(body)
        self.assertEqual(localized['attempts'], 1)
        self.assertEqual(localized['decision'], 'clarify')
        with self.assertRaises(APIError) as caught:
            self.app.change_language(body)
        self.assertEqual(caught.exception.code, 'stale_question')
        self.assertEqual(caught.exception.snapshot, localized)
        same = self.app.change_language(dict(body, version=localized['version']))
        self.assertEqual(same, localized)

    def test_language_selection_defaults_to_english_and_rejects_unknown_values(self):
        self.assertEqual(self.start['language'], 'en')
        self.assertEqual(self.app.create('mock', 'ko')['language'], 'ko')
        for language in ('fr', None, ['ko']):
            with self.subTest(language=language), self.assertRaises(APIError) as caught:
                self.app.create('mock', language)
            self.assertEqual(caught.exception.code, 'invalid_language')
        with self.assertRaises(APIError) as caught:
            self.app.change_language({'sessionId': self.start['sessionId'], 'version': 0, 'language': 'fr'})
        self.assertEqual(caught.exception.code, 'invalid_language')

    def test_expired_session_cannot_be_relocalized(self):
        self.app.sessions[self.start['sessionId']].touched = 0
        with self.assertRaises(APIError) as caught:
            self.app.change_language({'sessionId': self.start['sessionId'], 'version': 0, 'language': 'ko'})
        self.assertEqual(caught.exception.code, 'session_not_found')


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(('127.0.0.1', 0), Playground())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        request_headers = {'Content-Type': 'application/json'}
        request_headers.update(headers or {})
        conn.request(method, path, body, request_headers)
        response = conn.getresponse()
        status, raw = response.status, response.read()
        conn.close()
        return status, raw

    def test_config_is_secret_free_and_live_missing_key_is_explicit(self):
        status, raw = self.request('GET', '/api/config')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"liveAvailable": False, "model": "muse-spark-1.3",
                                          "supportedLanguages": ['en', 'ko'],
                                          "storyPipeline": "adaptive", "composeReasoningEffort": "low",
                                          "reviewReasoningEffort": "low"})
        status, raw = self.request('POST', '/api/sessions', '{"mode":"live"}')
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(raw)['error']['code'], 'missing_api_key')

    def test_home_opens_integrated_page_with_loadable_assets_and_parent_settings(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.request('GET', '/?voiceServer=http://127.0.0.1:8100')
        response = conn.getresponse()
        self.assertEqual(response.status, 302)
        location = response.getheader('Location')
        response.read()
        conn.close()
        self.assertEqual(location, '/prototype/index.html?voiceServer=http://127.0.0.1:8100')
        status, raw = self.request('GET', location)
        self.assertEqual(status, 200)
        html = raw.decode()
        for element in ('mic', 'cameraButton', 'imgCur', 'choices', 'freeInput', 'retryMedia'):
            self.assertIn(f'id="{element}"', html)
        self.assertIn('href="voice.html"', html)
        self.assertNotIn('agent.html', html)
        self.assertIn('오프라인 버전', html)
        self.assertIn('AI 버전', html)
        self.assertNotIn('diagnosticsJson', html)

        class Assets(HTMLParser):
            def __init__(self):
                super().__init__()
                self.urls = []

            def handle_starttag(self, tag, attributes):
                attributes = dict(attributes)
                if tag == 'script' and 'src' in attributes:
                    self.urls.append(attributes['src'])
                if tag == 'link' and attributes.get('rel') == 'stylesheet':
                    self.urls.append(attributes['href'])

        assets = Assets()
        assets.feed(html)
        self.assertIn('camera-input.js', assets.urls)
        self.assertIn('narration.js', assets.urls)
        self.assertIn('story-media.js', assets.urls)
        self.assertIn('live-book.js', assets.urls)
        self.assertNotIn('agent.js', assets.urls)
        for asset in assets.urls:
            with self.subTest(asset=asset):
                status, _ = self.request('GET', urljoin(location, asset))
                self.assertEqual(status, 200)

    def test_developer_page_is_preserved_but_unlinked_from_reader(self):
        status, raw = self.request('GET', '/prototype/agent.html')
        self.assertEqual(status, 200)
        self.assertIn('diagnosticsJson', raw.decode())
        for path in ('/prototype/index.html', '/prototype/live.html', '/prototype/voice.html'):
            status, raw = self.request('GET', path)
            self.assertEqual(status, 200)
            self.assertNotIn('agent.html', raw.decode())

    def test_private_paths_and_traversal_are_not_served(self):
        for path in ('/.env', '/voice/compare.html', '/prototype/../.git/config',
                     '/prototype/%2e%2e/.git/config'):
            with self.subTest(path=path):
                status, _ = self.request('GET', path)
                self.assertEqual(status, 404)

    def test_invalid_origin_or_dns_rebinding_host_is_rejected(self):
        for headers in ({'Origin': 'https://unrelated.example'}, {'Host': 'unrelated.example'}):
            with self.subTest(headers=headers):
                status, _ = self.request('POST', '/api/sessions', '{"mode":"mock"}', headers)
                self.assertEqual(status, 403)

    def test_bad_json_and_oversized_request_fail_without_crash(self):
        for body, expected in (('[1]', 400), ('{broken', 400), ('x' * 8193, 413)):
            status, _ = self.request('POST', '/api/sessions', body)
            self.assertEqual(status, expected)

    def test_http_round_trip(self):
        status, raw = self.request('POST', '/api/sessions', '{"mode":"mock"}')
        self.assertEqual(status, 200)
        snapshot = json.loads(raw)
        status, raw = self.request('POST', '/api/answer', json.dumps(turn_body(snapshot, 'cookies')))
        self.assertEqual(status, 200)
        result = json.loads(raw)
        self.assertEqual(result['decision'], 'accept')
        self.assertGreater(result['version'], snapshot['version'])

    def test_http_korean_creation_switch_and_invalid_language(self):
        status, raw = self.request('POST', '/api/sessions', '{"mode":"mock","language":"ko"}')
        self.assertEqual(status, 200)
        snapshot = json.loads(raw)
        self.assertEqual(snapshot['language'], 'ko')
        self.assertIn('첫째', snapshot['question']['text'])
        status, raw = self.request('POST', '/api/language', json.dumps({
            'sessionId': snapshot['sessionId'], 'version': snapshot['version'], 'language': 'en'}))
        self.assertEqual(status, 200)
        result = json.loads(raw)
        self.assertEqual(result['language'], 'en')
        self.assertEqual(result['version'], snapshot['version'] + 1)
        self.assertEqual(result['storyState']['houses'], [])
        for path, body in (('/api/sessions', {'mode': 'mock', 'language': 'fr'}),
                           ('/api/language', {'sessionId': result['sessionId'], 'version': result['version'], 'language': 'fr'})):
            status, raw = self.request('POST', path, json.dumps(body))
            self.assertEqual(status, 400)
            self.assertEqual(json.loads(raw)['error']['code'], 'invalid_language')


if __name__ == '__main__':
    unittest.main()
