from functools import partial
import http.client
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

from controller.stt import MAX_UPLOAD, SttWorker, UploadError, check_upload
from controller.stt_worker import clean_transcript, serve, validate_settings

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('renderer_serve', ROOT / 'renderer' / 'serve.py')
renderer_serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer_serve)

ORIGIN = 'http://127.0.0.1:8770'

# Stands in for stt_worker.py: the transcript is the uploaded file's content.
FAKE_WORKER = r'''
import json, sys, time
print(json.dumps({"ready": True, "model": "fake"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    audio = open(request["audio"], "rb").read()
    if audio == b"crash":
        sys.exit(1)
    if audio == b"hang":
        time.sleep(30)
    if audio == b"fail":
        print(json.dumps({"id": request["id"], "ok": False, "error": "decoder said no"}), flush=True)
        continue
    print(json.dumps({"id": request["id"], "ok": True, "text": audio.decode(), "path": request["audio"]}), flush=True)
'''


def segment(text, no_speech=0.1, logprob=-0.2):
    return SimpleNamespace(text=text, no_speech_prob=no_speech, avg_logprob=logprob)


class TranscriptTests(unittest.TestCase):
    def test_joins_segments_and_collapses_whitespace(self):
        self.assertEqual(clean_transcript([segment(' Hello  there.'), segment(' How are you? ')]),
                         'Hello there. How are you?')

    def test_drops_silent_low_confidence_segments(self):
        self.assertEqual(clean_transcript([segment(' Hi.'), segment(' you', no_speech=0.9, logprob=-1.5)]), 'Hi.')

    def test_empty_punctuation_and_stock_hallucinations_are_ignored(self):
        for texts in ([], [' '], [' ...'], [' Thanks for watching!'], [' Please subscribe.']):
            self.assertEqual(clean_transcript([segment(text) for text in texts]), '', texts)

    def test_real_short_replies_are_kept(self):
        self.assertEqual(clean_transcript([segment(' Thank you.')]), 'Thank you.')

    def test_settings_are_validated(self):
        validate_settings('base.en', 4)
        with self.assertRaises(ValueError):
            validate_settings('large-v3', 4)
        with self.assertRaises(ValueError):
            validate_settings('base.en', 0)


class WorkerProtocolTests(unittest.TestCase):
    def test_bad_requests_and_failures_do_not_stop_the_worker(self):
        replies = []

        def transcribe(path):
            if path == 'bad.webm':
                raise ValueError('Invalid data')
            return {'text': 'hello'}

        lines = ['[]', 'junk', json.dumps({'id': 'a', 'audio': 'bad.webm'}),
                 json.dumps({'id': 'b', 'audio': 'good.webm'})]
        serve(lines, transcribe, replies.append)
        self.assertEqual([reply['ok'] for reply in replies], [False, False, False, True])
        self.assertEqual(replies[2]['id'], 'a')
        self.assertEqual(replies[3], {'id': 'b', 'ok': True, 'text': 'hello'})


class UploadCheckTests(unittest.TestCase):
    def headers(self, **changes):
        headers = {'Origin': ORIGIN, 'Content-Type': 'audio/webm;codecs=opus', 'Content-Length': '1000'}
        headers.update(changes)
        return {key: value for key, value in headers.items() if value is not None}

    def assertRejected(self, status, headers):
        with self.assertRaises(UploadError) as raised:
            check_upload(headers, ORIGIN)
        self.assertEqual(raised.exception.status, status)

    def test_accepts_browser_recording_formats(self):
        self.assertEqual(check_upload(self.headers(), ORIGIN), (1000, '.webm'))
        self.assertEqual(check_upload(self.headers(**{'Content-Type': 'audio/ogg;codecs=opus'}), ORIGIN)[1], '.ogg')
        self.assertEqual(check_upload(self.headers(**{'Content-Type': 'audio/mp4'}), ORIGIN)[1], '.m4a')

    def test_rejects_other_or_missing_origins(self):
        self.assertRejected(403, self.headers(Origin='http://evil.example'))
        self.assertRejected(403, self.headers(Origin='http://localhost:8770'))
        self.assertRejected(403, self.headers(Origin=None))

    def test_rejects_bad_type_and_size(self):
        self.assertRejected(415, self.headers(**{'Content-Type': 'text/plain'}))
        self.assertRejected(415, self.headers(**{'Content-Type': None}))
        self.assertRejected(411, self.headers(**{'Content-Length': None}))
        self.assertRejected(400, self.headers(**{'Content-Length': '0'}))
        self.assertRejected(413, self.headers(**{'Content-Length': str(MAX_UPLOAD + 1)}))


class SttWorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.work_dir = Path(self.directory.name)
        self.worker = SttWorker(command=[sys.executable, '-c', FAKE_WORKER], work_dir=self.work_dir, timeout=2)

    def tearDown(self):
        self.worker.close()
        self.directory.cleanup()

    def recordings(self):
        return [path for path in self.work_dir.iterdir() if path.name != 'stt-worker.log']

    def test_round_trip_deletes_the_recording(self):
        self.assertEqual(self.worker.start()['model'], 'fake')
        reply = self.worker.transcribe(b'hello there', '.webm')
        self.assertTrue(reply['ok'])
        self.assertEqual(reply['text'], 'hello there')
        self.assertTrue(reply['path'].endswith('.webm'))
        self.assertTrue(reply['path'].startswith(str(self.work_dir)))
        self.assertEqual(self.recordings(), [])

    def test_failure_reply_is_returned_and_worker_keeps_running(self):
        self.assertFalse(self.worker.transcribe(b'fail')['ok'])
        self.assertEqual(self.worker.transcribe(b'again')['text'], 'again')
        self.assertEqual(self.recordings(), [])

    def test_crash_raises_then_next_request_restarts(self):
        with self.assertRaises(RuntimeError):
            self.worker.transcribe(b'crash')
        self.assertEqual(self.worker.transcribe(b'back')['text'], 'back')
        self.assertEqual(self.recordings(), [])

    def test_timeout_kills_the_worker_and_recovers(self):
        self.worker.timeout = 0.5
        with self.assertRaises(RuntimeError):
            self.worker.transcribe(b'hang')
        self.worker.timeout = 2
        self.assertEqual(self.worker.transcribe(b'ok')['text'], 'ok')

    def test_worker_that_never_becomes_ready_raises(self):
        broken = SttWorker(command=[sys.executable, '-c', 'print("not json")'], work_dir=self.work_dir)
        with self.assertRaises(RuntimeError):
            broken.start()


class FakeStt:
    def __init__(self, reply=None, error=None):
        self.reply, self.error, self.calls = reply, error, []

    def transcribe(self, audio, suffix):
        self.calls.append((audio, suffix))
        if self.error:
            raise self.error
        return self.reply


class QuietHandler(renderer_serve.Handler):
    def log_message(self, *args):
        pass


class SttEndpointTests(unittest.TestCase):
    def serve_with(self, stt):
        handler = partial(QuietHandler, directory=str(ROOT))
        server = renderer_serve.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        server.origin, server.stt = ORIGIN, stt
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def post(self, port, body=b'opus', path='/stt', origin=ORIGIN, kind='audio/webm;codecs=opus'):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        headers = {'Content-Type': kind}
        if origin:
            headers['Origin'] = origin
        connection.request('POST', path, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_returns_only_the_transcript_fields(self):
        stt = FakeStt({'id': 'x', 'ok': True, 'text': 'Hello Yidhari', 'audioSeconds': 1.2,
                       'sttSeconds': 0.2, 'sttRtf': 0.17})
        status, body = self.post(self.serve_with(stt))
        self.assertEqual(status, 200)
        self.assertEqual(body, {'text': 'Hello Yidhari', 'audioSeconds': 1.2, 'sttSeconds': 0.2})
        self.assertEqual(stt.calls, [(b'opus', '.webm')])

    def test_cross_origin_upload_never_reaches_the_worker(self):
        stt = FakeStt({'ok': True, 'text': 'x'})
        port = self.serve_with(stt)
        self.assertEqual(self.post(port, origin='http://evil.example')[0], 403)
        self.assertEqual(self.post(port, origin=None)[0], 403)
        self.assertEqual(stt.calls, [])

    def test_failed_transcription_hides_details(self):
        status, body = self.post(self.serve_with(FakeStt({'ok': False, 'error': 'secret /home/path'})))
        self.assertEqual(status, 422)
        self.assertNotIn('/home', body['error'])

    def test_worker_down_is_503_and_server_keeps_serving(self):
        port = self.serve_with(FakeStt(error=RuntimeError('STT worker exited')))
        self.assertEqual(self.post(port)[0], 503)
        self.assertEqual(self.post(port)[0], 503)

    def test_stt_disabled_and_unknown_paths(self):
        port = self.serve_with(None)
        status, body = self.post(port)
        self.assertEqual(status, 503)
        self.assertIn('--stt', body['error'])
        self.assertEqual(self.post(self.serve_with(FakeStt()), path='/other')[0], 404)


if __name__ == '__main__':
    unittest.main()
