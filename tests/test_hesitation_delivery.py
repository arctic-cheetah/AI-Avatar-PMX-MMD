"""Hesitation row (#83): a thinking "hmmm" or "umm" is a hum, drawn out with a slight dip.

espeak spells hums letter by letter or adds a vowel: "Hmm" → həm ("hum"),
"Mmm" → ˌɛmˌɛmˈɛm ("em-em-em"), "Hm" → ˌeɪtʃˈɛm ("aitch-em"). Spelled `hmm`, the h
made it sound like "camel" (listening, 14 Nov 2026), so every hum is said with
closed lips: the h becomes another m (hm → mm, hmm → mmm).
"""
from pathlib import Path
import unittest

from controller.bridge import build_parser, speech_settings
from controller.kokoro_worker import needs_respelling, respell_phonemes, stretch_sounds
from controller.speech import (
    DELIVERIES, HESITATION_WORDS, ApplioSettings, Segment, delivered_words, unstretch_spellings,
)
import test_contours  # the module, not its TestCase class, so its tests do not run twice here


class HumPhonemeTests(unittest.TestCase):
    def test_hums_are_spoken_as_their_letters(self):
        cases = [
            # Listening (14 Nov 2026): "hmm" with its h sounded like "camel"; a hum is closed-lip mmm.
            ('Hmm, let me think.', 'həm, lˈɛt mˌiː θˈɪŋk.', 'mmm, lˈɛt mˌiː θˈɪŋk.'),
            ('Mmm, yummy.', 'ˌɛmˌɛmˈɛm, jˈʌmi.', 'mmm, jˈʌmi.'),
            ('Hm.', 'ˌeɪtʃˈɛm.', 'mm.'),
            ('Mm.', 'ˌɛmˈɛm.', 'mm.'),
            ('Well… hmm?', 'wˈɛl… həm?', 'wˈɛl… mmm?'),
            ('"Hmm," she said.', '“həm,” ʃiː sˈɛd.', '“mmm,” ʃiː sˈɛd.'),
        ]
        for text, phonemes, expected in cases:
            with self.subTest(text=text):
                self.assertTrue(needs_respelling(text))
                self.assertEqual(respell_phonemes(text, phonemes), expected)

    def test_other_words_are_untouched(self):
        for text, phonemes in (('Umm, okay.', 'ˈʌm, oʊkˈeɪ.'), ("I'm here.", 'aɪm hˈɪɹ.'),
                               ('Hmmmmm.', 'hˈəm.'),  # longer runs are shortened before Kokoro
                               ('Hmm, sweet.', 'həm')):  # word counts differ
            with self.subTest(text=text):
                self.assertEqual(respell_phonemes(text, phonemes), phonemes)
        self.assertFalse(needs_respelling('Hello there.'))

    def test_a_hum_draws_out_its_m(self):
        # A word with no vowel draws out its hum (m or n); "psst" and "ʃ" still have nothing to draw out.
        cases = {'hmm,': [1, 2], 'hm.': [1], 'mmm': [0, 1, 2], 'psst,': [], 'ʃ': []}
        for word, positions in cases.items():
            with self.subTest(word=word):
                self.assertEqual(stretch_sounds(word), positions)

    def test_elongated_hums_become_hmm(self):
        self.assertEqual(unstretch_spellings('Hmmmmm, okay.')[0], 'Hmm, okay.')
        self.assertEqual(unstretch_spellings('Ummm, maybe.')[0], 'Umm, maybe.')


class SynthesizeHumTests(unittest.TestCase):
    def test_a_hum_is_spoken_as_its_letters_without_other_options(self):
        synthesizer = test_contours.AwwPronunciationTests.synthesizer(self, 'həm.')
        synthesizer.synthesize('Hmm.', 'out.wav')
        args, kwargs = synthesizer.model.create.call_args
        self.assertEqual((args[0], kwargs['is_phonemes']), ('mmm.', True))


class HesitationRowTests(unittest.TestCase):
    def test_hesitation_row(self):
        row = next(row for row in DELIVERIES if row.family == 'hesitation')
        self.assertTrue({'hmm', 'hm', 'umm', 'um', 'uh', 'er', 'erm'} <= HESITATION_WORDS)
        self.assertNotIn('mmm', HESITATION_WORDS)  # "Mmm, yummy." is pleasure, not hesitation
        self.assertEqual((row.words, row.moods, row.bend, row.peak, row.stretch, row.opener_only),
                         (HESITATION_WORDS, None, 'hesitation_bend', None, True, False))

    def test_in_any_mood_and_anywhere(self):
        for text, mood, index in (('Hmm, let me think.', 'thinking', 0), ('Um, I guess.', 'nervous', 0),
                                  ('Uh, okay.', 'neutral', 0), ('I, er, forgot.', 'embarrassed', 1),
                                  ('Erm, well.', 'shy', 0), ('Hm?', 'confused', 0)):
            with self.subTest(text=text):
                self.assertEqual(delivered_words(text, mood)[index].family, 'hesitation')
        self.assertEqual(delivered_words('Mmm, yummy.', 'happy'), {})

    def test_a_drawl_and_a_hesitation_in_one_line(self):
        found = delivered_words('Well, um, maybe.', 'neutral')
        self.assertEqual((found[0].family, found[1].family), ('drawl', 'hesitation'))


class SynthesiseHesitationTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, text, mood='thinking'):
        sent, _ = await test_contours.SynthesiseContourTests.run_segment(self, settings, Segment(text, mood, 1.0))
        return sent

    async def test_a_hum_dips_slightly_and_is_stretched(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Hmm, let me think.')
        self.assertEqual(sent['delivered'], ((0, -1.0, None, True),))

    async def test_an_elongated_hum_is_delivered_too(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Hmmmm, okay.')
        self.assertEqual(sent['delivered'], ((0, -1.0, None, True),))
        self.assertEqual(sent['elongated'], ((0, 0.125),))

    async def test_a_questioning_hum_keeps_the_question_rise(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Hmm?')
        self.assertEqual((sent['rises'], sent['delivered']), ((0,), ((0, None, None, True),)))

    async def test_bend_follows_the_setting(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro', hesitation_bend=-3.0), 'Um, sure.')
        self.assertEqual(sent['delivered'], ((0, -3.0, None, True),))

    async def test_off_with_dynamic_emphasis_or_plain_voice(self):
        self.assertNotIn('delivered', await self.run_segment(
            ApplioSettings(tts_provider='kokoro', dynamic_emphasis=False), 'Hmm, let me think.'))
        plain = speech_settings(build_parser().parse_args(['--speech', '--tts', 'kokoro', '--plain-voice']))
        self.assertNotIn('delivered', await self.run_segment(plain, 'Hmm, let me think.'))


class HesitationSettingsTests(unittest.TestCase):
    def test_default_range_and_flag(self):
        self.assertEqual(ApplioSettings().hesitation_bend, -1.0)
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), hesitation_bend=value).check()
        settings = speech_settings(build_parser().parse_args(['--speech', '--hesitation-bend', '-2']))
        self.assertEqual(settings.hesitation_bend, -2.0)


if __name__ == '__main__':
    unittest.main()
