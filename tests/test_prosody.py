"""Mood-driven prosody (#29 tier 2): mood map, clamps and per-sentence protocol fields."""
import asyncio
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from controller.applio_worker import Pipeline, Worker
from controller.bridge import build_parser, load_catalog, speech_settings
from controller.kokoro_worker import Synthesizer, serve
from controller.prosody import MAX_PITCH, MAX_SPEED_CHANGE, Prosody, prosody_for
from controller.speech import ApplioSettings, ApplioWorker, Segment, synthesise


class MoodMapTests(unittest.TestCase):
    def assertProsody(self, actual, speed, clause_pause, pitch):
        self.assertAlmostEqual(actual.speed, speed, places=3)
        self.assertAlmostEqual(actual.clause_pause, clause_pause, places=3)
        self.assertEqual(actual.pitch, pitch)

    def test_calm_and_unknown_moods_are_unchanged(self):
        for mood in ('neutral', 'soft-smile', 'tender', 'not-a-mood', ''):
            with self.subTest(mood=mood):
                self.assertEqual(prosody_for(mood, 1.0), Prosody())

    def test_issue_starting_map_at_full_weight(self):
        self.assertProsody(prosody_for('excited', 1.0), 1.05, 0.7, 1)
        self.assertProsody(prosody_for('joyful', 1.0), 1.05, 0.7, 1)
        self.assertProsody(prosody_for('thinking', 1.0), 0.95, 1.4, 0)
        self.assertProsody(prosody_for('sad', 1.0), 0.92, 1.4, -1)
        self.assertProsody(prosody_for('sleepy', 1.0), 0.92, 1.4, -1)

    def test_weight_scales_towards_neutral(self):
        self.assertProsody(prosody_for('thinking', 0.5), 0.975, 1.2, 0)
        self.assertEqual(prosody_for('excited', 0.6).pitch, 1)
        self.assertEqual(prosody_for('excited', 0.4).pitch, 0)
        self.assertEqual(prosody_for('sad', 0.6).pitch, -1)

    def test_out_of_range_weights(self):
        self.assertEqual(prosody_for('excited', 7.0), prosody_for('excited', 1.0))
        for weight in (-1.0, 0.0, float('nan'), float('inf') * 0):
            with self.subTest(weight=weight):
                self.assertEqual(prosody_for('excited', weight), Prosody())
        self.assertEqual(prosody_for('excited', None), Prosody())

    def test_every_catalog_mood_stays_within_clamps(self):
        for mood in load_catalog():
            for weight in (0.3, 1.0):
                with self.subTest(mood=mood, weight=weight):
                    result = prosody_for(mood, weight)
                    self.assertLessEqual(abs(result.speed - 1), MAX_SPEED_CHANGE + 1e-9)
                    self.assertLessEqual(abs(result.pitch), MAX_PITCH)
                    self.assertIsInstance(result.pitch, int)
                    self.assertTrue(0.5 <= result.clause_pause <= 2.0)


ECHO_WORKER = """
import json, sys
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"id": request["id"], "ok": True, "rvcSeconds": 0, "ttsProvider": "kokoro",
                      "ttsSeconds": 0, "sourceSeconds": 1, "sampleRate": 24000, "ttsRtf": 0,
                      "request": request}), flush=True)
"""


class ProtocolFieldTests(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, settings, prosody):
        """Return the (kokoro request, RVC request) lines sent for one sentence."""
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'echo.py'
            script.write_text(ECHO_WORKER)
            command = [sys.executable, str(script)]
            worker = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'rvc.log')
            seen = {}
            kokoro = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'tts.log')
            original = kokoro.request

            async def spy(*args, **kwargs):
                reply = await original(*args, **kwargs)
                seen['kokoro'] = reply['request']
                return reply

            kokoro.request = spy
            worker.kokoro = kokoro
            try:
                reply = await worker.request('Hi.', Path('s.wav'), Path('o.wav'), 'run', prosody=prosody)
            finally:
                await worker.close()
        return seen['kokoro'], reply['request']

    async def test_prosody_reaches_kokoro_and_rvc(self):
        settings = ApplioSettings(tts_provider='kokoro', kokoro_speed=1.0, kokoro_clause_pause=0.25)
        tts, rvc = await self.exchange(settings, Prosody(1.05, 0.7, 1))
        self.assertAlmostEqual(tts['speed'], 1.05)
        self.assertAlmostEqual(tts['clause_pause'], 0.175)
        self.assertNotIn('pitch', tts)
        self.assertEqual(rvc['pitch'], 1)
        self.assertNotIn('speed', rvc)

    async def test_no_prosody_keeps_old_protocol(self):
        settings = ApplioSettings(tts_provider='kokoro')
        tts, rvc = await self.exchange(settings, None)
        for line in (tts, rvc):
            for field in ('speed', 'clause_pause', 'pitch'):
                self.assertNotIn(field, line)

    async def test_combined_values_stay_in_worker_ranges(self):
        settings = ApplioSettings(tts_provider='kokoro', kokoro_speed=1.95, kokoro_clause_pause=0.5)
        tts, _ = await self.exchange(settings, Prosody(1.08, 2.0, 0))
        self.assertEqual(tts['speed'], 2.0)
        self.assertEqual(tts['clause_pause'], 0.5)


