import base64
import http.client
import io
import json
import threading
import unittest
from unittest.mock import patch
import urllib.error

from vision.see import MuseVision, VisionError
from vision.server import MAX_IMAGE, VisionPlayground, VisionServer

JPEG = b'\xff\xd8\xff\xe0 frame'


def envelope(text, status='completed'):
    return {'status': status, 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': text}]}]}


class FakeVision:
    def __init__(self, name='cookies', error=None):
        self.name, self.error, self.calls = name, error, []

    def name_object(self, image, content_type, language):
        self.calls.append((image, content_type, language))
        if self.error:
            raise VisionError(self.error)
        return self.name


class MuseVisionTests(unittest.TestCase):
    def ask(self, reply):
        response = io.BytesIO(json.dumps(reply).encode())
        with patch('urllib.request.urlopen', return_value=response) as send:
            name = MuseVision('test-secret').name_object(JPEG, 'image/jpeg', 'ko')
        return name, json.loads(send.call_args.args[0].data)

    def test_frame_is_sent_as_an_image_part_with_low_reasoning(self):
        name, body = self.ask(envelope('{"object": " 과자 "}'))
        self.assertEqual(name, '과자')
        text, image = body['input'][0]['content']
        self.assertEqual(json.loads(text['text']), {'language': 'ko'})
        self.assertEqual(image['image_url'], 'data:image/jpeg;base64,' + base64.b64encode(JPEG).decode())
        self.assertEqual(body['reasoning'], {'effort': 'low'})
        self.assertIs(body['store'], False)

    def test_no_clear_object_is_an_empty_name(self):
        self.assertEqual(self.ask(envelope('{"object": null}'))[0], '')

    def test_unexpected_replies_are_service_errors(self):
        for reply in (envelope('{"object": "cookies", "person": "a child"}'), envelope('{"object": 3}'),
                      envelope('{"object": "%s"}' % ('x' * 61)), envelope('not json'),
                      envelope('{"object": "cookies"}', status='incomplete')):
            with self.subTest(reply=reply), self.assertRaises(VisionError) as caught:
                self.ask(reply)
            self.assertEqual(str(caught.exception), 'vision_invalid_response')

    def test_http_errors_never_expose_the_body(self):
        for status, code in ((429, 'vision_rate_limited'), (500, 'vision_http_error')):
            error = urllib.error.HTTPError('https://api.meta.ai/v1/responses', status, 'x', {},
                                           io.BytesIO(b'private body'))
            with self.subTest(status=status), patch('urllib.request.urlopen', side_effect=error), \
                    self.assertRaises(VisionError) as caught:
                MuseVision('test-secret').name_object(JPEG, 'image/jpeg', 'en')
            self.assertEqual(str(caught.exception), code)


class VisionAPITests(unittest.TestCase):
    def serve(self, vision):
        app = VisionPlayground(vision=vision)
        server = VisionServer(('127.0.0.1', 0), app)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join()
            app.media.close()
        self.addCleanup(stop)
        return server

    def post(self, server, body, content_type='image/jpeg', path='/api/see?language=ko'):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
        connection.request('POST', path, body, {'Content-Type': content_type})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_frame_returns_the_object_and_config_advertises_the_camera(self):
        fake = FakeVision('과자')
        server = self.serve(fake)
        self.assertEqual(self.post(server, JPEG), (200, {'object': '과자'}))
        self.assertEqual(fake.calls, [(JPEG, 'image/jpeg', 'ko')])
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        connection.request('GET', '/api/config')
        config = json.loads(connection.getresponse().read())
        self.assertTrue(config['visionAvailable'])
        self.assertIn('speechAvailable', config)
        connection.close()

    def test_bad_requests_and_service_errors_are_not_answers(self):
        cases = [
            (FakeVision(), 'image/gif', '/api/see', 415, 'content_type'),
            (FakeVision(), 'image/jpeg', '/api/see?language=fr', 400, 'language'),
            (None, 'image/jpeg', '/api/see', 503, 'missing_api_key'),
            (FakeVision(error='vision_http_error'), 'image/jpeg', '/api/see', 502, 'vision_http_error'),
            (FakeVision(error='vision_rate_limited'), 'image/jpeg', '/api/see', 429, 'vision_rate_limited'),
        ]
        for vision, kind, path, status, code in cases:
            with self.subTest(code=code):
                got_status, data = self.post(self.serve(vision), JPEG, kind, path)
                self.assertEqual((got_status, data['error']['code']), (status, code))
                self.assertNotIn('object', data)

    def test_oversized_frame_is_refused_before_reading(self):
        server = self.serve(FakeVision())
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        connection.putrequest('POST', '/api/see')
        connection.putheader('Content-Type', 'image/jpeg')
        connection.putheader('Content-Length', str(MAX_IMAGE + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual((response.status, json.loads(response.read())['error']['code']), (413, 'body_size'))
        connection.close()

    def test_story_and_speech_routes_still_work_on_the_same_server(self):
        server = self.serve(FakeVision())
        status, snapshot = self.post(server, b'{"mode":"mock"}', 'application/json', '/api/sessions')
        self.assertEqual(status, 200)
        self.assertEqual(self.post(server, b'RIFF', 'audio/x-aiff', '/api/transcribe')[0], 415)


if __name__ == '__main__':
    unittest.main()
