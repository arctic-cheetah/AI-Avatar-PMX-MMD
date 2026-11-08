"""Endearments get their own, higher lift (#83): at 4 st "sweetheart!" still sounded a bit down;
of 4 / 6 / 8 st, 8 sounded best (listened 9 Nov 2026)."""
from pathlib import Path
import sys
import tempfile
import unittest

from controller.bridge import build_parser, speech_settings
from controller.speech import ApplioSettings, ApplioWorker, Segment, endearment_words
from test_contours import SPANS_WORKER, SynthesiseContourTests


class EndearmentWordTests(unittest.TestCase):
    def test_only_endearments_used_in_address(self):
        cases = {
            'Thank you, sweetheart!': (2,),
            'Hi honey, how are you?': (1,),
            'Good night, darling.': (2,),
            'We did it!': (),          # lifted, but not an endearment
            'I love it.': (),
            'Honey cake is nice.': (),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(endearment_words(text), expected)


class EndearmentBendTests(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, settings, lifts, endearments):
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER.replace(
                '"wordSpans": [[0.2, 0.5]]', '"wordSpans": [[0.2, 0.5], [0.6, 1.0]], "spanWords": [1, 2]'))
            command = [sys.executable, str(script)]
            worker = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'rvc.log')
            worker.kokoro = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'tts.log')
            try:
                return await worker.request('Thanks, sweetheart, we won!', Path('s.wav'), Path('o.wav'),
                                            lifts=lifts, endearments=endearments)
            finally:
                await worker.close()

    async def test_endearments_lift_higher_than_the_exclaimed_word(self):
        reply = await self.exchange(ApplioSettings(tts_provider='kokoro'), (1, 2), (1,))
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, 8.0], [0.6, 1.0, 4.0]])
        self.assertEqual(reply['lifts'], 2)

    async def test_bend_is_configurable(self):
        reply = await self.exchange(ApplioSettings(tts_provider='kokoro', endearment_bend=7.0), (1,), (1,))
        self.assertEqual(reply['request']['bend'], [[0.2, 0.5, 7.0]])


class SynthesiseEndearmentTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, text):
        return await SynthesiseContourTests.run_segment(self, settings, Segment(text, 'tender', 1.0))

    async def test_endearments_are_sent_with_their_lifts(self):
        sent, _ = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Thank you, sweetheart!')
        self.assertEqual((sent['lifts'], sent['endearments']), ((2,), (2,)))
        sent, _ = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'We did it!')
        self.assertNotIn('endearments', sent)

    async def test_a_question_rise_wins_over_the_endearment_lift(self):
        sent, _ = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Are you okay, honey?')
        self.assertEqual(sent['rises'], (3,))
        self.assertNotIn('endearments', sent)


class EndearmentSettingsTests(unittest.TestCase):
    def test_default_range_and_flag(self):
        self.assertEqual(ApplioSettings().endearment_bend, 8.0)
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), endearment_bend=value).check()
        settings = speech_settings(build_parser().parse_args(['--speech', '--endearment-bend', '7']))
        self.assertEqual(settings.endearment_bend, 7.0)
        self.assertEqual(speech_settings(build_parser().parse_args(['--speech'])).endearment_bend, 8.0)


if __name__ == '__main__':
    unittest.main()