class KokoroOverrideTests(unittest.IsolatedAsyncioTestCase):
    async def test_serve_forwards_only_supplied_fields(self):
        lines, calls, replies = asyncio.Queue(), [], []

        def synthesize(text, path, **options):
            calls.append((text, options))
            return {'ttsSeconds': 0.1}

        for line in (json.dumps({'id': 'a', 'text': 'a', 'source': 'a'}),
                     json.dumps({'id': 'b', 'text': 'b', 'source': 'b', 'speed': 0.9, 'clause_pause': 0.3}),
                     None):
            await lines.put(line)
        await serve(lines, synthesize, replies.append)
        self.assertEqual(calls, [('a', {}), ('b', {'speed': 0.9, 'clause_pause': 0.3})])
        self.assertTrue(all(reply['ok'] for reply in replies))

    def synthesizer(self):
        synthesizer = Synthesizer.__new__(Synthesizer)
        synthesizer.model = Mock()
        synthesizer.model.create.return_value = ([0.0] * 2400, 24000)
        synthesizer.soundfile = Mock()
        synthesizer.voice, synthesizer.style, synthesizer.speed = 'af_heart', object(), 1.0
        synthesizer.clause_pause = 0.25
        return synthesizer

    def test_synthesize_uses_per_sentence_overrides(self):
        synthesizer = self.synthesizer()
        synthesizer.synthesize('Hi, there.', 'out.wav', speed=0.92, clause_pause=0.35)
        kwargs = synthesizer.model.create.call_args.kwargs
        self.assertEqual((kwargs['speed'], kwargs['clause_pause']), (0.92, 0.35))
        synthesizer.synthesize('Hi, there.', 'out.wav')
        kwargs = synthesizer.model.create.call_args.kwargs
        self.assertEqual((kwargs['speed'], kwargs['clause_pause']), (1.0, 0.25))

    def test_synthesize_rejects_bad_overrides(self):
        synthesizer = self.synthesizer()
        for options in ({'speed': 3.0}, {'speed': float('nan')}, {'speed': '1'},
                        {'clause_pause': -0.1}, {'clause_pause': 0.6}, {'clause_pause': True}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                synthesizer.synthesize('Hi.', 'out.wav', **options)
        synthesizer.model.create.assert_not_called()


class RvcPitchTests(unittest.IsolatedAsyncioTestCase):
    async def test_pipeline_passes_valid_pitch_and_rejects_bad(self):
        converted, replies = [], []

        async def edge(text, path):
            return 0

        def convert(source, output, pitch=0, bends=()):
            converted.append((source, pitch))

        pipeline = Pipeline(edge, convert, replies.append)
        base = {'run': 'r', 'text': 't', 'output': 'o'}
        pipeline.submit({**base, 'id': 'plain', 'source': 'plain'})
        pipeline.submit({**base, 'id': 'up', 'source': 'up', 'pitch': 1})
        for bad in (3.5, 'x', True, 13, -13):
            pipeline.submit({**base, 'id': f'bad-{bad}', 'source': 'bad', 'pitch': bad})
        await pipeline.drain()
        self.assertEqual(converted, [('plain', 0), ('up', 1)])
        by_id = {reply['id']: reply for reply in replies}
        self.assertTrue(by_id['plain']['ok'] and by_id['up']['ok'])
        self.assertFalse(any(by_id[key]['ok'] for key in by_id if key.startswith('bad-')))

    def test_worker_adds_shift_to_configured_pitch(self):
        worker = Worker.__new__(Worker)
        worker.settings = {'pth': 'm.pth', 'index': 'm.index', 'pitch': 2, 'index_rate': 0.7,
                           'volume_envelope': 1, 'protect': 0.5, 'f0_method': 'rmvpe',
                           'embedder': 'contentvec', 'sid': 0}
        worker.converter = Mock()
        worker.convert('s.wav', 'o.wav', -1)
        self.assertEqual(worker.converter.convert_audio.call_args.kwargs['pitch'], 1)
        worker.convert('s.wav', 'o.wav')
        self.assertEqual(worker.converter.convert_audio.call_args.kwargs['pitch'], 2)


class SynthesiseProsodyTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, segment):
        worker = Mock()
        worker.settings = settings
        sent = {}

        async def prepare(text, source, output, run, prosody=None, **options):
            sent['prosody'] = prosody
            source.touch()
            output.touch()
            return {'rvcSeconds': 0.3}

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch:
            with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}), \
                    patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                _, metrics = await synthesise(segment, worker, directory=Path(scratch))
        return sent['prosody'], metrics

    async def test_enabled_mood_prosody_follows_segment(self):
        prosody, metrics = await self.run_segment(
            ApplioSettings(tts_provider='kokoro', mood_prosody=True, punctuation_cadence=False),
            Segment('Yay!', 'excited', 1.0))
        self.assertEqual(prosody, prosody_for('excited', 1.0))
        self.assertEqual(metrics['prosody'], {'speed': 1.05, 'clausePause': 0.7, 'pitch': 1})

    async def test_disabled_by_default(self):
        prosody, metrics = await self.run_segment(
            ApplioSettings(tts_provider='kokoro', mood_prosody=False, punctuation_cadence=False),
            Segment('Yay!', 'excited', 1.0))
        self.assertIsNone(prosody)
        self.assertNotIn('prosody', metrics)

    def test_bridge_flag(self):
        self.assertFalse(
            speech_settings(build_parser().parse_args(['--speech', '--no-mood-prosody'])).mood_prosody)
        self.assertTrue(
            speech_settings(build_parser().parse_args(['--speech', '--mood-prosody'])).mood_prosody)


if __name__ == '__main__':
    unittest.main()
