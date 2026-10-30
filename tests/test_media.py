"""Contract, concurrency and HTTP regression tests; no external provider calls."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import http.client
from itertools import product
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest

from media.assets import AssetRegistry, LocalProvider, ROOT
from media.contracts import InvalidPlan, normalize
from media.jobs import JobError, MediaJobs
from media.server import APIError, MediaPlayground, MediaServer
from story_agent.engine import STORY, MockProvider, StoryEngine


def snapshots(material='paper', session='session'):
    engine = StoryEngine(MockProvider())
    start = engine.start(session)
    build = engine.answer(start, material)
    event = engine.answer(build, 'Let us watch carefully together.')
    move = engine.answer(event, 'We can build carefully together.')
    return engine, start, build, event, move


def wait_job(manager, job):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        result = manager.get(job['jobId'], job['sessionId'])
        if result['status'] not in {'queued', 'running'}:
            return result
        time.sleep(.005)
    raise AssertionError('Local job did not finish')


class ContractTests(unittest.TestCase):
    def test_build_does_not_reveal_future_event_and_move_uses_destination(self):
        _, _, build, event, move = snapshots()
        registry = AssetRegistry()
        self.assertEqual(normalize(build).action, 'build')
        self.assertEqual(normalize(build).outcome, 'blown_away')
        self.assertEqual(registry.image(normalize(build))['url'], '/prototype/img/paper_house.jpg')
        self.assertIsNone(registry.clip(normalize(build)))
        self.assertEqual(registry.image(normalize(event))['url'], '/prototype/img/wolf_paper.jpg')
        spec = normalize(move)
        self.assertEqual((spec.house_id, spec.target_house_id), ('house1', 'house2'))
        self.assertEqual(registry.image(spec)['url'], '/prototype/img/pig2_empty.jpg')

    def test_no_false_image_for_unsupported_material_or_pig(self):
        pairs = [('cookie', 'eaten'), ('icecream', 'melted'), ('wood', 'collapsed')]
        data = json.loads((ROOT / 'media/scene_registry.json').read_text(encoding='utf-8'))
        for material, action in pairs:
            # Without its own picture a material gets none, never another material's page.
            del data['images'][f'house1/{material}/build'], data['images'][f'house1/{material}/{action}']
        registry = AssetRegistry(data)
        for material, action in pairs:
            _, _, build, event, _ = snapshots(material)
            self.assertEqual(normalize(event).action, action)
            self.assertIsNone(registry.image(normalize(build)))
            self.assertIsNone(registry.image(normalize(event)))

    def test_every_allowed_material_has_its_own_build_and_outcome_picture(self):
        registry = AssetRegistry()
        for index, house in enumerate(STORY['houses'], 1):
            for material in house['allowedMaterials']:
                for action in ('build', STORY['materials'][material]['outcome']):
                    key = f'house{index}/{material}/{action}'
                    with self.subTest(key=key):
                        entry = registry.data['images'][key]
                        self.assertIsNotNone(registry._asset(entry, 'image'))
                        if entry['file'].startswith('scenes/'):
                            self.assertEqual(entry['file'], f'scenes/house{index}_{material}_{action}.jpg')

    def test_all_authored_material_combinations_and_ending_normalize(self):
        for first, second, last in product(['paper', 'straw', 'wood', 'cookie', 'icecream'],
                                            ['paper', 'straw', 'wood', 'cookie', 'icecream'],
                                            ['brick', 'stone']):
            engine = StoryEngine(MockProvider())
            state = engine.start('graph')
            for material in (first, second, last):
                for answer in (material, 'Let us watch together.', 'We can help each other.'):
                    state = engine.answer(state, answer)
                    with self.subTest(first=first, second=second, last=last, scene=state['sceneId']):
                        spec = normalize(state)
                        self.assertEqual(spec.version, state['version'])
            self.assertEqual(normalize(state).asset_key, 'ending')

    def test_invalid_or_unaccepted_plans_never_start_media(self):
        engine, start, build, _, _ = snapshots()
        self.assertIsNone(normalize(start))
        self.assertIsNone(normalize(engine.answer(start, '')))
        self.assertIsNone(normalize(engine.answer(start, 'brick')))
        for path, value in [('action', 'blown_away'), ('material', 'cookie'),
                            ('version', True), ('sceneId', 'ending'), ('allPigsSafe', False),
                            ('status', 'ready'), ('characters', ['wolf'])]:
            tampered = deepcopy(build)
            tampered['mediaPlan'][path] = value
            with self.subTest(path=path), self.assertRaises(InvalidPlan):
                normalize(tampered)
        tampered = deepcopy(build)
        tampered['diagnostics']['validated'] = False
        with self.assertRaises(InvalidPlan):
            normalize(tampered)

    def test_authored_choice_and_localization_are_valid(self):
        engine = StoryEngine(MockProvider())
        state = engine.start('choice')
        state = engine.answer(state, '', state['question']['choices'][0]['id'])
        self.assertTrue(state['diagnostics']['authoredFallback'])
        self.assertEqual(normalize(state).action, 'build')
        korean = engine.change_language(state, 'ko')
        self.assertEqual(normalize(korean).asset_key, normalize(state).asset_key)

    def test_registry_missing_unreviewed_and_escaping_assets_are_not_served(self):
        registry = AssetRegistry({'revision': 1, 'images': {'house1/paper/build':
                                  {'file': '../../../.env'}}, 'clips': {}})
        self.assertIsNone(registry.image(normalize(snapshots()[2])))
        self.assertIsNone(registry._asset({'file': 'absent.mp4', 'reviewed': False}, 'video'))


class GateProvider:
    def __init__(self, registry, fail=False):
        self.local, self.fail = LocalProvider(registry), fail
        self.started, self.release = threading.Event(), threading.Event()
        self.calls = 0

    def resolve(self, spec, cancelled):
        self.calls += 1
        self.started.set()
        self.release.wait(3)
        if self.fail:
            raise RuntimeError('private provider output must never reach the API')
        return self.local.registry.clip(spec)


class JobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'prototype/video').mkdir(parents=True)
        shutil.copytree(ROOT / 'prototype/img', root / 'prototype/img')
        # Byte fixture exercises delivery/approval state; it is not a playable generated video.
        (root / 'prototype/video/paper.mp4').write_bytes(b'test-only-mp4-fixture')
        data = json.loads((ROOT / 'media/scene_registry.json').read_text(encoding='utf-8'))
        data['clips']['house1/paper/blown_away'] = {
            'file': 'paper.mp4', 'reviewed': True, 'cast': ['pig1', 'wolf']}
        self.registry = AssetRegistry(data, root=root)
        self.engine, self.start, self.build, self.event, self.move = snapshots()
        self.managers = []
        self.gates = []

    def manager(self, gated=False, **kwargs):
        provider = GateProvider(self.registry, kwargs.pop('fail', False)) if gated else None
        if provider:
            self.gates.append(provider)
        result = MediaJobs(self.registry, provider=provider, **kwargs)
        self.managers.append(result)
        return result, provider

    def tearDown(self):
        for gate in self.gates:
            gate.release.set()
        for manager in self.managers:
            manager.close()
        self.temp.cleanup()

    def test_missing_clip_and_missing_image_return_truthful_fallback(self):
        manager, _ = self.manager()
        result = wait_job(manager, manager.request(self.build))
        self.assertEqual(result['status'], 'fallback')
        self.assertIsNotNone(result['image'])
        self.assertIsNone(result['video'])
        self.assertFalse(result['generated'])
        cookie = snapshots('cookie', session='other')[3]
        del self.registry.data['images']['house1/cookie/eaten']  # a scene whose picture is missing
        result = wait_job(manager, manager.request(cookie))
        self.assertTrue(result['fallback']['keepCurrentImage'])
        self.assertEqual(result['reason'], 'scene_asset_unavailable')

    def test_simultaneous_duplicate_requests_call_provider_once(self):
        manager, gate = self.manager(gated=True)
        with ThreadPoolExecutor(max_workers=8) as executor:
            jobs = list(executor.map(lambda _: manager.request(self.event), range(16)))
        self.assertEqual(len({job['jobId'] for job in jobs}), 1)
        self.assertTrue(gate.started.wait(1))
        gate.release.set()
        self.assertEqual(wait_job(manager, jobs[0])['status'], 'ready')
        self.assertEqual(gate.calls, 1)

    def test_cancel_and_late_completion_cannot_publish_or_resubmit(self):
        manager, gate = self.manager(gated=True)
        job = manager.request(self.event)
        self.assertTrue(gate.started.wait(1))
        manager.cancel(job['jobId'], 'session')
        gate.release.set()
        manager.pool.shutdown(wait=True)
        result = manager.request(self.event)
        self.assertEqual(result['jobId'], job['jobId'])
        self.assertEqual(result['status'], 'cancelled')
        self.assertFalse(result['apply'])
        self.assertIsNone(result['video'])
        self.assertEqual(gate.calls, 1)

    def test_new_session_after_cancel_can_display_same_scene(self):
        manager, gate = self.manager(gated=True)
        first = manager.request(self.event)
        self.assertTrue(gate.started.wait(1))
        manager.cancel(first['jobId'], 'session')
        second = manager.request(snapshots(session='new-session')[3])
        self.assertTrue(second['apply'])
        self.assertIsNotNone(second['image'])
        self.assertNotEqual(second['status'], 'cancelled')
        gate.release.set()
        self.assertEqual(wait_job(manager, second)['status'], 'ready')
        self.assertEqual(gate.calls, 2)
        replay = manager.request(self.event)
        self.assertEqual(replay['jobId'], first['jobId'])
        self.assertFalse(replay['apply'])

    def test_new_version_after_cancel_does_not_inherit_cancelled_content(self):
        manager, gate = self.manager(gated=True)
        first = manager.request(self.event)
        self.assertTrue(gate.started.wait(1))
        manager.cancel(first['jobId'], 'session')
        translated = self.engine.change_language(self.event, 'ko')
        second = manager.request(translated)
        self.assertTrue(second['apply'])
        self.assertIsNotNone(second['image'])
        gate.release.set()
        self.assertEqual(wait_job(manager, second)['status'], 'ready')

    def test_old_completion_timeout_and_recancel_cannot_change_replacement_work(self):
        manager, _ = self.manager()
        registry = self.registry
        class SeparateGates:
            def __init__(self):
                self.lock = threading.Lock()
                self.started = [threading.Event(), threading.Event()]
                self.release = [threading.Event(), threading.Event()]
                self.calls = 0

            def resolve(self, spec, cancelled):
                with self.lock:
                    index = self.calls
                    self.calls += 1
                self.started[index].set()
                self.release[index].wait(3)
                return registry.clip(spec)
        provider = SeparateGates()
        manager.provider = provider
        try:
            first = manager.request(self.event)
            self.assertTrue(provider.started[0].wait(1))
            old_work = manager.jobs[first['jobId']]['work']
            manager.cancel(first['jobId'], 'session')
            second = manager.request(snapshots(session='replacement')[3])
            self.assertTrue(provider.started[1].wait(1))
            provider.release[0].set()
            # The only free worker runs this barrier after the old callback finishes.
            manager.pool.submit(lambda: None).result(timeout=1)
            manager._expire(old_work)
            manager.cancel(first['jobId'], 'session')
            current = manager.get(second['jobId'], 'replacement')
            self.assertEqual(current['status'], 'running')
            self.assertTrue(current['apply'])
            self.assertIsNone(current['video'])
            provider.release[1].set()
            self.assertEqual(wait_job(manager, second)['status'], 'ready')
            self.assertEqual(provider.calls, 2)
        finally:
            for event in provider.release:
                event.set()

    def test_advance_and_out_of_order_activation_do_not_restore_old_scene(self):
        manager, gate = self.manager(gated=True)
        job = manager.request(self.event)
        self.assertTrue(gate.started.wait(1))
        manager.activate(self.move)
        manager.activate(self.event)
        gate.release.set()
        manager.pool.shutdown(wait=True)
        result = manager.get(job['jobId'], 'session')
        self.assertEqual(result['reason'], 'superseded')
        self.assertFalse(result['apply'])
        with self.assertRaises(JobError):
            manager.request(self.event)

    def test_localization_reuses_reviewed_content_but_rebinds_version(self):
        manager, gate = self.manager(gated=True)
        first = manager.request(self.event)
        self.assertTrue(gate.started.wait(1))
        gate.release.set()
        video = wait_job(manager, first)['video']
        translated = self.engine.change_language(self.event, 'ko')
        second = manager.request(translated)
        self.assertNotEqual(second['jobId'], first['jobId'])
        self.assertEqual(second['version'], translated['version'])
        self.assertEqual(second['video'], video)
        self.assertEqual(second['reason'], 'cached_reviewed_clip')
        self.assertEqual(gate.calls, 1)
        self.assertFalse(manager.get(first['jobId'], 'session')['apply'])

    def test_timeout_ignores_late_success_and_preserves_still_image(self):
        manager, gate = self.manager(gated=True, timeout=.04)
        job = manager.request(self.event)
        self.assertTrue(gate.started.wait(1))
        result = wait_job(manager, job)
        self.assertEqual((result['status'], result['reason']), ('failed', 'timeout'))
        self.assertIsNotNone(result['image'])
        gate.release.set()
        manager.pool.shutdown(wait=True)
        self.assertIsNone(manager.get(job['jobId'], 'session')['video'])

    def test_language_change_during_resolution_shares_inflight_content(self):
        manager, gate = self.manager(gated=True)
        first = manager.request(self.event)
        self.assertTrue(gate.started.wait(1))
        translated = self.engine.change_language(self.event, 'ko')
        second = manager.request(translated)
        self.assertFalse(manager.get(first['jobId'], 'session')['apply'])
        gate.release.set()
        self.assertEqual(wait_job(manager, second)['status'], 'ready')
        self.assertEqual(gate.calls, 1)

    def test_cancel_does_not_abort_another_sessions_shared_local_work(self):
        manager, gate = self.manager(gated=True)
        first = manager.request(self.event)
        second = manager.request(snapshots(session='other')[3])
        self.assertTrue(gate.started.wait(1))
        manager.cancel(first['jobId'], 'session')
        gate.release.set()
        self.assertEqual(wait_job(manager, second)['status'], 'ready')
        self.assertEqual(gate.calls, 1)
        self.assertFalse(manager.get(first['jobId'], 'session')['apply'])

    def test_unregistered_provider_output_never_becomes_ready(self):
        manager, _ = self.manager()
        class Unreviewed:
            def resolve(self, spec, cancelled):
                return {'url': 'https://unreviewed.example/video.mp4'}
        manager.provider = Unreviewed()
        result = wait_job(manager, manager.request(self.event))
        self.assertEqual(result['status'], 'failed')
        self.assertIsNone(result['video'])
        self.assertIsNotNone(result['image'])

    def test_error_session_boundary_and_capacity(self):
        manager, gate = self.manager(gated=True, fail=True, capacity=1)
        job = manager.request(self.event)
        gate.release.set()
        result = wait_job(manager, job)
        self.assertEqual(result['reason'], 'provider_error')
        self.assertNotIn('private', json.dumps(result))
        with self.assertRaises(JobError):
            manager.get(job['jobId'], 'different-session')
        with self.assertRaises(JobError):
            manager.request(self.move)

    def test_rejected_answer_and_service_error_do_not_schedule_jobs(self):
        manager, _ = self.manager()
        rejected = self.engine.answer(self.start, 'brick')
        self.assertEqual(manager.request(rejected)['status'], 'no_new_media')
        class Broken:
            def complete(self, *args):
                raise RuntimeError('offline')
        engine = StoryEngine(Broken())
        failed = engine.answer(engine.start('broken'), 'paper')
        self.assertEqual(manager.request(failed)['status'], 'no_new_media')
        self.assertEqual(len(manager.jobs), 0)


class APITests(unittest.TestCase):
    def setUp(self):
        self.app = MediaPlayground()
        self.server = MediaServer(('127.0.0.1', 0), self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.start = self.app.create('mock')
        self.state = self.app.answer({'sessionId': self.start['sessionId'],
            'version': 0, 'questionId': self.start['question']['id'],
            'requestId': 'one', 'answer': 'paper'})

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.app.media.close()

    def http(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        connection.request(method, path, json.dumps(body) if body is not None else None,
                           headers or {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        return response.status, json.loads(raw)

    def binding(self):
        return {key: self.state[key] for key in ('sessionId', 'sceneId', 'version')}

    def test_custom_material_job_uses_server_identity_and_keeps_story_progressing(self):
        start = self.app.create('mock', 'ko')
        state = self.app.answer({'sessionId': start['sessionId'], 'version': 0,
            'questionId': start['question']['id'], 'requestId': 'custom-answer', 'answer': '비닐'})
        self.assertEqual(state['decision'], 'accept')
        binding = {key: state[key] for key in ('sessionId', 'sceneId', 'version')}
        status, job = self.http('POST', '/api/media/jobs', binding)
        self.assertEqual(status, 200)
        result = wait_job(self.app.media, job)
        self.assertEqual(result['reason'], 'scene_asset_unavailable')
        self.assertEqual(result['spec']['material'], 'custom')
        self.assertEqual(result['spec']['material_id'], state['mediaPlan']['materialId'])
        self.assertIsNone(result['image'])
        self.assertTrue(result['fallback']['keepCurrentImage'])
        status, _ = self.http('POST', '/api/media/jobs', binding | {'materialSpec': {'source': 'paper'}})
        self.assertEqual(status, 400)
        continued = self.app.answer({'sessionId': state['sessionId'], 'version': state['version'],
            'questionId': state['question']['id'], 'requestId': 'custom-predict', 'answer': '바람에 날아갈 것 같아요'})
        self.assertEqual(continued['decision'], 'accept')
        self.assertEqual(continued['sceneId'], 'house1_reflect')
        self.assertEqual(continued['version'], 2)

    def test_http_request_poll_cancel_and_untrusted_plan_rejection(self):
        status, first = self.http('POST', '/api/media/jobs', self.binding())
        self.assertEqual(status, 200)
        status, repeated = self.http('POST', '/api/media/jobs', self.binding())
        self.assertEqual(first['jobId'], repeated['jobId'])
        status, polled = self.http('GET', f"/api/media/jobs/{first['jobId']}?sessionId={self.state['sessionId']}")
        self.assertEqual(status, 200)
        self.assertEqual(polled['version'], self.state['version'])
        status, result = self.http('POST', '/api/media/cancel', {
            'sessionId': self.state['sessionId'], 'jobId': first['jobId']})
        self.assertEqual(result['status'], 'cancelled')
        status, _ = self.http('POST', '/api/media/jobs', self.binding() | {'mediaPlan': self.state['mediaPlan']})
        self.assertEqual(status, 400)
        status, _ = self.http('POST', '/api/media/jobs', self.binding() | {'version': 0})
        self.assertEqual(status, 409)

    def test_http_language_change_cancels_previous_binding_and_guards_hosts(self):
        _, first = self.http('POST', '/api/media/jobs', self.binding())
        status, translated = self.http('POST', '/api/language', {
            'sessionId': self.state['sessionId'], 'version': self.state['version'], 'language': 'ko'})
        self.assertEqual(status, 200)
        _, old = self.http('GET', f"/api/media/jobs/{first['jobId']}?sessionId={self.state['sessionId']}")
        self.assertFalse(old['apply'])
        self.assertEqual(old['status'], 'cancelled')
        status, _ = self.http('POST', '/api/media/jobs', self.binding(), {'Content-Type': 'application/json', 'Origin': 'https://evil.example'})
        self.assertEqual(status, 403)
        self.assertEqual(translated['version'], self.state['version'] + 1)

    def test_static_files_do_not_expose_credentials_or_unregistered_clips(self):
        status, _ = self.http('GET', '/.env')
        self.assertEqual(status, 404)
        status, _ = self.http('GET', '/prototype/video/unreviewed.mp4')
        self.assertEqual(status, 404)
        status, _ = self.http('GET', '/prototype/%76ideo/unreviewed.mp4')
        self.assertEqual(status, 404)
        status, _ = self.http('GET', '/prototype/img/../video/unreviewed.mp4')
        self.assertEqual(status, 404)

    def test_restart_uses_new_session_and_explicit_cancel_invalidates_old_binding(self):
        _, old = self.http('POST', '/api/media/jobs', self.binding())
        _, fresh = self.http('POST', '/api/sessions', {'mode': 'mock'})
        self.assertNotEqual(fresh['sessionId'], self.state['sessionId'])
        status, _ = self.http('GET', f"/api/media/jobs/{old['jobId']}?sessionId={fresh['sessionId']}")
        self.assertEqual(status, 404)
        _, cancelled = self.http('POST', '/api/media/cancel', {
            'jobId': old['jobId'], 'sessionId': self.state['sessionId']})
        self.assertFalse(cancelled['apply'])

    def test_http_new_session_gets_image_after_old_session_cancel(self):
        self.app.media.close()
        registry = AssetRegistry()
        gate = GateProvider(registry)
        self.app.media = MediaJobs(registry, provider=gate)
        try:
            _, old = self.http('POST', '/api/media/jobs', self.binding())
            self.assertTrue(gate.started.wait(1))
            self.http('POST', '/api/media/cancel', {
                'sessionId': self.state['sessionId'], 'jobId': old['jobId']})
            _, fresh = self.http('POST', '/api/sessions', {'mode': 'mock'})
            _, built = self.http('POST', '/api/answer', {
                'sessionId': fresh['sessionId'], 'version': fresh['version'],
                'questionId': fresh['question']['id'], 'requestId': 'fresh-answer', 'answer': 'paper'})
            status, job = self.http('POST', '/api/media/jobs', {
                key: built[key] for key in ('sessionId', 'sceneId', 'version')})
            self.assertEqual(status, 200)
            self.assertTrue(job['apply'])
            self.assertEqual(job['image']['url'], '/prototype/img/paper_house.jpg')
            self.assertNotEqual(job['status'], 'cancelled')
        finally:
            gate.release.set()

    def test_media_startup_has_no_live_key_and_expired_sessions_cannot_poll(self):
        self.assertFalse(self.app.config()['liveAvailable'])
        _, job = self.http('POST', '/api/media/jobs', self.binding())
        self.app.sessions[self.state['sessionId']].touched = 0
        status, _ = self.http('GET', f"/api/media/jobs/{job['jobId']}?sessionId={self.state['sessionId']}")
        self.assertEqual(status, 404)

    def test_reviewed_clip_has_video_mime_and_unreviewed_file_remains_hidden(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'prototype/video').mkdir(parents=True)
            fixture = b'test-fixture-not-a-generated-video'
            (root / 'prototype/video/reviewed.mp4').write_bytes(fixture)
            (root / 'prototype/video/unreviewed.mp4').write_bytes(fixture)
            self.app.media.registry = AssetRegistry({'revision': 1, 'images': {},
                'clips': {'example': {'file': 'reviewed.mp4', 'reviewed': True}}}, root)
            connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
            connection.request('GET', '/prototype/%76ideo/reviewed.mp4')
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader('Content-Type'), 'video/mp4')
            self.assertEqual(response.read(), fixture)
            connection.close()
            for path in ['/prototype/img/../video/unreviewed.mp4',
                         '/prototype/%76ideo/unreviewed.mp4',
                         '/prototype/video/unreviewed.mp4']:
                status, _ = self.http('GET', path)
                self.assertEqual(status, 404)


if __name__ == '__main__':
    unittest.main()
