"""Live image boundaries and concurrency, using fixtures rather than paid calls."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import base64
import http.client
import io
import json
import shutil
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error

from media.assets import ROOT
from media.contracts import normalize
from media.image_provider import ImageError, MuseImageProvider, checked_jpeg, scene_facts
from media.jobs import JobError, MediaJobs
from story_agent.engine import MockProvider, StoryEngine
from story_agent.server import SESSION_TTL
from vision.server import VisionPlayground, VisionServer

JPEG = (ROOT / 'prototype/img/empty1.jpg').read_bytes()


class LiveRules(MockProvider):
    mode = 'live'


def scenes(material='paper', session='image-session'):
    engine = StoryEngine(LiveRules())
    start = engine.start(session)
    build = engine.answer(start, material)
    event = engine.answer(build, 'Let us watch carefully together.')
    return engine, start, build, event


def finish(manager, job):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        result = manager.get(job['jobId'], job['sessionId'])
        if result['status'] not in {'queued', 'running'}:
            return result
        time.sleep(.005)
    raise AssertionError('Image fixture did not finish')


def review(**overrides):
    verdict = dict(safe=True, materialMatches=True, castMatches=True, actionMatches=True,
                   expressionMatches=True)
    verdict.update(overrides)
    return {'status': 'completed', 'output': [{'type': 'message', 'content': [
        {'type': 'output_text', 'text': json.dumps(verdict)}]}]}


class ImageProviderTests(unittest.TestCase):
    def setUp(self):
        self.build = scenes()[2]
        self.spec = normalize(self.build)
        self.edit = {'data': [{'b64_json': base64.b64encode(JPEG).decode()}], 'output_format': 'jpeg'}

    def generate(self, replies, cancelled=None):
        responses = [io.BytesIO(json.dumps(reply).encode()) for reply in replies]
        with patch('urllib.request.urlopen', side_effect=responses) as send, \
                patch('media.image_provider.checked_jpeg', return_value=JPEG):
            image = MuseImageProvider('fixture-secret').generate(
                self.spec, self.build['mediaPlan'], [JPEG], cancelled or threading.Event())
        return image, send

    def test_edit_uses_approved_facts_and_review_independently_inspects_pixels(self):
        image, send = self.generate([self.edit, review()])
        self.assertEqual(image, JPEG)
        self.assertEqual(send.call_count, 2)
        edit_request, review_request = [call.args[0] for call in send.call_args_list]
        body, check = json.loads(edit_request.data), json.loads(review_request.data)
        self.assertTrue(edit_request.full_url.endswith('/images/edits'))
        self.assertEqual((body['model'], body['n'], body['response_format']), ('muse-image-1.0', 1, 'b64_json'))
        self.assertEqual(body['output_format'], 'jpeg')
        self.assertEqual(body['reasoning_strength'], 'low')
        self.assertEqual(body['images'][0]['image_url'], 'data:image/jpeg;base64,' + base64.b64encode(JPEG).decode())
        self.assertTrue(all(value is False for value in body['tool_enablement'].values()))
        self.assertIn('paper', body['prompt'])
        facts = scene_facts(self.spec, self.build['mediaPlan'])
        self.assertEqual(facts['castCount'], 1)
        self.assertEqual(set(facts['characterDescriptions']), {'pig1'})
        self.assertNotIn('Let us watch', body['prompt'])
        self.assertTrue(review_request.full_url.endswith('/responses'))
        self.assertIs(check['store'], False)
        self.assertEqual(check['reasoning'], {'effort': 'low'})
        self.assertEqual(check['input'][0]['content'][1]['type'], 'input_image')

    def test_image_refinement_can_be_restored_without_disabling_independent_review(self):
        responses = [io.BytesIO(json.dumps(reply).encode()) for reply in (self.edit, review())]
        with patch('urllib.request.urlopen', side_effect=responses) as send, \
                patch('media.image_provider.checked_jpeg', return_value=JPEG):
            MuseImageProvider('fixture-secret', reasoning_strength='high').generate(
                self.spec, self.build['mediaPlan'], [JPEG], threading.Event())
        self.assertEqual(json.loads(send.call_args_list[0].args[0].data)['reasoning_strength'], 'high')
        self.assertEqual(send.call_count, 2)
        with self.assertRaises(ValueError):
            MuseImageProvider('fixture-secret', reasoning_strength='minimal')

    def test_failed_or_uncertain_independent_review_never_publishes(self):
        for verdict in (review(safe=False), review(materialMatches=False), review(castMatches=False),
                        review(actionMatches='true'), review(expressionMatches=False),
                        review(expressionMatches='true'), {'status': 'incomplete'}):
            with self.subTest(verdict=verdict), self.assertRaisesRegex(ImageError, 'image_review_failed'):
                self.generate([self.edit, verdict])

    def test_bad_image_envelope_is_not_retried(self):
        for reply in ({'data': []}, {'data': [{'b64_json': '!invalid!'}]}, {'data': None}):
            with self.subTest(reply=reply), self.assertRaisesRegex(ImageError, 'image_invalid_response'):
                self.generate([reply])

    def test_error_bodies_and_secrets_do_not_escape_and_no_retry_occurs(self):
        for status, code in ((429, 'image_rate_limited'), (500, 'image_http_error')):
            error = urllib.error.HTTPError('https://api.meta.ai/v1/images/edits', status,
                'private text', {}, io.BytesIO(b'fixture-secret private child input'))
            with patch('urllib.request.urlopen', side_effect=error) as send, self.assertRaises(ImageError) as caught:
                MuseImageProvider('fixture-secret').generate(self.spec, self.build['mediaPlan'], [JPEG], threading.Event())
            self.assertEqual(str(caught.exception), code)
            self.assertEqual(send.call_count, 1)

    def test_cancellation_before_review_avoids_the_second_paid_call(self):
        cancelled = threading.Event()
        def normalize_and_cancel(raw):
            cancelled.set()
            return JPEG
        with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(self.edit).encode())) as send, \
                patch('media.image_provider.checked_jpeg', side_effect=normalize_and_cancel), \
                self.assertRaisesRegex(ImageError, 'image_cancelled'):
            MuseImageProvider('fixture-secret').generate(self.spec, self.build['mediaPlan'], [JPEG], cancelled)
        self.assertEqual(send.call_count, 1)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg validates generated pixels')
    def test_generated_pixels_are_decoded_and_broken_jpegs_are_rejected(self):
        normalized = checked_jpeg(JPEG)
        self.assertTrue(normalized.startswith(b'\xff\xd8') and normalized.endswith(b'\xff\xd9'))
        self.assertLessEqual(len(normalized), 2 * 1024 * 1024)
        with self.assertRaisesRegex(ImageError, 'image_decode_failed'):
            checked_jpeg(b'\xff\xd8not a real image')


class FakeImages:
    def __init__(self, gated=False, fail=False):
        self.calls = []
        self.started, self.release = threading.Event(), threading.Event()
        self.both_started = threading.Event()
        self.fail = fail
        if not gated:
            self.release.set()

    def generate(self, spec, plan, references, cancelled):
        self.calls.append((spec, plan, references))
        self.started.set()
        if len(self.calls) >= 2:
            self.both_started.set()
        self.release.wait(3)
        if self.fail:
            raise ImageError('private fixture error')
        return JPEG


class ImageJobTests(unittest.TestCase):
    def setUp(self):
        self.engine, self.start, self.build, self.event = scenes()
        self.managers = []

    def manager(self, **kwargs):
        provider = FakeImages(**kwargs)
        manager = MediaJobs(image_provider=provider)
        self.managers.append(manager)
        return manager, provider

    def tearDown(self):
        for manager in self.managers:
            manager.image_provider.release.set()
            manager.close()

    def test_each_new_accepted_answer_generates_and_same_binding_is_deduplicated(self):
        manager, provider = self.manager()
        with ThreadPoolExecutor(8) as pool:
            jobs = list(pool.map(manager.request, [self.build] * 8))
        self.assertEqual(len({job['jobId'] for job in jobs}), 1)
        first = finish(manager, jobs[0])
        second = finish(manager, manager.request(self.event))
        self.assertEqual(len(provider.calls), 2)
        self.assertTrue(first['generated'] and second['generated'])
        self.assertEqual(second['source'], 'muse_image')
        self.assertEqual(second['reason'], 'generated_image_reviewed')
        self.assertEqual(provider.calls[1][2][0], JPEG, 'Next scene edits the generated house reference')
        self.assertIsNone(second['video'])

    def test_translation_rebinds_one_inflight_generation_without_a_paid_duplicate(self):
        manager, provider = self.manager(gated=True)
        old = manager.request(self.build)
        self.assertTrue(provider.started.wait(1))
        translated = self.engine.change_language(self.build, 'ko')
        current = manager.request(translated)
        provider.release.set()
        ready = finish(manager, current)
        self.assertTrue(ready['generated'])
        self.assertEqual(ready['version'], translated['version'])
        self.assertFalse(manager.get(old['jobId'], old['sessionId'])['apply'])
        self.assertEqual(len(provider.calls), 1)

    def test_cancel_and_late_completion_cannot_publish_or_resubmit(self):
        manager, provider = self.manager(gated=True)
        job = manager.request(self.build)
        self.assertTrue(provider.started.wait(1))
        manager.cancel(job['jobId'], job['sessionId'])
        provider.release.set()
        self.assertEqual(manager.request(self.build)['status'], 'cancelled')
        translated = self.engine.change_language(self.build, 'ko')
        self.assertEqual(manager.request(translated)['status'], 'cancelled')
        self.assertEqual(len(provider.calls), 1)
        self.assertFalse(manager.images)

    def test_mock_and_rejected_answers_never_call_the_live_generator(self):
        manager, provider = self.manager()
        rejected = self.engine.answer(self.start, '')
        self.assertEqual(manager.request(rejected)['status'], 'no_new_media')
        mock = deepcopy(self.build)
        mock['providerMode'] = 'mock'
        ready = finish(manager, manager.request(mock))
        self.assertFalse(ready['generated'])
        self.assertFalse(ready['generationRequested'])
        self.assertEqual(provider.calls, [])

    def test_every_reachable_touch_choice_uses_exact_stored_art_in_both_languages(self):
        for language in ('en', 'ko'):
            manager, provider = self.manager()
            engine = StoryEngine(LiveRules(), language=language)
            pending = [((), engine.start(f'{language}-root'))]
            visited, assets, actions = set(), set(), set()
            serial = 0
            with patch.object(manager.pool, 'submit', side_effect=AssertionError('Touch art must not queue')), \
                    patch.object(manager.provider, 'resolve', side_effect=AssertionError('Touch art must not resolve video')):
                while pending:
                    path, state = pending.pop(0)
                    if state['question'] is None:
                        continue
                    story = state['storyState']
                    signature = (state['sceneId'], story['houses'][-1]['material']
                                 if story['stage'] != 'choose' else None)
                    if signature in visited:
                        continue
                    visited.add(signature)
                    for choice in state['question']['choices']:
                        # Each alternative is a distinct session, so immutable
                        # server bindings cannot reuse another branch's image.
                        serial += 1
                        branch = engine.start(f'{language}-touch-{serial}')
                        for choice_id in path:
                            branch = engine.answer(branch, '', choice_id=choice_id)
                        accepted = engine.answer(branch, 'forged free text', choice_id=choice['id'])
                        spec = normalize(accepted)
                        with self.subTest(language=language, scene=state['sceneId'], choice=choice['id']):
                            ready = manager.request(accepted)
                            self.assertEqual(ready['status'], 'ready')
                            self.assertEqual(ready['source'], 'prepared_choice')
                            self.assertEqual(ready['reason'], 'prepared_choice_image')
                            self.assertEqual(ready['image'], manager.registry.image(spec))
                            self.assertEqual(ready['spec']['selection']['answer'], choice['answer'])
                            self.assertFalse(ready['generated'] or ready['generationRequested'])
                            self.assertFalse(ready['generationRetryAvailable'])
                            self.assertEqual(ready['retriesRemaining'], 0)
                        assets.add(spec.asset_key)
                        actions.add(spec.action)
                        pending.append((path + (choice['id'],), accepted))
            self.assertEqual(len(assets), 19)
            self.assertTrue({'build', 'move_to_next_house', 'safe_ending', 'blown_away',
                             'collapsed', 'eaten', 'melted', 'stood'} <= actions)
            self.assertEqual(provider.calls, [])

    def test_touch_art_reload_and_translation_reuse_without_generation(self):
        manager, provider = self.manager()
        accepted = self.engine.answer(self.start, '', choice_id='paper')
        ready = manager.request(accepted)
        self.assertEqual(manager.request(accepted)['jobId'], ready['jobId'])
        self.assertEqual(manager.request(accepted, retry_of=ready['jobId'])['jobId'], ready['jobId'])
        translated = self.engine.change_language(accepted, 'ko')
        current = manager.request(translated)
        self.assertEqual(current['status'], 'ready')
        self.assertEqual(current['source'], 'prepared_choice')
        self.assertEqual(current['image'], ready['image'])
        self.assertNotEqual(current['jobId'], ready['jobId'])
        self.assertFalse(manager.get(ready['jobId'], ready['sessionId'])['apply'])
        self.assertEqual(provider.calls, [])
        free = self.engine.answer(translated, '함께 지켜볼래요')
        self.assertIsNone(free['selection'])
        self.assertTrue(finish(manager, manager.request(free))['generated'])
        self.assertEqual(len(provider.calls), 1)

    def test_touch_art_is_ready_while_both_image_workers_are_busy(self):
        manager, provider = self.manager(gated=True)
        manager.request(scenes(session='busy-one')[2])
        self.assertTrue(provider.started.wait(1))
        manager.request(scenes(session='busy-two')[2])
        self.assertTrue(provider.both_started.wait(1))
        accepted = self.engine.answer(self.start, '', choice_id='paper')
        ready = manager.request(accepted)
        self.assertEqual(ready['status'], 'ready')
        self.assertEqual(ready['source'], 'prepared_choice')
        self.assertEqual(len(provider.calls), 2)

    def test_offline_free_answer_cache_does_not_mask_ready_touch_art(self):
        manager, provider = self.manager()
        mock = deepcopy(self.build)
        mock['providerMode'] = 'mock'
        fallback = finish(manager, manager.request(mock))
        self.assertEqual(fallback['source'], 'local_assets')
        engine = StoryEngine(LiveRules())
        start = engine.start('touch-after-local')
        ready = manager.request(engine.answer(start, '', choice_id='paper'))
        self.assertEqual(ready['status'], 'ready')
        self.assertEqual(ready['source'], 'prepared_choice')
        self.assertEqual(ready['image'], fallback['image'])
        self.assertEqual(provider.calls, [])

    def test_touch_art_is_available_without_an_image_generator(self):
        manager = MediaJobs()
        self.addCleanup(manager.close)
        accepted = self.engine.answer(self.start, '', choice_id='paper')
        ready = manager.request(accepted)
        self.assertEqual(ready['status'], 'ready')
        self.assertEqual(ready['source'], 'prepared_choice')
        self.assertFalse(ready['generationRequested'])

    def test_failed_review_keeps_truthful_prepared_fallback_and_does_not_retry(self):
        manager, provider = self.manager(fail=True)
        job = manager.request(self.build)
        ready = finish(manager, job)
        self.assertEqual(ready['status'], 'failed')
        self.assertFalse(ready['generated'])
        self.assertTrue(ready['generationRequested'])
        self.assertEqual(ready['image']['url'], '/prototype/img/paper_house.jpg')
        self.assertNotIn('private', json.dumps(ready))
        manager.request(self.build)
        self.assertEqual(len(provider.calls), 1)

    def test_explicit_retry_replaces_failed_work_once_even_for_simultaneous_clicks(self):
        manager, provider = self.manager(fail=True)
        first = finish(manager, manager.request(self.build))
        provider.fail = False
        with ThreadPoolExecutor(8) as pool:
            retried = list(pool.map(lambda _: manager.request(self.build, retry_of=first['jobId']), range(8)))
        self.assertEqual(len({job['jobId'] for job in retried}), 1)
        ready = finish(manager, retried[0])
        self.assertNotEqual(ready['jobId'], first['jobId'])
        self.assertTrue(ready['generated'])
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual(manager.request(self.build)['jobId'], ready['jobId'])
        self.assertEqual(manager.request(self.build, retry_of=first['jobId'])['jobId'], ready['jobId'])
        self.assertFalse(manager.get(first['jobId'], first['sessionId'])['apply'])

    def test_ready_or_running_picture_reattaches_without_generating_again(self):
        manager, provider = self.manager(gated=True)
        first = manager.request(self.build)
        self.assertTrue(provider.started.wait(1))
        self.assertEqual(manager.request(self.build, retry_of=first['jobId'])['jobId'], first['jobId'])
        provider.release.set()
        ready = finish(manager, first)
        self.assertEqual(manager.request(self.build, retry_of=first['jobId'])['image'], ready['image'])
        self.assertEqual(len(provider.calls), 1)

    def test_generation_retries_are_bounded_and_translation_does_not_reset_the_limit(self):
        manager, provider = self.manager(fail=True)
        job = finish(manager, manager.request(self.build))
        for remaining in (1, 0):
            job = finish(manager, manager.request(self.build, retry_of=job['jobId']))
            self.assertEqual(job['retriesRemaining'], remaining)
        self.assertFalse(job['generationRetryAvailable'])
        with self.assertRaisesRegex(JobError, 'image_retry_limit'):
            manager.request(self.build, retry_of=job['jobId'])
        translated = self.engine.change_language(self.build, 'ko')
        translated_job = finish(manager, manager.request(translated))
        self.assertEqual(translated_job['retriesRemaining'], 0)
        with self.assertRaisesRegex(JobError, 'image_retry_limit'):
            manager.request(translated, retry_of=translated_job['jobId'])
        self.assertEqual(len(provider.calls), 3)

    def test_cancelled_foreign_and_stale_jobs_cannot_be_retried(self):
        manager, provider = self.manager(fail=True)
        first = finish(manager, manager.request(self.build))
        manager.cancel(first['jobId'], first['sessionId'])
        with self.assertRaisesRegex(JobError, 'retry_not_allowed'):
            manager.request(self.build, retry_of=first['jobId'])
        with self.assertRaisesRegex(JobError, 'job_not_found'):
            manager.request(scenes(session='other-child')[2], retry_of=first['jobId'])
        current = manager.request(self.event)
        with self.assertRaisesRegex(JobError, 'stale_snapshot'):
            manager.request(self.build, retry_of=first['jobId'])
        with self.assertRaisesRegex(JobError, 'retry_not_allowed'):
            manager.request(self.event, retry_of=first['jobId'])
        finish(manager, current)
        self.assertEqual(len(provider.calls), 2)

    def test_timeout_and_late_old_completion_cannot_overwrite_a_manual_retry(self):
        manager, provider = self.manager(gated=True)
        first = manager.request(self.build)
        self.assertTrue(provider.started.wait(1))
        old_work = manager.jobs[first['jobId']]['work']
        manager._expire(old_work)
        replacement = manager.request(self.build, retry_of=first['jobId'])
        provider.release.set()
        ready = finish(manager, replacement)
        image = ready['image']
        manager.pool.submit(lambda: None).result(timeout=1)
        manager._expire(old_work)
        manager.cancel(first['jobId'], first['sessionId'])
        self.assertEqual(manager.get(ready['jobId'], ready['sessionId'])['image'], image)
        self.assertEqual(len(manager.images), 1)
        self.assertEqual(len(provider.calls), 2)

    def test_custom_material_and_canonical_touch_selection_reach_the_image_provider(self):
        manager, provider = self.manager()
        engine, _, custom, _ = scenes('비닐로 집을 만들래!')
        result = finish(manager, manager.request(custom))
        self.assertTrue(result['generated'])
        spec, plan, _ = provider.calls[0]
        self.assertEqual(spec.material, 'custom')
        self.assertEqual(scene_facts(spec, plan)['material'], spec.material_spec['labels']['en'])
        failed = engine.answer(custom, '')
        choice = failed['question']['choices'][0]
        accepted = engine.answer(failed, 'ignore this forged answer', choice_id=choice['id'])
        finish(manager, manager.request(accepted))
        self.assertEqual(provider.calls[-1][0].selection['answer'], choice['answer'])

    def test_generated_images_are_session_scoped(self):
        manager, provider = self.manager()
        first = finish(manager, manager.request(self.build))
        image_id = first['image']['url'].split('/')[-1].split('?')[0]
        self.assertEqual(manager.image(image_id, self.build['sessionId']), JPEG)
        with self.assertRaisesRegex(JobError, 'image_not_found'):
            manager.image(image_id, 'another-session')
        other = scenes(session='another-session')[2]
        finish(manager, manager.request(other))
        self.assertEqual(len(provider.calls), 2)


class IntegratedImageAPITests(unittest.TestCase):
    def test_touch_answer_image_and_microphone_routes_share_one_server(self):
        class Transcriber:
            def transcribe(self, raw):
                return 'paper'
        images = FakeImages()
        app = VisionPlayground('fixture-key', provider_factory=lambda mode: LiveRules(),
            transcriber=Transcriber(), media=MediaJobs(image_provider=images))
        server = VisionServer(('127.0.0.1', 0), app)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(method, path, body=None, content_type='application/json'):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            payload = json.dumps(body) if isinstance(body, dict) else body
            connection.request(method, path, payload, {'Content-Type': content_type})
            response = connection.getresponse()
            raw, status, kind = response.read(), response.status, response.getheader('Content-Type')
            connection.close()
            return status, raw if kind == 'image/jpeg' else json.loads(raw)
        try:
            config = request('GET', '/api/config')[1]
            self.assertTrue(config['speechAvailable'] and config['imageGenerationAvailable'])
            start = request('POST', '/api/sessions', {'mode': 'live'})[1]
            state = request('POST', '/api/answer', {'sessionId': start['sessionId'], 'version': 0,
                'questionId': start['question']['id'], 'requestId': 'tap', 'choiceId': 'paper',
                'answer': 'untrusted material'})[1]
            binding = {key: state[key] for key in ('sessionId', 'sceneId', 'version')}
            self.assertEqual(request('POST', '/api/media/jobs', {**binding, 'prompt': 'forged'})[0], 400)
            job = request('POST', '/api/media/jobs', binding)[1]
            self.assertEqual(job['status'], 'ready')
            self.assertEqual(job['source'], 'prepared_choice')
            self.assertFalse(job['generated'] or job['generationRequested'])
            self.assertEqual(job['spec']['selection']['choiceId'], 'paper')
            self.assertEqual(job['spec']['material'], 'paper', 'Forged answer text must not select the art')
            self.assertEqual(images.calls, [])
            stored = (ROOT / 'prototype/img/paper_house.jpg').read_bytes()
            self.assertEqual(request('GET', job['image']['url']), (200, stored))
            state = request('POST', '/api/answer', {'sessionId': state['sessionId'],
                'version': state['version'], 'questionId': state['question']['id'],
                'requestId': 'free', 'answer': 'Let us watch carefully together.'})[1]
            binding = {key: state[key] for key in ('sessionId', 'sceneId', 'version')}
            result = finish(app.media, request('POST', '/api/media/jobs', binding)[1])
            self.assertTrue(result['generated'])
            self.assertIsNone(images.calls[0][0].selection)
            self.assertEqual(request('GET', result['image']['url']), (200, JPEG))
            other = request('POST', '/api/sessions', {'mode': 'live'})[1]
            self.assertEqual(request('GET', result['image']['url'].replace(start['sessionId'], other['sessionId']))[0], 404)
            with patch('speech.server.to_wav', return_value=b'wav'), patch('speech.server.duration_ms', return_value=1000):
                self.assertEqual(request('POST', '/api/transcribe', b'recording', 'audio/webm'), (200, {'transcript': 'paper'}))
            app.sessions[start['sessionId']].touched -= SESSION_TTL + 1
            self.assertEqual(request('GET', result['image']['url'])[0], 404)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            app.media.close()
