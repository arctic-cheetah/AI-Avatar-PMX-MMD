import asyncio
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from controller.applio_worker import Worker
from controller.kokoro_worker import Synthesizer, blend_style, parse_voice, serve, validate_settings
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

        async def prepare(text, source, output, run, prosody=None):
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

    async def test_configured_tails_reach_trim(self):
        worker = Mock()
        worker.settings = ApplioSettings(tts_provider='kokoro', sentence_tail=0.4, fragment_tail=0.05)

        async def prepare(text, source, output, run, prosody=None):
            source.touch()
            output.touch()
            return {'rvcSeconds': 0.3}

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch:
            with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}) as trim, \
                    patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                await synthesise(Segment('Hello'), worker, directory=Path(scratch))
        self.assertEqual(trim.call_args.args[2], 'Hello')
        self.assertEqual(trim.call_args.kwargs, {'sentence_tail': 0.4, 'fragment_tail': 0.05})

    def test_kokoro_command_carries_clause_pause_and_blend(self):
        worker = ApplioWorker(ApplioSettings(
            tts_provider='kokoro', kokoro_voice='af_heart:0.7,af_bella:0.3', kokoro_clause_pause=0.2))
        command = worker.kokoro.command
        self.assertEqual(command[command.index('--voice') + 1], 'af_heart:0.7,af_bella:0.3')
        self.assertEqual(command[command.index('--clause-pause') + 1], '0.2')

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

    def test_clause_pause_range(self):
        for pause in (-0.1, float('nan'), float('inf'), 0.51):
            with self.assertRaises(ValueError):
                validate_settings('af_heart', 1.0, 2, clause_pause=pause)
        for pause in (0.0, 0.1, 0.5):
            validate_settings('af_heart', 1.0, 2, clause_pause=pause)

    def test_invalid_blend_rejected_before_model_load(self):
        with self.assertRaises(ValueError):
            validate_settings('af_heart:0.5,bf_emma:0.5', 1.0, 2)


class VoiceBlendTests(unittest.TestCase):
    def test_single_voice_and_normalised_blend(self):
        self.assertEqual(parse_voice('af_heart'), [('af_heart', 1.0)])
        self.assertEqual(parse_voice('af_heart:0.7,af_bella:0.3'), [('af_heart', 0.7), ('af_bella', 0.3)])
        blend = parse_voice(' af_heart : 7 , af_bella:3 ')
        self.assertEqual([name for name, _ in blend], ['af_heart', 'af_bella'])
        self.assertAlmostEqual(blend[0][1], 0.7)
        self.assertAlmostEqual(blend[1][1], 0.3)

    def test_invalid_specs(self):
        for spec in ('', ' ', 'af_heart:0', 'af_heart:-1', 'af_heart:nan', 'af_heart:inf',
                     'af_heart:x', 'af_heart,af_heart', 'af_heart:0.5,bf_emma:0.5',
                     '--evil', 'jf_alpha', 'af_heart:', ',af_heart',
                     'af_a,af_b,af_c,af_d,af_e', None, 7):
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                parse_voice(spec)

    def test_blend_is_weighted_sum_of_styles(self):
        styles = {'af_heart': 10.0, 'af_bella': 20.0}
        self.assertAlmostEqual(blend_style([('af_heart', 0.7), ('af_bella', 0.3)], styles.__getitem__), 13.0)

    def test_synthesize_forwards_style_and_clause_pause(self):
        synthesizer = Synthesizer.__new__(Synthesizer)
        synthesizer.model = Mock()
        synthesizer.model.create.return_value = ([0.0] * 2400, 24000)
        synthesizer.soundfile = Mock()
        style = object()
        synthesizer.voice, synthesizer.style, synthesizer.speed = 'bf_emma', style, 1.1
        synthesizer.clause_pause = 0.3
        metrics = synthesizer.synthesize('Hello, there.', 'out.wav')
        kwargs = synthesizer.model.create.call_args.kwargs
        self.assertIs(kwargs['voice'], style)
        self.assertEqual((kwargs['speed'], kwargs['lang'], kwargs['clause_pause'], kwargs['trim']),
                         (1.1, 'en-gb', 0.3, False))
        self.assertEqual(metrics['sourceSeconds'], 0.1)


if __name__ == '__main__':
    unittest.main()
