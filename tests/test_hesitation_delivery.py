"""Hesitation row (#83): a thinking "hmmm" or "umm" is a hum, drawn out with a slight dip.

espeak spells some hums letter by letter: "Mmm" → ˌɛmˌɛmˈɛm ("em-em-em") and
"Hm" → ˌeɪtʃˈɛm ("aitch-em"). Its own "Hmm" (həm) is already the right sound
(listening, 14 Nov 2026), after `hmm`, `mmm` and `ˈʌm` respellings all sounded
off, so "Hm" is said like "Hmm" and mm/mmm as closed-lip m sounds. A questioning
"Hmm?" rises higher, all the way to its end, to sound like a question.
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
    def test_spelled_out_hums_are_fixed(self):
        cases = [
            ('Mmm, yummy.', 'ˌɛmˌɛmˈɛm, jˈʌmi.', 'mmm, jˈʌmi.'),
            ('Hm.', 'ˌeɪtʃˈɛm.', 'həm.'),  # said like espeak's own "Hmm"
            ('Hm?', 'ˌeɪtʃˈɛm?', 'həm?'),
            ('Mm.', 'ˌɛmˈɛm.', 'mm.'),
            ('"Hm," she said.', '“ˌeɪtʃˈɛm,” ʃiː sˈɛd.', '“həm,” ʃiː sˈɛd.'),
        ]
        for text, phonemes, expected in cases:
            with self.subTest(text=text):
                self.assertTrue(needs_respelling(text))
                self.assertEqual(respell_phonemes(text, phonemes), expected)

    def test_other_words_are_untouched(self):
        # Listening (14 Nov 2026): espeak's own "Hmm" (həm) is already the hmm sound; hmm, mmm
        # and ˈʌm respellings all sounded off, so it is left alone.
        for text, phonemes in (('Hmm, let me think.', 'həm, lˈɛt mˌiː θˈɪŋk.'), ('Well… hmm?', 'wˈɛl… həm?'),
                               ('Umm, okay.', 'ˈʌm, oʊkˈeɪ.'), ("I'm here.", 'aɪm hˈɪɹ.'),
                               ('Hmmmmm.', 'hˈəm.'),  # longer runs are shortened before Kokoro
                               ('Hmm, sweet.', 'həm')):  # word counts differ
            with self.subTest(text=text):
                self.assertEqual(respell_phonemes(text, phonemes), phonemes)
        self.assertFalse(needs_respelling('Hello there.'))
        self.assertFalse(needs_respelling('Hmm, let me think.'))

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
    def test_a_spelled_out_hum_is_fixed_without_other_options(self):
        synthesizer = test_contours.AwwPronunciationTests.synthesizer(self, 'ˌeɪtʃˈɛm.')
        synthesizer.synthesize('Hm.', 'out.wav')
        args, kwargs = synthesizer.model.create.call_args
        self.assertEqual((args[0], kwargs['is_phonemes']), ('həm.', True))


class HesitationRowTests(unittest.TestCase):
    def test_hesitation_row(self):
        row = next(row for row in DELIVERIES if row.family == 'hesitation')
        self.assertTrue({'hmm', 'hm', 'umm', 'um', 'uh', 'er', 'erm'} <= HESITATION_WORDS)
        self.assertNotIn('mmm', HESITATION_WORDS)  # "Mmm, yummy." is pleasure, not hesitation
        self.assertEqual((row.words, row.moods, row.bend, row.peak, row.stretch, row.opener_only),
                         (HESITATION_WORDS, None, 'hesitation_bend', None, True, False))
        self.assertEqual(row.question_bend, 'hesitation_question_bend')
        # Only the hesitation row has its own question rise; "Really?" keeps the usual one.
        self.assertEqual({r.family for r in DELIVERIES if r.question_bend}, {'hesitation'})

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

    async def test_a_questioning_hum_rises_higher_to_its_end(self):
        # Listening (14 Nov 2026): "Hmm?" with the usual rise (9 st, falling after 70 %) did not
        # sound like a question; it rises higher and keeps rising to the end.
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Hmm?')
        self.assertEqual(sent['delivered'], ((0, 12.0, 1.0, True),))
        self.assertNotIn('rises', sent)
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro', hesitation_question_bend=10.0),
                                      'Well… hmm?')
        self.assertEqual(sent['delivered'], ((1, 10.0, 1.0, True),))
        self.assertEqual(sent['drawls'], (0,))

    async def test_without_dynamic_emphasis_the_usual_question_rise(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro', dynamic_emphasis=False), 'Hmm?')
        self.assertEqual(sent['rises'], (0,))
        self.assertNotIn('delivered', sent)

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

    def test_question_bend_default_range_and_flag(self):
        self.assertEqual(ApplioSettings().hesitation_question_bend, 12.0)
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), hesitation_question_bend=value).check()
        settings = speech_settings(build_parser().parse_args(['--speech', '--hesitation-question-bend', '10']))
        self.assertEqual(settings.hesitation_question_bend, 10.0)


if __name__ == '__main__':
    unittest.main()
