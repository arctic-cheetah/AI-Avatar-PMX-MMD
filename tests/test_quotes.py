"""Quotations (#84 tier 5b): a pause before the quote and a slight pitch drop across it."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from controller.bridge import build_parser, speech_settings
from controller.speech import ApplioSettings, ApplioWorker, Segment, quote_words, synthesise
from test_contours import SPANS_WORKER


class QuoteWordTests(unittest.TestCase):
    def test_quoted_spans_as_spoken_word_ranges(self):
        cases = {
            'She said "I love it" today.': [(2, 4)],
            'He said “hi”.': [(2, 2)],
            '"Really?"': [(0, 0)],
            'Say "yes" or "no" now.': [(1, 1), (3, 3)],
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(quote_words(text), expected)

    def test_no_or_unbalanced_quotes(self):
        for text in ("Don't worry, it's fine.", 'Plain words.', 'An "open quote with no end.'):
            with self.subTest(text=text):
                self.assertEqual(quote_words(text), [])


QUOTE_SPANS = SPANS_WORKER.replace('"wordSpans": [[0.2, 0.5]]',
                                   '"wordSpans": [[0.4, 0.6], [0.9, 1.2]], "spanWords": [2, 4]')


class QuoteRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_dip_spans_the_whole_quote(self):
        settings = ApplioSettings(tts_provider='kokoro', quote_voice=True, quote_bend=-2.0)
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(QUOTE_SPANS)
            command = [sys.executable, str(script)]
            worker = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'rvc.log')
            worker.kokoro = ApplioWorker(settings, command=command, log_path=Path(scratch) / 'tts.log')
            try:
                reply = await worker.request('She said "I love it" today.', Path('s.wav'),
                                             Path('o.wav'), quotes=((2, 4),))
            finally:
                await worker.close()
        self.assertEqual(reply['request']['bend'], [[0.4, 1.2, -2.0, 0.5]])
        self.assertEqual(reply['quotes'], 1)


class SynthesiseQuoteTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, text):
        worker = Mock()
        worker.settings = settings
        sent = {}

        async def prepare(text, source, output, run, prosody=None, **options):
            sent.update(options)
            source.touch()
            output.touch()
            return {'rvcSeconds': 0.3, 'quotes': 1}

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch:
            with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}), \
                    patch('controller.speech.apply_gain', return_value={'gainDb': 0.0}), \
                    patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                _, metrics = await synthesise(Segment(text), worker, directory=Path(scratch))
        return sent, metrics

    async def test_quote_voice_sends_quote_and_a_pause_before_it(self):
        settings = ApplioSettings(tts_provider='kokoro', quote_voice=True, emphasis=False)
        sent, metrics = await self.run_segment(settings, 'She said "I love it" today.')
        self.assertEqual(sent['quotes'], ((2, 4),))
        self.assertEqual(sent['emphasis'], (2,))
        self.assertEqual(metrics['quotes'], 1)

    async def test_off_or_edge_sends_nothing(self):
        for settings in (ApplioSettings(tts_provider='kokoro', quote_voice=False, emphasis=False),
                         ApplioSettings(tts_provider='edge', quote_voice=True)):
            with self.subTest(provider=settings.tts_provider):
                sent, _ = await self.run_segment(settings, 'She said "I love it" today.')
                self.assertNotIn('quotes', sent)
                self.assertNotIn('emphasis', sent)

    def test_settings_and_flags(self):
        self.assertEqual((ApplioSettings().quote_voice, ApplioSettings().quote_bend), (False, -2.0))
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), quote_bend=value).check()
        settings = speech_settings(build_parser().parse_args(
            ['--speech', '--quote-voice', '--quote-bend', '-3']))
        self.assertEqual((settings.quote_voice, settings.quote_bend), (True, -3.0))
        plain = speech_settings(build_parser().parse_args(['--speech', '--quote-voice', '--plain-voice']))
        self.assertFalse(plain.quote_voice)


if __name__ == '__main__':
    unittest.main()
