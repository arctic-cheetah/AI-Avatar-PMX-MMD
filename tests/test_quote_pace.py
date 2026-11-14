"""Quotation pace (#83): a quotation is said at its own pace, with Kokoro per-token speed.

The pace multiplies the sentence's speed (the global pace, #92), so a quote is always
a little slower than the words around it, however fast she is talking.
"""
from pathlib import Path
import sys
import tempfile
import unittest

from controller.bridge import build_parser, speech_settings
from controller.kokoro_worker import PROSODY_FIELDS, pace_factors, validate_paces
from controller.speech import ApplioSettings, ApplioWorker
from test_contours import SPANS_WORKER
import test_per_token_speed  # the module, not its TestCase classes, so their tests do not run twice here
from test_per_token_speed import HAS_KOKORO, timed

PHONEMES = 'ʃiː sˈɛd aɪ lˈʌv ɪt.'  # She said I love it.


class PaceFactorTests(unittest.TestCase):
    def test_every_sound_of_the_quoted_words_gets_the_pace(self):
        factors = pace_factors(PHONEMES, [[2, 4, 0.9]])
        start = PHONEMES.index('aɪ')
        self.assertEqual(factors[:start], [1.0] * start)
        self.assertEqual(factors[start:], [0.9] * (len(PHONEMES) - start))

    def test_a_stretched_sound_keeps_its_own_factor(self):
        # Compounding would draw a sound out past the 5-frame limit.
        base = [1.0] * len(PHONEMES)
        vowel = PHONEMES.index('ʌ')
        base[vowel] = 0.25
        factors = pace_factors(PHONEMES, [[2, 4, 0.9]], base)
        self.assertEqual(factors[vowel], 0.25)
        self.assertEqual(factors[vowel - 1], 0.9)

    def test_words_past_the_end_are_ignored(self):
        self.assertEqual(pace_factors(PHONEMES, [[7, 9, 0.9]]), [1.0] * len(PHONEMES))
        factors = pace_factors(PHONEMES, [[4, 9, 0.8]])  # clipped to the last word
        self.assertEqual(factors[PHONEMES.index('ɪt'):], [0.8] * 3)

    def test_validation(self):
        validate_paces([[0, 2, 0.9], [4, 4, 1.5], [5, 6, 0.5]])
        for bad in ([[2, 1, 0.9]], [[0, 1, 0.49]], [[0, 1, 1.51]], [[0, 1, float('nan')]],
                    [[True, 1, 0.9]], [[0, 1]], 'x', [[0, 1, 0.9]] * 5, [[-1, 1, 0.9]]):
            with self.subTest(paces=bad), self.assertRaises(ValueError):
                validate_paces(bad)
        self.assertIn('paces', PROSODY_FIELDS)


class SynthesizePaceTests(unittest.TestCase):
    FRAMES = [1] * len(PHONEMES)

    def synthesizer(self, token_speeds):
        synthesizer = test_per_token_speed.SynthesizeStretchTests.synthesizer(self, token_speeds)
        synthesizer.model.tokenizer.phonemize.return_value = PHONEMES
        return synthesizer

    def test_a_second_pass_with_the_quote_paced(self):
        synthesizer = self.synthesizer(True)
        plans = []

        def create_timed(*args, **kwargs):
            plans.append(synthesizer.plan)
            timings = timed(PHONEMES, self.FRAMES)
            return [0.0] * int(timings[-1].end * 24000), 24000, timings

        synthesizer.model.create_timed.side_effect = create_timed
        metrics = synthesizer.synthesize('She said I love it.', 'out.wav', paces=[[2, 4, 0.9]])
        self.assertIsNone(plans[0])
        self.assertEqual(plans[1].factors, pace_factors(PHONEMES, [[2, 4, 0.9]]))
        self.assertIsNone(synthesizer.plan)
        self.assertEqual(metrics['paced'], 1)
        self.assertNotIn('paceSkipped', metrics)

    def test_stretch_and_pace_share_one_second_pass(self):
        synthesizer = self.synthesizer(True)
        plans = []

        def create_timed(*args, **kwargs):
            plans.append(synthesizer.plan)
            timings = timed(PHONEMES, self.FRAMES)
            return [0.0] * int(timings[-1].end * 24000), 24000, timings

        synthesizer.model.create_timed.side_effect = create_timed
        metrics = synthesizer.synthesize('She said I love it.', 'out.wav', paces=[[2, 4, 0.9]],
                                         stretch=[[3, 0.125]])
        self.assertEqual(len(plans), 2)
        vowel = PHONEMES.index('ʌ')
        self.assertAlmostEqual(plans[1].factors[vowel], 1 / 5)
        self.assertEqual(plans[1].factors[vowel - 1], 0.9)
        self.assertEqual((metrics['stretched'], metrics['paced']), (1, 1))

    def test_without_the_patched_model_it_says_why(self):
        synthesizer = self.synthesizer(False)
        synthesizer.model.create_timed.return_value = ([0.0] * 24000, 24000, timed(PHONEMES, self.FRAMES))
        metrics = synthesizer.synthesize('She said I love it.', 'out.wav', paces=[[2, 4, 0.9]])
        self.assertEqual(synthesizer.model.create_timed.call_count, 1)
        self.assertEqual((metrics['paced'], metrics['paceSkipped']), (0, 'no-model'))


