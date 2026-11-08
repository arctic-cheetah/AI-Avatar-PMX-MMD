"""Surprise batch (#83): a surprised "what" / "really" rises and is drawn out ("whaaat", "reeeally")."""
from pathlib import Path
import sys
import tempfile
import unittest

from controller.bridge import build_parser, speech_settings
from controller.speech import DELIVERIES, ApplioSettings, ApplioWorker, Segment, delivered_words
from test_contours import SPANS_WORKER, SynthesiseContourTests


class SurpriseRowTests(unittest.TestCase):
    def test_surprise_row(self):
        row = next(row for row in DELIVERIES if row.family == 'surprise')
        self.assertTrue({'what', 'really', 'seriously', 'wow', 'whoa'} <= row.words)
        self.assertTrue({'surprised', 'shocked', 'gasp'} <= row.moods)
        self.assertEqual((row.bend, row.peak, row.stretch, row.opener_only), ('surprise_bend', 0.7, True, False))

    def test_only_in_surprised_moods(self):
        self.assertEqual(delivered_words('What, you did that?', 'surprised')[0].family, 'surprise')
        self.assertEqual(delivered_words('What, you did that?', 'neutral'), {})


class SynthesiseSurpriseTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, text, mood):
        sent, _ = await SynthesiseContourTests.run_segment(self, settings, Segment(text, mood, 1.0))
        return sent

    async def test_a_surprised_word_rises_and_is_stretched(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'What, you did that?', 'surprised')
        self.assertEqual(sent['delivered'], ((0, 5.0, 0.7, True),))
        self.assertNotIn('delivered', await self.run_segment(
            ApplioSettings(tts_provider='kokoro'), 'What, you did that?', 'neutral'))

    async def test_a_question_keeps_its_own_rise_and_is_only_stretched(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Really?', 'surprised')
        self.assertEqual(sent['rises'], (0,))
        self.assertEqual(sent['delivered'], ((0, None, None, True),))

    async def test_off_with_dynamic_emphasis(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro', dynamic_emphasis=False),
                                      'What, you did that?', 'surprised')
        self.assertNotIn('delivered', sent)


class SurpriseRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_bend_spans_and_stretch_reach_the_workers(self):
        settings = ApplioSettings(tts_provider='kokoro')
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER.replace('"wordSpans": [[0.2, 0.5]]',
                                                   '"wordSpans": [[0.2, 0.5]], "spanWords": [1]'))
            command = [sys.executable, str(script)]
            worker = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'rvc.log')
            worker.kokoro = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'tts.log')
            seen = {}
            original = worker.kokoro.request

            async def spy(*args, **kwargs):
                reply = await original(*args, **kwargs)
                seen['tts'] = reply['request']
                return reply

            worker.kokoro.request = spy
            try:
                reply = await worker.request('Oh, what happened?', Path('s.wav'), Path('o.wav'),
                                             delivered=((1, 5.0, 0.7, True),))
            finally:
                await worker.close()
        self.assertEqual((seen['tts']['spans'], seen['tts']['stretch']), ([1], [[1, 0.125]]))
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, 5.0, 0.7]])
        self.assertEqual(reply['delivered'], 1)


class SurpriseSettingsTests(unittest.TestCase):
    def test_default_range_and_flag(self):
        self.assertEqual(ApplioSettings().surprise_bend, 5.0)
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), surprise_bend=value).check()
        settings = speech_settings(build_parser().parse_args(['--speech', '--surprise-bend', '7']))
        self.assertEqual(settings.surprise_bend, 7.0)


if __name__ == '__main__':
    unittest.main()
