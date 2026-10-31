"""Run the story playground plus local media API: python -m media.server."""
import argparse
from copy import deepcopy
import json
from http.server import ThreadingHTTPServer
import time
from urllib.parse import parse_qs, unquote, urlsplit

from story_agent.server import APIError, Handler, MAX_BODY, Playground, SESSION_TTL
from .contracts import InvalidPlan
from .jobs import JobError, MediaJobs, fixed_followers


class MediaPlayground(Playground):
    def __init__(self, *args, media=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.media = media or MediaJobs()

    def config(self):
        return {**super().config(), 'mediaAvailable': True,
                'imageGenerationAvailable': self.media.image_provider is not None}

    def create(self, *args, **kwargs):
        snapshot = super().create(*args, **kwargs)
        self.media.activate(snapshot)
        return snapshot

    def answer(self, body):
        result = super().answer(body)
        self.media.activate(result)
        return result

    def change_language(self, body):
        result = super().change_language(body)
        self.media.activate(result)
        return result

    def advance(self, body):
        result = super().advance(body)
        self.media.activate(result)
        self.media.cancel_session(result['sessionId'], through_version=result['version'])
        return result

    def media_snapshot(self, session_id):
        if not isinstance(session_id, str):
            raise APIError(400, 'invalid_request', 'Send a sessionId.')
        with self.lock:
            session = self.sessions.get(session_id)
            if session is None or time.monotonic() - session.touched >= SESSION_TTL:
                raise APIError(404, 'session_not_found', 'Start a story session.')
            # Story commits and manual session replacement use this short lock;
            # reading approved state must not wait for an in-flight model call.
            return deepcopy(session.snapshot)

    def media_request(self, body):
        required = {'sessionId', 'sceneId', 'version'}
        if (set(body) not in (required, required | {'retryOf'}) or type(body.get('version')) is not int
                or ('retryOf' in body and (not isinstance(body['retryOf'], str) or not body['retryOf']))):
            raise APIError(400, 'invalid_request', 'Send sessionId, sceneId, version and an optional retryOf job ID.')
        snapshot = self.media_snapshot(body['sessionId'])
        with self.lock:
            # Navigation can replace the session while a media request arrives.
            snapshot = self.sessions[body['sessionId']].snapshot
            if (body['version'], body['sceneId']) != (snapshot['version'], snapshot['sceneId']):
                raise APIError(409, 'stale_snapshot', 'Use the current story snapshot.')
            if snapshot['diagnostics'].get('manualNavigation', {}).get('skippedPicture'):
                return {'status': 'no_new_media', 'jobId': None, 'apply': False, 'reason': 'manual_navigation'}
            view = self.media.request(snapshot, retry_of=body.get('retryOf'))
        # Draw the pictures this page already fixes while the child reads it (fixed_followers).
        self.media.draw_ahead(snapshot, fixed_followers(snapshot))
        return view

    def media_status(self, job_id, session_id, cancel=False):
        self.media.activate(self.media_snapshot(session_id))
        return (self.media.cancel if cancel else self.media.get)(job_id, session_id)


class MediaHandler(Handler):
    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path.startswith('/api/media/images/'):
            try:
                self.guard()
                values = parse_qs(parsed.query)
                if set(values) != {'sessionId'} or len(values['sessionId']) != 1:
                    raise APIError(400, 'invalid_request', 'Send one sessionId.')
                session_id = values['sessionId'][0]
                self.server.playground.media_snapshot(session_id)
                image = self.server.playground.media.image(parsed.path.rsplit('/', 1)[1], session_id)
                return self.reply(200, image, 'image/jpeg')
            except (APIError, JobError) as exc:
                return self._media_error(exc)
        if not parsed.path.startswith('/api/media/jobs/'):
            # Serve registered clips with a playable MIME type, never arbitrary paths.
            registry = self.server.playground.media.registry
            target = (registry.root / unquote(parsed.path).lstrip('/')).resolve()
            if target.is_relative_to((registry.root / 'prototype/video').resolve()):
                try:
                    self.guard()
                    for entry in registry.data.get('clips', {}).values():
                        asset = registry._asset(entry, 'video')
                        if asset and (registry.root / asset['url'].lstrip('/')).resolve() == target:
                            return self.reply(200, (registry.root / asset['url'].lstrip('/')).read_bytes(), 'video/mp4')
                    raise APIError(404, 'not_found', 'Clip not found.')
                except APIError as exc:
                    return self.error(exc)
            return super().do_GET()
        try:
            self.guard()
            values = parse_qs(parsed.query)
            if set(values) != {'sessionId'} or len(values['sessionId']) != 1:
                raise APIError(400, 'invalid_request', 'Send one sessionId.')
            result = self.server.playground.media_status(parsed.path.rsplit('/', 1)[1], values['sessionId'][0])
            self.reply(200, result)
        except (APIError, JobError, InvalidPlan) as exc:
            self._media_error(exc)

    def do_POST(self):
        if urlsplit(self.path).path not in {'/api/media/jobs', '/api/media/cancel'}:
            return super().do_POST()
        try:
            self.guard()
            if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                raise APIError(415, 'content_type', 'Send application/json.')
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                raise APIError(400, 'invalid_length', 'Invalid request size.')
            if not 0 < length <= MAX_BODY:
                raise APIError(413, 'body_size', 'Request too large or empty.')
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                raise APIError(400, 'invalid_json', 'Send a JSON object.')
            if not isinstance(body, dict):
                raise APIError(400, 'invalid_request', 'Send a JSON object.')
            app = self.server.playground
            if urlsplit(self.path).path == '/api/media/jobs':
                result = app.media_request(body)
            else:
                if set(body) != {'jobId', 'sessionId'} or not isinstance(body['jobId'], str):
                    raise APIError(400, 'invalid_request', 'Send jobId and sessionId.')
                result = app.media_status(body['jobId'], body['sessionId'], cancel=True)
            self.reply(200, result)
        except (APIError, JobError, InvalidPlan) as exc:
            self._media_error(exc)

    def _media_error(self, exc):
        if isinstance(exc, APIError):
            return self.error(exc)
        code = str(exc)
        status = (404 if code in {'job_not_found', 'image_not_found'}
                  else 429 if code in {'job_limit', 'image_retry_limit'} else 409)
        self.error(APIError(status, code, 'Media unavailable; keep the current picture.'))


class MediaServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, playground):
        self.playground = playground
        super().__init__(address, MediaHandler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    # Local-only default deliberately does not load credentials from .env.
    app = MediaPlayground()
    try:
        with MediaServer(('127.0.0.1', args.port), app) as server:
            print(f'Offline story + media: http://127.0.0.1:{server.server_port}/', flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.media.close()


if __name__ == '__main__':
    main()
