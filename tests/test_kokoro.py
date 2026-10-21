import asyncio
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from controller.applio_worker import Worker
from controller.kokoro_worker import serve, validate_settings
from controller.speech import ApplioSettings, ApplioWorker, Segment, synthesise


def request(identity, run='active'):
    return json.dumps({'id': identity, 'run': run, 'text': identity, 'source': identity})


class KokoroProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_queued_synthesis_and_preserve_next_run(self):
        lines = asyncio.Queue()
        entered, release = threading.Event(), threading.Event()
        calls, replies = [], []

        def synthesize(text, path):
            calls.append(text)
            if text == 'first':
                entered.set()
                if not release.wait(3):
                    raise RuntimeError('Test timed out')
            return {'ttsSeconds': 0.1}

        server = asyncio.create_task(serve(lines, synthesize, replies.append))
        await lines.put(request('first'))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            await lines.put(request('cancelled'))
            await lines.put(json.dumps({'cancel': 'active'}))
            await lines.put(request('next', 'next-run'))
            await lines.put(None)
        finally:
            release.set()
            await asyncio.wait_for(server, 3)
        self.assertEqual(calls, ['first', 'next'])
        self.assertEqual([reply['id'] for reply in replies], ['first', 'cancelled', 'next'])
        self.assertTrue(replies[1]['cancelled'])

    async def test_failed_sentence_and_invalid_request_do_not_stop_worker(self):
        lines = asyncio.Queue()
        replies = []

        def synthesize(text, path):
            if text == 'bad':
                raise ValueError('Invalid source')
            return {'ttsSeconds': 0.1}

        for line in ('[]', request('bad'), request('good'), None):
            await lines.put(line)
        await serve(lines, synthesize, replies.append)
        self.assertFalse(replies[0]['ok'])
        self.assertFalse(replies[1]['ok'])
        self.assertTrue(replies[2]['ok'])


class KokoroIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_prepared_source_skips_edge(self):
        worker = Worker.__new__(Worker)
        worker.settings = {'tts_provider': 'kokoro'}
        with tempfile.TemporaryDirectory() as scratch:
            source = Path(scratch) / 'source.wav'
            source.touch()
            self.assertEqual(await worker.edge('Hello', str(source)), 0)
            with self.assertRaises(FileNotFoundError):
                await worker.edge('Hello', str(source.with_name('missing.wav')))

    async def test_kokoro_wav_and_metrics_reach_alignment(self):
        worker = Mock()
        worker.settings = ApplioSettings(tts_provider='kokoro')
        metrics = {'ttsProvider': 'kokoro', 'ttsSeconds': 0.2, 'sourceSeconds': 1,
                   'sampleRate': 24000, 'ttsRtf': 0.2, 'rvcSeconds': 0.3}

        async def prepare(text, source, output, run):
            self.assertEqual(source.suffix, '.wav')
            source.touch()
            output.touch()
            return metrics

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch:
            with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}), \
                    patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                clip, result = await synthesise(Segment('Hello'), worker, directory=Path(scratch))
            self.assertEqual(result['ttsProvider'], 'kokoro')
            self.assertNotIn('edgeSeconds', result)
            self.assertTrue((Path(scratch) / f'{clip}.visemes.json').is_file())
            self.assertFalse(list(Path(scratch).glob('*.src.*')))

    async def test_cancel_and_shutdown_reach_both_workers(self):
        worker = ApplioWorker(ApplioSettings(tts_provider='kokoro'))
        source = Mock()
        source.close = AsyncMock()
        worker.kokoro = source
        worker.cancel('old-run')
        source.cancel.assert_called_once_with('old-run')
        await worker.close()
        source.close.assert_awaited_once()


class KokoroSettingsTests(unittest.TestCase):
    def test_invalid_runtime_settings(self):
        for speed in (0.0, float('nan'), float('inf'), 2.1):
            with self.assertRaises(ValueError):
                validate_settings('af_heart', speed, 2)
        with self.assertRaises(ValueError):
            validate_settings('af_heart', 1.0, 0)


if __name__ == '__main__':
    unittest.main()
