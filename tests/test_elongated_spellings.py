"""Elongated spellings (#83): "whaaat" was heard as "whyat".

espeak spells them letter by letter: whaaat → wˈæææt, sooo → sˈuːoʊ ("soo-oh"),
suuure → sˈuːjʊɹ, wellll → wˈɛləl. So the real word is spoken, and Kokoro draws it
out itself with per-token speed.

Review on #121: a hand-kept list of double-letter words misspelled sorrrry → sory,
so candidates (each run as 1, 2 or 3 letters) are checked against a lexicon.
"""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from controller.speech import (
    SYSTEM_WORDS, ApplioSettings, ApplioWorker, Segment, elongation_stretch, synthesise,
    unstretch_spellings,
)
from test_contours import SPANS_WORKER

# A small lexicon with the traps a real dictionary has: "col", "god", "to", "br", "pst".
WORDS = frozenset({
    'what', 'so', 'no', 'but', 'sure', 'please', 'cute', 'yes', 'hey', 'really', 'okay', 'well',
    'cool', 'col', 'good', 'god', 'too', 'to', 'see', 'soon', 'hello', 'mississippi', 'sorry',
    'yummy', 'happy', 'pretty', 'br', 'gr', 'pst', 'that', 'is', 'she', 'said', 'way', 'i',
})


def unstretch(text):
    return unstretch_spellings(text, WORDS)


class UnstretchTests(unittest.TestCase):
    def test_elongated_words_become_the_real_word(self):
        cases = {
            'whaaat': 'what', 'sooo': 'so', 'nooooo': 'no', 'buuut': 'but', 'suuure': 'sure',
            'pleeease': 'please', 'cuuute': 'cute', 'yesss': 'yes', 'heyyy': 'hey',
            'reaaally': 'really', 'okaaay': 'okay', 'wellll': 'well', 'hmmmm': 'hmm', 'mmmm': 'mmm',
            'coooool': 'cool', 'gooood': 'good', 'tooo': 'too', 'soo': 'so', 'whaat': 'what', 'noo': 'no',
            # From the review: a double letter the real word has is kept, every run is checked.
            'sorrrry': 'sorry', 'reallly': 'really', 'yummmy': 'yummy', 'happppy': 'happy',
            'prettty': 'pretty', 'whaaatt': 'what', 'pleeeasse': 'please',
        }
        for word, expected in cases.items():
            with self.subTest(word=word):
                self.assertEqual(unstretch(word)[0], expected)
                self.assertEqual([i for i, _ in unstretch(word)[1]], [0])

    def test_real_words_non_words_and_interjections_are_left_alone(self):
        for word in ('too', 'see', 'cool', 'good', 'soon', 'Hello', 'well', 'Aww', 'Awww', 'Ooh',
                     'ohhh', 'I', 'Mississippi', '1000', 'zzz', 'brrr', 'grrr', 'pssst',
                     'www.example.com', '@sooo', 'a/sooo', 'Haaland'):
            with self.subTest(word=word):
                self.assertEqual(unstretch(word), (word, ()))

    def test_case_punctuation_and_indices(self):
        self.assertEqual(unstretch('Whaaat?! That is sooo cute!')[0], 'What?! That is so cute!')
        self.assertEqual([i for i, _ in unstretch('Whaaat?! That is sooo cute!')[1]], [0, 3])
        self.assertEqual(unstretch('"Nooo," she said.')[0], '"No," she said.')
        self.assertEqual(unstretch('SOOO good')[0], 'SO good')
        self.assertEqual(unstretch('SOooo NOoo')[0], 'So No')  # mixed-case runs

    def test_reports_how_many_letters_were_written(self):
        self.assertEqual(unstretch('whaat whaaaaaat')[1], ((0, 2), (1, 7)))

    def test_stretch_follows_the_written_length_within_the_cap(self):
        # 5 frames (0.125 s) is the most one sound may take, so only shorter runs scale down.
        self.assertAlmostEqual(elongation_stretch(2, 0.125), 0.075)
        self.assertEqual((elongation_stretch(3, 0.125), elongation_stretch(9, 0.125)), (0.125, 0.125))
        self.assertEqual(elongation_stretch(3, 0.0), 0.0)

    @unittest.skipUnless(Path(SYSTEM_WORDS).is_file(), 'needs a system word list')
    def test_the_system_word_list(self):
        for word, expected in {'sorrrry': 'sorry', 'whaaat': 'what', 'coooool': 'cool',
                               'grrr': 'grrr', 'tooo': 'too'}.items():
            with self.subTest(word=word):
                self.assertEqual(unstretch_spellings(word)[0], expected)


class SynthesiseElongatedTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, text):
        captured = {}
        worker = Mock()
        worker.settings = settings

        async def prepare(text, source, output, run, prosody=None, **kwargs):
            captured.update(kwargs, text=text)
            source.touch()
            output.touch()
            return {'rvcSeconds': 0.3}

        worker.request = prepare
        with tempfile.TemporaryDirectory() as scratch, \
                patch('controller.speech.lexicon', return_value=WORDS), \
                patch('controller.speech.trim_clip', return_value={'beforeSeconds': 1}), \
                patch('controller.speech.apply_gain', return_value={'gainDb': 0.0}), \
                patch('controller.speech.align', return_value={'duration': 0.8, 'alignSeconds': 0.1}):
            await synthesise(Segment(text, 'surprised', 1.0), worker, directory=Path(scratch))
        return captured

    async def test_kokoro_speaks_the_real_word_and_stretches_it(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Whaaat? No way.')
        self.assertEqual((sent['text'], sent['elongated']), ('What? No way.', ((0, 0.125),)))
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Whaat? No way.')
        self.assertEqual(sent['elongated'], ((0, 0.075),))

    async def test_without_dynamic_emphasis_the_word_is_plain(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro', dynamic_emphasis=False),
                                      'Whaaat? No way.')
        self.assertEqual(sent['text'], 'What? No way.')
        self.assertNotIn('elongated', sent)

    async def test_edge_reads_spellings_itself(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='edge'), 'Whaaat?')
        self.assertEqual(sent['text'], 'Whaaat?')
        self.assertNotIn('elongated', sent)


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
                await worker.request('But it is so cute, so so cute.', Path('s.wav'), Path('o.wav'), **options)
            finally:
                await worker.close()
        return seen['tts']

    async def test_elongated_words_are_stretched_with_drawls(self):
        tts = await self.tts_fields(ApplioSettings(tts_provider='kokoro'), elongated=((3, 0.075), (0, 0.125)),
                                    drawls=(0,))
        self.assertEqual(tts['stretch'], [[0, 0.125], [3, 0.075]])  # a drawl keeps its own stretch

    async def test_drawls_come_first_when_the_line_is_busy(self):
        tts = await self.tts_fields(ApplioSettings(tts_provider='kokoro'), elongated=((6, 0.125),),
                                    drawls=(0, 1, 2, 3))
        self.assertEqual([index for index, _ in tts['stretch']], [0, 1, 2, 3])

    async def test_no_stretch_when_drawl_stretch_is_off(self):
        tts = await self.tts_fields(ApplioSettings(tts_provider='kokoro', drawl_stretch=0.0),
                                    elongated=((3, 0.125),))
        self.assertNotIn('stretch', tts)


if __name__ == '__main__':
    unittest.main()
