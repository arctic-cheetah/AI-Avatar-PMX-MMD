"""Affection row (#83): a fond "sooo cute" is said with a warm rise-fall and drawn out."""
from pathlib import Path
import unittest

from controller.bridge import build_parser, speech_settings
from controller.speech import (
    AFFECTION_INTENSIFIERS, AFFECTION_WORDS, AFFECTIONATE_MOODS, DELIVERIES, DRAWL_OPENERS,
    ApplioSettings, Delivery, Segment, delivered_words,
)
import test_contours  # the module, not its TestCase class, so its tests do not run twice here


def rows(family):
    return [row for row in DELIVERIES if row.family == family]


class AffectionRowTests(unittest.TestCase):
    def test_affection_rows(self):
        word_row = next(row for row in rows('affection') if row.words == AFFECTION_WORDS)
        intensifier = next(row for row in rows('affection') if row.words == AFFECTION_INTENSIFIERS)
        self.assertTrue({'cute', 'adorable', 'sweet', 'lovely'} <= AFFECTION_WORDS)
        self.assertTrue({'so', 'too'} <= AFFECTION_INTENSIFIERS)
        self.assertTrue({'tender', 'happy', 'joyful', 'soft-smile', 'lovestruck', 'shy'} <= AFFECTIONATE_MOODS)
        for row in (word_row, intensifier):
            with self.subTest(words=sorted(row.words)):
                self.assertEqual((row.moods, row.bend, row.peak, row.stretch, row.standalone),
                                 (AFFECTIONATE_MOODS, 'affection_bend', None, True, False))
        self.assertIsNone(word_row.before)
        self.assertEqual(intensifier.before, AFFECTION_WORDS)

    def test_endearments_keep_their_own_lift(self):
        # "sweetie", "precious" and "cutie" are endearments (#120), not affection words.
        self.assertFalse({'sweetie', 'precious', 'cutie', 'honey', 'darling'} & AFFECTION_WORDS)

    def test_only_in_affectionate_moods(self):
        self.assertEqual(delivered_words('That is cute.', 'tender')[2].family, 'affection')
        for mood in ('neutral', 'skeptical', 'angry', 'surprised'):
            with self.subTest(mood=mood):
                self.assertEqual(delivered_words('That is cute.', mood), {})

    def test_an_intensifier_only_before_an_affection_word(self):
        found = delivered_words('That is so cute!', 'happy')
        self.assertEqual({index: row.family for index, row in found.items()}, {2: 'affection', 3: 'affection'})
        self.assertEqual(delivered_words('You are too sweet.', 'shy')[2].family, 'affection')
        self.assertEqual(delivered_words('I did it so you could rest.', 'tender'), {})
        self.assertEqual(delivered_words('I am so tired.', 'tender'), {})

    def test_a_fond_so_is_not_a_drawl(self):
        # "So" opening a sentence is a drawl (deeper); a fond "So cute!" is not.
        found = delivered_words('So cute!', 'tender')
        self.assertEqual((found[0].family, found[1].family), ('affection', 'affection'))
        drawl = delivered_words('So, what now?', 'tender')[0]
        self.assertEqual((drawl.family, drawl.words), ('drawl', DRAWL_OPENERS))
        self.assertEqual(delivered_words('So cute!', 'neutral')[0].family, 'drawl')

    def test_before_is_generic(self):
        table = (Delivery('a', frozenset({'so'}), before=frozenset({'cute'})),)
        self.assertEqual(sorted(delivered_words('so cute', 'neutral', table)), [0])
        self.assertEqual(delivered_words('so cute', 'neutral', table)[0].family, 'a')
        self.assertEqual(delivered_words('so, cute', 'neutral', table), {0: table[0]})  # punctuation is not a word
        self.assertEqual(delivered_words('so very cute', 'neutral', table), {})
        self.assertEqual(delivered_words('it is so', 'neutral', table), {})  # nothing after it


class SynthesiseAffectionTests(unittest.IsolatedAsyncioTestCase):
    async def run_segment(self, settings, text, mood='tender'):
        sent, _ = await test_contours.SynthesiseContourTests.run_segment(self, settings, Segment(text, mood, 1.0))
        return sent

    async def test_fond_words_get_a_warm_rise_fall_and_are_stretched(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'That is so cute!')
        self.assertEqual(sent['delivered'], ((2, 3.0, None, True), (3, 3.0, None, True)))
        self.assertNotIn(3, sent.get('lifts', ()))  # one bend per word: the row's, not the ! lift

    async def test_an_elongated_so_is_spoken_as_so_and_delivered(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Sooo cute!')
        self.assertEqual(sent['delivered'], ((0, 3.0, None, True), (1, 3.0, None, True)))
        self.assertEqual(sent['elongated'], ((0, 0.125),))
        self.assertNotIn('drawls', sent)

    async def test_aww_keeps_its_own_contour(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'Aww, so cute!')
        self.assertEqual(sent['contours'], (0,))
        self.assertEqual([item[0] for item in sent['delivered']], [1, 2])

    async def test_an_addressed_endearment_keeps_its_lift(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro'), 'You are so sweet, sweetie!')
        self.assertEqual([item[0] for item in sent['delivered']], [2, 3])
        self.assertIn(4, sent['lifts'])
        self.assertEqual(sent['endearments'], (4,))

    async def test_bend_follows_the_setting(self):
        sent = await self.run_segment(ApplioSettings(tts_provider='kokoro', affection_bend=5.0), 'That is cute.')
        self.assertEqual(sent['delivered'], ((2, 5.0, None, True),))

    async def test_off_with_dynamic_emphasis_plain_voice_or_another_mood(self):
        self.assertNotIn('delivered', await self.run_segment(
            ApplioSettings(tts_provider='kokoro', dynamic_emphasis=False), 'That is so cute!'))
        plain = speech_settings(build_parser().parse_args(['--speech', '--tts', 'kokoro', '--plain-voice']))
        self.assertNotIn('delivered', await self.run_segment(plain, 'That is so cute!'))
        self.assertNotIn('delivered', await self.run_segment(
            ApplioSettings(tts_provider='kokoro'), 'That is so cute!', 'neutral'))


class AffectionSettingsTests(unittest.TestCase):
    def test_default_range_and_flags(self):
        self.assertEqual(ApplioSettings().affection_bend, 3.0)
        for value in (-12.1, 12.1, float('nan')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ApplioSettings(applio_dir=Path('/nonexistent'), affection_bend=value).check()
        settings = speech_settings(build_parser().parse_args(['--speech', '--affection-bend', '4']))
        self.assertEqual(settings.affection_bend, 4.0)


if __name__ == '__main__':
    unittest.main()
