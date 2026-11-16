"""Pronunciation table (#188): whole words espeak gets wrong, each with the phonemes chosen by listening.

"comparison" (15 Nov 2026): espeak's kəmpˈæɹɪsən has the vowel of "cat" and a 50 ms r, so
the r sounded cut short. Of five candidates, kəmpˈɛɹːɪsən ("care" vowel, length mark) was just right.
"""
import unittest

from controller.kokoro_worker import PRONUNCIATIONS, needs_respelling, respell_phonemes
import test_contours  # the module, not its TestCase class, so its tests do not run twice here


class PronunciationTableTests(unittest.TestCase):
    def test_listened_entries(self):
        self.assertEqual(PRONUNCIATIONS['comparison'], 'kəmpˈɛɹːɪsən')
        self.assertEqual(PRONUNCIATIONS['comparisons'], 'kəmpˈɛɹːɪsənz')
        for word, phonemes in PRONUNCIATIONS.items():
            with self.subTest(word=word):
                self.assertEqual(word, word.lower())
                self.assertTrue(phonemes and ' ' not in phonemes)

    def test_words_are_replaced_keeping_case_and_punctuation(self):
        cases = [
            ('A side-by-side comparison.', 'ɐ sˈaɪdbaɪsˈaɪd kəmpˈæɹɪsən.', 'ɐ sˈaɪdbaɪsˈaɪd kəmpˈɛɹːɪsən.'),
            ('Comparison?', 'kəmpˈæɹɪsən?', 'kəmpˈɛɹːɪsən?'),
            ('"Comparisons," she said.', '“kəmpˈæɹɪsənz,” ʃiː sˈɛd.', '“kəmpˈɛɹːɪsənz,” ʃiː sˈɛd.'),
        ]
        for text, phonemes, expected in cases:
            with self.subTest(text=text):
                self.assertTrue(needs_respelling(text))
                self.assertEqual(respell_phonemes(text, phonemes), expected)

    def test_only_for_american_voices(self):
        # The entries are American; British espeak has its own vowels.
        self.assertEqual(respell_phonemes('comparison', 'kəmpˈæɹɪsən', lang='en-gb'), 'kəmpˈæɹɪsən')
        self.assertFalse(needs_respelling('comparison', lang='en-gb'))

    def test_other_words_and_misaligned_text_are_untouched(self):
        self.assertFalse(needs_respelling('Let us compare them.'))
        self.assertEqual(respell_phonemes('comparison shopping', 'kəmpˈæɹɪsən'), 'kəmpˈæɹɪsən')


class SynthesizePronunciationTests(unittest.TestCase):
    def test_a_table_word_is_fixed_without_other_options(self):
        synthesizer = test_contours.AwwPronunciationTests.synthesizer(self, 'ɐ kəmpˈæɹɪsən.')
        synthesizer.synthesize('A comparison.', 'out.wav')
        args, kwargs = synthesizer.model.create.call_args
        self.assertEqual((args[0], kwargs['is_phonemes']), ('ɐ kəmpˈɛɹːɪsən.', True))

    def test_a_british_voice_keeps_espeak(self):
        synthesizer = test_contours.AwwPronunciationTests.synthesizer(self, 'ɐ kəmpˈæɹɪsən.')
        synthesizer.voice = 'bf_emma'
        synthesizer.synthesize('A comparison.', 'out.wav')
        args, kwargs = synthesizer.model.create.call_args
        self.assertEqual(args[0], 'A comparison.')
        self.assertNotIn('is_phonemes', kwargs)


if __name__ == '__main__':
    unittest.main()
