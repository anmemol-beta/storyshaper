"""Run the story playground plus local media API: python -m media.server."""
import argparse
from copy import deepcopy
import json
from http.server import ThreadingHTTPServer
import time
from urllib.parse import parse_qs, unquote, urlsplit

from story_agent.server import APIError, Handler, MAX_BODY, Playground, SESSION_TTL
from .contracts import InvalidPlan
from .jobs import JobError, MediaJobs


class MediaPlayground(Playground):
    def __init__(self, *args, media=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.media = media or MediaJobs()

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

    def media_snapshot(self, session_id):
        if not isinstance(session_id, str):
            raise APIError(400, 'invalid_request', 'Send a sessionId.')
        with self.lock:
            session = self.sessions.get(session_id)
        if session is None:
            raise APIError(404, 'session_not_found', 'Start a story session.')
        with session.lock:
            if time.monotonic() - session.touched >= SESSION_TTL:
                raise APIError(404, 'session_not_found', 'Start a story session.')
            return deepcopy(session.snapshot)

    def media_request(self, body):
        if set(body) != {'sessionId', 'sceneId', 'version'} or type(body['version']) is not int:
            raise APIError(400, 'invalid_request', 'Send only sessionId, sceneId and version.')
        snapshot = self.media_snapshot(body['sessionId'])
        if (body['version'], body['sceneId']) != (snapshot['version'], snapshot['sceneId']):
            raise APIError(409, 'stale_snapshot', 'Use the current story snapshot.')
        return self.media.request(snapshot)

    def media_status(self, job_id, session_id, cancel=False):
        self.media.activate(self.media_snapshot(session_id))
        return (self.media.cancel if cancel else self.media.get)(job_id, session_id)


class MediaHandler(Handler):
    def do_GET(self):
        parsed = urlsplit(self.path)
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
        status = 404 if code == 'job_not_found' else 429 if code == 'job_limit' else 409
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
            print(f'Offline story + media: http://127.0.0.1:{server.server_port}/prototype/agent.html', flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.media.close()


if __name__ == '__main__':
    main()
