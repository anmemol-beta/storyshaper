import http.client
import io
import json
import shutil
import subprocess
import threading
import unittest
import wave

from speech.server import MAX_AUDIO, SpeechPlayground, SpeechServer
from speech.transcribe import KEYWORDS, SpeechError, duration_ms, multipart, to_wav


def tone_wav(ms, rate=48000, channels=2):
    frames = rate * ms // 1000
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b'\x10\x00' * frames * channels)
    return buffer.getvalue()


class FakeTranscriber:
    def __init__(self, text='paper', error=None):
        self.text, self.error, self.calls = text, error, []

    def transcribe(self, wav_bytes):
        self.calls.append(wav_bytes)
        if self.error:
            raise SpeechError(self.error)
        return self.text


class TranscribeTests(unittest.TestCase):
    def test_request_has_settings_and_wav_parts(self):
        body = multipart('b0undary', {'mode': 'PUSH_TO_TALK', 'keywords': KEYWORDS}, b'RIFFdata')
        self.assertIn(b'name="request"\r\nContent-Type: application/json\r\n\r\n{"mode": "PUSH_TO_TALK"', body)
        self.assertIn(b'name="audio"; filename="answer.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFFdata\r\n', body)
        self.assertTrue(body.endswith(b'--b0undary--\r\n'))
        self.assertIn('bricks', KEYWORDS)

    def test_unknown_container_is_rejected_before_ffmpeg(self):
        with self.assertRaises(SpeechError) as caught:
            to_wav(b'data', 'audio/x-aiff')
        self.assertEqual(str(caught.exception), 'unsupported_audio')

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg converts browser recordings')
    def test_browser_recordings_become_16k_mono_wav(self):
        source = tone_wav(1000)
        webm = subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0',
                               '-c:a', 'libopus', '-f', 'webm', 'pipe:1'],
                              input=source, capture_output=True, check=True).stdout
        for raw, kind in ((source, 'audio/wav'), (webm, 'audio/webm')):
            with self.subTest(kind=kind), wave.open(io.BytesIO(to_wav(raw, kind))) as audio:
                self.assertEqual((audio.getnchannels(), audio.getframerate(), audio.getsampwidth()), (1, 16000, 2))
                self.assertAlmostEqual(audio.getnframes() / 16000, 1.0, delta=0.05)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg converts browser recordings')
    def test_broken_recording_is_unreadable(self):
        with self.assertRaises(SpeechError) as caught:
            to_wav(b'not really webm', 'audio/webm')
        self.assertEqual(str(caught.exception), 'audio_unreadable')


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg converts browser recordings')
class SpeechAPITests(unittest.TestCase):
    def serve(self, transcriber):
        app = SpeechPlayground(transcriber=transcriber)
        server = SpeechServer(('127.0.0.1', 0), app)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join()
            app.media.close()
        self.addCleanup(stop)
        return server

    def post(self, server, body, content_type='audio/wav', path='/api/transcribe'):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
        connection.request('POST', path, body, {'Content-Type': content_type})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_recording_returns_text_and_config_advertises_speech(self):
        fake = FakeTranscriber('Paper!')
        server = self.serve(fake)
        self.assertEqual(self.post(server, tone_wav(800), 'audio/wav; codecs=1'), (200, {'transcript': 'Paper!'}))
        self.assertEqual(duration_ms(fake.calls[0]), 800)
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        connection.request('GET', '/api/config')
        self.assertTrue(json.loads(connection.getresponse().read())['speechAvailable'])
        connection.close()

    def test_a_tap_without_speech_is_an_empty_answer_without_a_model_call(self):
        fake = FakeTranscriber()
        server = self.serve(fake)
        self.assertEqual(self.post(server, tone_wav(100)), (200, {'transcript': ''}))
        self.assertEqual(fake.calls, [])

    def test_bad_requests_and_service_errors_are_not_answers(self):
        cases = [
            (FakeTranscriber(), tone_wav(800), 'audio/x-aiff', 415, 'content_type'),
            (FakeTranscriber(), b'not audio', 'audio/webm', 400, 'audio_unreadable'),
            (None, tone_wav(800), 'audio/wav', 503, 'missing_api_key'),
            (FakeTranscriber(error='speech_http_error'), tone_wav(800), 'audio/wav', 502, 'speech_http_error'),
            (FakeTranscriber(error='speech_rate_limited'), tone_wav(800), 'audio/wav', 429, 'speech_rate_limited'),
        ]
        for transcriber, body, kind, status, code in cases:
            with self.subTest(code=code):
                server = self.serve(transcriber)
                got_status, data = self.post(server, body, kind)
                self.assertEqual((got_status, data['error']['code']), (status, code))
                self.assertNotIn('transcript', data)

    def test_oversized_recording_is_refused_before_reading(self):
        server = self.serve(FakeTranscriber())
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        connection.putrequest('POST', '/api/transcribe')
        connection.putheader('Content-Type', 'audio/webm')
        connection.putheader('Content-Length', str(MAX_AUDIO + 1))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual((response.status, json.loads(response.read())['error']['code']), (413, 'body_size'))
        connection.close()

    def test_story_and_media_routes_still_work_on_the_same_server(self):
        server = self.serve(FakeTranscriber())
        status, snapshot = self.post(server, b'{"mode":"mock"}', 'application/json', '/api/sessions')
        self.assertEqual(status, 200)
        body = json.dumps({'sessionId': snapshot['sessionId'], 'sceneId': snapshot['sceneId'],
                           'version': snapshot['version']}).encode()
        self.assertEqual(self.post(server, body, 'application/json', '/api/media/jobs'),
                         (200, {'status': 'no_new_media', 'jobId': None, 'apply': False}))


if __name__ == '__main__':
    unittest.main()
