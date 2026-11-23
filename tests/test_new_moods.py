"""Six new moods and the mood tables that shape their voice (#99)."""
import unittest

from controller.bridge import load_catalog
from controller.prosody import ENERGETIC, LOW, MOOD_GROUPS, Prosody, prosody_for
from controller.speech import AFFECTIONATE_MOODS, SKEPTICAL_MOODS, SURPRISED_MOODS

CATALOG = load_catalog()
NEW_MOODS = ("playful", "curious", "amused", "awed", "wistful", "proud")


class NewMoodTests(unittest.TestCase):
    def test_new_moods_are_in_the_catalog(self):
        for name in NEW_MOODS:
            with self.subTest(name=name):
                self.assertIn(name, CATALOG)
                self.assertTrue(CATALOG[name]["morphs"])

    def test_every_speech_mood_table_names_catalog_moods(self):
        # The bridge turns old names into new ones on the way in, so a table
        # entry such as "wtf-dude" never matches and its mood loses the delivery.
        tables = {"MOOD_GROUPS": set(MOOD_GROUPS), "SKEPTICAL_MOODS": SKEPTICAL_MOODS,
                  "SURPRISED_MOODS": SURPRISED_MOODS, "AFFECTIONATE_MOODS": AFFECTIONATE_MOODS}
        for table, moods in tables.items():
            with self.subTest(table=table):
                self.assertLessEqual(set(moods), set(CATALOG), table)

    def test_exasperated_keeps_the_surprise_delivery(self):
        self.assertIn("exasperated", SURPRISED_MOODS)

    def test_new_moods_join_their_voice_families(self):
        for name in ("playful", "amused", "proud"):
            with self.subTest(name=name):
                self.assertEqual(prosody_for(name, 1), prosody_for("happy", 1))
                self.assertIs(MOOD_GROUPS[name], ENERGETIC)
        self.assertIs(MOOD_GROUPS["wistful"], LOW)
        self.assertEqual(prosody_for("curious", 1), Prosody())
        self.assertIn("awed", SURPRISED_MOODS)
        self.assertIn("amused", AFFECTIONATE_MOODS)


if __name__ == "__main__":
    unittest.main()
