"""Elongated spellings (#83): "whaaat" was heard as "whyat".

espeak spells them letter by letter: whaaat → wˈæææt, sooo → sˈuːoʊ ("soo-oh"),
suuure → sˈuːjʊɹ, wellll → wˈɛləl. So the real word is spoken, and Kokoro draws it
out itself with per-token speed.
"""
from pathlib import Path
import sys
import tempfile
import unittest

from controller.speech import ApplioSettings, ApplioWorker, Segment, unstretch_spellings
from test_contours import SPANS_WORKER


class UnstretchTests(unittest.TestCase):
    def test_elongated_words_become_the_real_word(self):
        cases = {
            'whaaat': 'what', 'sooo': 'so', 'nooooo': 'no', 'buuut': 'but', 'suuure': 'sure',
            'pleeease': 'please', 'cuuute': 'cute', 'yesss': 'yes', 'heyyy': 'hey',
            'reaaally': 'really', 'okaaay': 'okay', 'wellll': 'well', 'hmmmm': 'hmm',
            'coooool': 'cool', 'gooood': 'good', 'tooo': 'too',
            # Two letters only where the shorter word is one that gets drawn out.
            'soo': 'so', 'whaat': 'what', 'noo': 'no',
        }
        for word, expected in cases.items():
            with self.subTest(word=word):
                self.assertEqual(unstretch_spellings(word), (expected, (0,)))

    def test_real_words_and_interjections_are_left_alone(self):
        for word in ('too', 'see', 'cool', 'good', 'soon', 'Hello', 'well', 'Aww', 'Awww', 'Ooh',
                     'ohhh', 'I', 'Mississippi', '1000', 'zzz'):
            with self.subTest(word=word):
                self.assertEqual(unstretch_spellings(word), (word, ()))

    def test_case_punctuation_and_indices(self):
        self.assertEqual(unstretch_spellings('Whaaat?! That is sooo cute!'),
                         ('What?! That is so cute!', (0, 3)))
        self.assertEqual(unstretch_spellings('"Nooo," she said.'), ('"No," she said.', (0,)))
        self.assertEqual(unstretch_spellings('SOOO good'), ('SO good', (0,)))


class SynthesiseElongatedTests(unittest.IsolatedAsyncioTestCase):
    async def test_kokoro_speaks_the_real_word_and_stretches_it(self):
        captured = {}

        async def run_segment(self_, settings, segment):
            from unittest.mock import Mock, patch
            from controller.speech import synthesise
            worker = Mock()
            worker.settings = settings

            async def prepare(text, source, output, run, prosody=None, **kwargs):
                captured.update(kwargs, text=text)
                source.touch()
                output.touch()
                return {'rvcSeconds': 0.3}

            worker.request = prepare
            with tempfile.TemporaryDirectory() as scratch:
                with patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}), \
                        patch('controller.speech.apply_gain', return_value={'gainDb': 0.0}), \
                        patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
                    await synthesise(segment, worker, directory=Path(scratch))
            return captured, {}

        for settings, elongated in ((ApplioSettings(tts_provider='kokoro'), (0,)),
                                    (ApplioSettings(tts_provider='kokoro', dynamic_emphasis=False), None)):
            captured.clear()
            await run_segment(self, settings, Segment('Whaaat? No way.', 'surprised', 1.0))
            with self.subTest(dynamic=settings.dynamic_emphasis):
                self.assertEqual(captured['text'], 'What? No way.')
                self.assertEqual(captured.get('elongated'), elongated)
        captured.clear()
        await run_segment(self, ApplioSettings(tts_provider='edge'), Segment('Whaaat?', 'surprised', 1.0))
        self.assertEqual(captured['text'], 'Whaaat?')  # Edge reads them itself
        self.assertNotIn('elongated', captured)


class ElongatedRequestTests(unittest.IsolatedAsyncioTestCase):
    async def tts_fields(self, settings, **options):
        with tempfile.TemporaryDirectory() as scratch:
            script = Path(scratch) / 'spans.py'
            script.write_text(SPANS_WORKER)
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
                await worker.request('But it is so cute.', Path('s.wav'), Path('o.wav'), **options)
            finally:
                await worker.close()
        return seen['tts']

    async def test_elongated_words_are_stretched_with_drawls(self):
        tts = await self.tts_fields(ApplioSettings(tts_provider='kokoro'), elongated=(3,), drawls=(0,))
        self.assertEqual(tts['stretch'], [[0, 0.125], [3, 0.125]])

    async def test_no_stretch_when_drawl_stretch_is_off(self):
        tts = await self.tts_fields(ApplioSettings(tts_provider='kokoro', drawl_stretch=0.0), elongated=(3,))
        self.assertNotIn('stretch', tts)


if __name__ == '__main__':
    unittest.main()
