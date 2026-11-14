"""The word-delivery list (#83): each family of words says how it is delivered.

Voice work from here is small changes to particular words, so a family is a
row (words, moods, position, pitch bend, stretch) rather than new code.
"""
import unittest

from controller.speech import (
    ATTITUDE_WORDS, DELIVERIES, DRAWL_OPENERS, SKEPTICAL_MOODS, ApplioSettings, Delivery,
    delivered_words, drawl_words,
)


class DeliveryListTests(unittest.TestCase):
    def test_drawls_are_rows_of_the_list(self):
        drawls = [row for row in DELIVERIES if row.family == 'drawl']
        self.assertEqual({row.words for row in drawls}, {DRAWL_OPENERS, ATTITUDE_WORDS})
        opener = next(row for row in drawls if row.words == DRAWL_OPENERS)
        attitude = next(row for row in drawls if row.words == ATTITUDE_WORDS)
        self.assertEqual((opener.opener_only, opener.moods), (True, None))
        self.assertEqual((attitude.opener_only, attitude.moods), (False, SKEPTICAL_MOODS))
        for row in drawls:
            self.assertEqual((row.bend, row.stretch), ('drawl_bend', True))

    def test_every_row_names_a_bend_setting(self):
        settings = ApplioSettings()
        for row in DELIVERIES:
            with self.subTest(family=row.family):
                self.assertIsInstance(getattr(settings, row.bend), float)

    def test_delivered_words_match_words_moods_and_position(self):
        opener = next(row for row in DELIVERIES if row.words == DRAWL_OPENERS)
        self.assertEqual(delivered_words('But I like it.', 'neutral'), {0: opener})
        self.assertEqual(delivered_words('I like it, but no.', 'neutral'), {})
        found = delivered_words('Well, sure, totally.', 'skeptical')
        self.assertEqual(sorted(found), [0, 1, 2])
        self.assertEqual({row.family for row in found.values()}, {'drawl'})
        self.assertEqual(delivered_words('Sure, that works.', 'happy'), {})

    def test_first_matching_row_wins(self):
        rows = (Delivery('a', frozenset({'so'})), Delivery('b', frozenset({'so'})))
        self.assertEqual(delivered_words('So cute.', 'neutral', rows)[0].family, 'a')

    def test_drawl_words_are_unchanged(self):
        self.assertEqual(drawl_words('But I like it.', 'neutral'), (0,))
        self.assertEqual(drawl_words('Oh, really.', 'unimpressed'), (1,))
        self.assertEqual(drawl_words('That is *so* clever.', 'suspicious', emphasis=(2,)), (2,))
        self.assertEqual(drawl_words('That is *so* clever.', 'happy', emphasis=(2,)), ())


if __name__ == '__main__':
    unittest.main()