class QuotePaceRequestTests(unittest.IsolatedAsyncioTestCase):
    async def exchange(self, settings, quotes=((2, 4),)):
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER.replace('"wordSpans": [[0.2, 0.5]]',
                                                   '"wordSpans": [[0.2, 0.3], [0.6, 0.9]], "paced": 1'))
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
                reply = await worker.request('She said "I love it" and smiled.', Path('s.wav'), Path('o.wav'),
                                             quotes=quotes)
            finally:
                await worker.close()
        return seen['tts'], reply

    async def test_quotes_are_paced_by_kokoro(self):
        tts, reply = await self.exchange(ApplioSettings(tts_provider='kokoro'))
        self.assertEqual(tts['paces'], [[2, 4, 0.8]])
        self.assertEqual(reply['paced'], 1)
        self.assertEqual(reply['quotes'], 1)  # the pitch dip is unchanged

    async def test_pace_one_sends_nothing(self):
        tts, reply = await self.exchange(ApplioSettings(tts_provider='kokoro', quote_pace=1.0))
        self.assertNotIn('paces', tts)
        self.assertEqual(reply['quotes'], 1)


class QuotePaceSettingsTests(unittest.TestCase):
    def test_default_range_and_flags(self):
        # Listening (14 Nov 2026): 0.8 was perfect, over 0.9 and 1.0.
        self.assertEqual(ApplioSettings().quote_pace, 0.8)
        for value in (0.49, 1.51, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), quote_pace=value).check()
        settings = speech_settings(build_parser().parse_args(['--speech', '--quote-pace', '0.8']))
        self.assertEqual(settings.quote_pace, 0.8)


@unittest.skipUnless(HAS_KOKORO and Path('models/kokoro/kokoro-v1.0-pertoken.onnx').is_file(),
                     'needs .venv-kokoro and the per-token model from setup')
class RealModelPaceTests(unittest.TestCase):
    def test_the_quote_is_slower_and_the_rest_is_not(self):
        from controller.kokoro_worker import Synthesizer
        synthesizer = Synthesizer()
        text = 'She said I love it and smiled.'
        with tempfile.TemporaryDirectory() as scratch:
            out = str(Path(scratch) / 'out.wav')
            plain = synthesizer.synthesize(text, out, spans=[0, 2, 4])
            paced = synthesizer.synthesize(text, out, spans=[0, 2, 4], paces=[[2, 4, 0.8]])
        self.assertEqual(paced['paced'], 1)
        quote = lambda m: m['wordSpans'][2][1] - m['wordSpans'][1][0]
        self.assertGreater(quote(paced), quote(plain) * 1.1)
        first = lambda m: m['wordSpans'][0][1] - m['wordSpans'][0][0]
        self.assertAlmostEqual(first(paced), first(plain), delta=0.05)


if __name__ == '__main__':
    unittest.main()
